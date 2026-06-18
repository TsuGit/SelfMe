import { homedir } from "node:os";

import type { EventBus } from "../app/event-bus.js";
import type { SessionRecord } from "../types/session.js";
import type { TerminalMessageBlock } from "./message-types.js";
import type { TerminalPanelController, TerminalPanelState } from "./panel-controller.js";
import { clearLine, hideCursor, showCursor } from "./screen.js";
import { fg, paint } from "./theme.js";
import { formatToolSummaryLine } from "./tool-message.js";

interface BottomAreaSnapshot {
  lineCount: number;
  cursorRow: number;
  cursorColumn: number;
}

interface RenderState {
  editorValue: string;
  editorCursor: number;
  approvals: TerminalMessageBlock[];
  notice?: {
    title: string;
    body: string;
    tone: "info" | "error";
  };
  liveAssistant?: TerminalMessageBlock;
  liveTool?: TerminalMessageBlock;
  workingFrame: number;
  workingTaskId?: string;
  activeTurnStartedAt?: number;
}

export class LinearTerminalRenderer {
  private readonly state: RenderState = {
    editorValue: "",
    editorCursor: 0,
    approvals: [],
    workingFrame: 0,
    workingTaskId: undefined,
    activeTurnStartedAt: undefined
  };
  private workingTimer?: NodeJS.Timeout;
  private bottomArea?: BottomAreaSnapshot;
  private hasCommittedHistory = false;
  private lastCommitted?: TerminalMessageBlock;
  private readonly taskToolSteps = new Map<string, number>();
  private readonly handleResize = () => {
    this.renderBottomArea();
  };

  constructor(
    private readonly input: {
      bus: EventBus;
      panel: TerminalPanelController;
      session: SessionRecord;
    }
  ) {}

  async start() {
    this.appendHistoryBlock({
      kind: "welcome",
      title: "",
      body: renderWelcomeLines(this.input.session).join("\n")
    });

    this.input.bus.on("runtime.busy.changed", (event) => {
      if (event.payload.active) {
        return;
      }

      if (!this.clearLiveRuntimeState()) {
        return;
      }

      this.renderBottomArea();
    });

    this.input.bus.on("editor.state.changed", (event) => {
      this.state.editorValue = String(event.payload.value ?? "");
      this.state.editorCursor = Number(event.payload.cursor ?? 0);

      if (this.state.notice && this.state.editorValue.trim().length > 0) {
        this.state.notice = undefined;
      }

      this.renderBottomArea();
    });

    this.input.bus.on("terminal.ui.state.changed", () => {
      this.renderBottomArea();
    });

    this.input.bus.on("user.message.submitted", (event) => {
      this.state.notice = undefined;
      this.state.activeTurnStartedAt = Date.now();
      this.state.editorValue = "";
      this.state.editorCursor = 0;
      if (event.taskId) {
        this.taskToolSteps.delete(event.taskId);
      }
      this.appendHistoryBlock({
        kind: "user",
        title: "",
        body: event.payload.content,
        taskId: event.taskId
      });
    });

    this.input.bus.on("system.message.appended", (event) => {
      if (isTransientSystemNotice(event.payload.title)) {
        this.state.notice = {
          title: event.payload.title,
          body: event.payload.content,
          tone: "info"
        };
        this.renderBottomArea();
        return;
      }

      this.appendHistoryBlock({
        kind: "system",
        title: event.payload.title,
        body: event.payload.content
      });
    });

    this.input.bus.on("assistant.stream.started", (event) => {
      this.state.liveAssistant = {
        kind: "assistant-working",
        title: "",
        taskId: event.taskId,
        body: this.renderWorkingLabel()
      };
      this.state.workingTaskId = event.taskId;
      this.state.notice = undefined;
      this.startWorkingAnimation();
      this.renderBottomArea();
    });

    this.input.bus.on("assistant.delta.received", (event) => {
      const liveAssistant = this.state.liveAssistant;
      const existingBody = liveAssistant && liveAssistant.taskId === event.taskId
        ? liveAssistant.body
        : "";
      const nextBody = liveAssistant?.kind === "assistant-working"
        ? event.payload.delta
        : `${existingBody}${event.payload.delta}`;

      this.state.liveAssistant = {
        kind: "assistant",
        title: "",
        taskId: event.taskId,
        body: nextBody
      };
      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      this.renderBottomArea();
    });

    this.input.bus.on("assistant.completed", (event) => {
      const liveAssistant = this.state.liveAssistant;

      if (liveAssistant && liveAssistant.taskId === event.taskId) {
        if (liveAssistant.kind === "assistant" && liveAssistant.body.trim().length > 0) {
          this.appendHistoryBlock(liveAssistant, false);
        }

        this.state.liveAssistant = undefined;
      }

      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      this.renderBottomArea();
    });

    this.input.bus.on("tool.execution.requested", (event) => {
      const stepIndex = this.nextToolStepIndex(event.taskId);
      this.state.liveTool = {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        stepIndex,
        body: createToolRunningMessage(event.payload.toolName, event.payload.input)
      };
      this.state.notice = undefined;
      this.renderBottomArea();
    });

    this.input.bus.on("tool.stdout.appended", (event) => {
      const liveTool = this.state.liveTool;
      const currentBody = liveTool && liveTool.taskId === event.taskId
        ? liveTool.body
        : "";

      this.state.liveTool = {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        stepIndex: liveTool?.stepIndex,
        body: appendToolOutput(currentBody, event.payload.toolName, event.payload.chunk)
      };
      this.renderBottomArea();
    });

    this.input.bus.on("tool.execution.completed", (event) => {
      const liveTool = this.state.liveTool;
      const currentBody = liveTool && liveTool.taskId === event.taskId
        ? liveTool.body
        : "";
      const completed = {
        kind: "tool" as const,
        title: "Tool",
        taskId: event.taskId,
        stepIndex: liveTool?.stepIndex,
        body: finalizeToolMessage(currentBody, event.payload.toolName, event.payload.summary, event.payload.rawOutput)
      };

      this.state.liveTool = undefined;
      this.appendHistoryBlock(completed, false);
      this.renderBottomArea();
    });

    this.input.bus.on("approval.requested", (event) => {
      this.state.approvals.push({
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
        approvalContext: {
          toolName: event.payload.toolName,
          reason: event.payload.reason,
          risk: event.payload.risk
        },
        actions: [
          {
            id: "approve",
            label: "Approve",
            command: `/approve ${event.payload.approvalId}`,
            style: "primary"
          },
          {
            id: "deny",
            label: "Deny",
            command: `/deny ${event.payload.approvalId}`,
            style: "danger"
          }
        ],
        body: ""
      });
      this.state.notice = undefined;
      this.renderBottomArea();
    });

    this.input.bus.on("approval.resolved", (event) => {
      const resolvedApproval = this.state.approvals.find((entry) => entry.approvalId === event.payload.approvalId);
      this.state.approvals = this.state.approvals.filter((entry) => entry.approvalId !== event.payload.approvalId);
      this.appendHistoryBlock({
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
        approvalContext: resolvedApproval?.approvalContext,
        body: createApprovalResolvedMessage(resolvedApproval, event.payload.approved)
      }, false);
      this.renderBottomArea();
    });

    this.input.bus.on("runtime.error.raised", (event) => {
      if (!event.taskId && isTransientRuntimeNotice(event.payload.message)) {
        this.state.notice = {
          title: "Error",
          body: event.payload.message,
          tone: "error"
        };
        this.renderBottomArea();
        return;
      }

      const liveTool = this.state.liveTool;
      const liveAssistant = this.state.liveAssistant;
      const previousBody = liveTool && liveTool.taskId === event.taskId
        ? liveTool.body
        : liveAssistant && liveAssistant.taskId === event.taskId
          ? liveAssistant.body
          : undefined;

      if (this.state.liveTool?.taskId === event.taskId) {
        this.state.liveTool = undefined;
      }

      if (this.state.liveAssistant?.taskId === event.taskId) {
        this.state.liveAssistant = undefined;
      }

      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      this.appendHistoryBlock({
        kind: "error",
        title: "Error",
        taskId: event.taskId,
        body: createTaskErrorMessage(previousBody, event.payload.message)
      }, false);
      this.renderBottomArea();
    });

    this.input.bus.on("task.state.changed", (event) => {
      if (event.payload.title !== "Respond to user input") {
        return;
      }

      if (
        event.payload.state !== "completed" &&
        event.payload.state !== "failed" &&
        event.payload.state !== "cancelled"
      ) {
        return;
      }

      const startedAt = this.state.activeTurnStartedAt;
      this.state.activeTurnStartedAt = undefined;

      if (!startedAt) {
        return;
      }

      const toolSteps = event.taskId
        ? (this.taskToolSteps.get(event.taskId) ?? 0)
        : 0;

      if (event.taskId) {
        this.taskToolSteps.delete(event.taskId);
      }

      this.appendHistoryBlock({
        kind: "divider",
        title: "",
        taskId: event.taskId,
        body: buildTurnSummaryLabel(event.payload.state, startedAt, toolSteps)
      }, false);
      this.renderBottomArea();
    });

    process.on("exit", () => {
      this.stopWorkingAnimation();
      this.clearBottomArea();
      process.stdout.write(showCursor());
      process.stdout.write("\n");
    });
    process.stdout.on("resize", this.handleResize);

    this.renderBottomArea();
  }

  hasInterruptibleVisualState() {
    return this.state.approvals.length > 0
      || this.state.liveTool !== undefined
      || this.state.liveAssistant !== undefined
      || this.state.workingTaskId !== undefined;
  }

  private appendHistoryBlock(message: TerminalMessageBlock, renderBottom = true) {
    this.clearBottomArea();

    const viewportWidth = process.stdout.columns ?? 80;
    const outputLines = renderHistoryBlock(message, viewportWidth);
    const separator = this.hasCommittedHistory
      ? shouldTightGroup(this.lastCommitted, message)
        ? ""
        : "\n"
      : "";

    process.stdout.write(hideCursor());
    process.stdout.write(`${separator}${outputLines.join("\n")}\n`);
    process.stdout.write(showCursor());

    this.hasCommittedHistory = true;
    this.lastCommitted = message;

    if (renderBottom) {
      this.renderBottomArea();
    }
  }

  private nextToolStepIndex(taskId?: string) {
    if (!taskId) {
      return undefined;
    }

    const next = (this.taskToolSteps.get(taskId) ?? 0) + 1;
    this.taskToolSteps.set(taskId, next);
    return next;
  }

  private renderBottomArea() {
    this.input.panel.sync(this.state.approvals, this.state.editorValue);
    const area = buildBottomArea({
      viewportWidth: process.stdout.columns ?? 80,
      promptValue: this.state.editorValue,
      promptCursor: this.state.editorCursor,
      panel: this.input.panel.getState(this.state.editorValue),
      notice: this.state.notice,
      liveBlocks: [this.state.liveTool, this.state.liveAssistant].filter(Boolean) as TerminalMessageBlock[],
      session: this.input.session,
      hasHistory: this.hasCommittedHistory
    });

    this.clearBottomArea();
    process.stdout.write(hideCursor());

    if (area.lines.length > 0) {
      process.stdout.write(area.lines.join("\n"));
      const up = area.lines.length - 1 - area.cursorRow;

      if (up > 0) {
        process.stdout.write(`\u001b[${up}A`);
      }

      process.stdout.write("\r");

      if (area.cursorColumn > 0) {
        process.stdout.write(`\u001b[${area.cursorColumn}C`);
      }

      this.bottomArea = {
        lineCount: area.lines.length,
        cursorRow: area.cursorRow,
        cursorColumn: area.cursorColumn
      };
    } else {
      this.bottomArea = undefined;
    }

    process.stdout.write(showCursor());
  }

  private clearBottomArea() {
    if (!this.bottomArea) {
      return;
    }

    process.stdout.write(hideCursor());
    const down = this.bottomArea.lineCount - 1 - this.bottomArea.cursorRow;

    if (down > 0) {
      process.stdout.write(`\u001b[${down}B`);
    }

    process.stdout.write("\r");

    for (let index = this.bottomArea.lineCount - 1; index >= 0; index -= 1) {
      process.stdout.write(clearLine());

      if (index > 0) {
        process.stdout.write("\u001b[1A\r");
      }
    }

    this.bottomArea = undefined;
    process.stdout.write(showCursor());
  }

  private startWorkingAnimation() {
    this.stopWorkingAnimation();
    this.state.workingFrame = 0;
    this.workingTimer = setInterval(() => {
      if (!this.state.liveAssistant || this.state.liveAssistant.kind !== "assistant-working") {
        this.stopWorkingAnimation();
        return;
      }

      this.state.workingFrame += 0.55;
      this.state.liveAssistant = {
        ...this.state.liveAssistant,
        body: this.renderWorkingLabel()
      };
      this.renderBottomArea();
    }, 60);
  }

  private stopWorkingAnimation() {
    if (!this.workingTimer) {
      return;
    }

    clearInterval(this.workingTimer);
    this.workingTimer = undefined;
  }

  private clearLiveRuntimeState() {
    const hadLiveState = this.hasInterruptibleVisualState();

    if (!hadLiveState) {
      return false;
    }

    this.stopWorkingAnimation();
    this.state.approvals = [];
    this.state.liveTool = undefined;
    this.state.liveAssistant = undefined;
    this.state.workingTaskId = undefined;
    return true;
  }

  private renderWorkingLabel() {
    const prefix = fg("accentPrimary", "•");
    const text = "Working";
    const beamWidth = 3;
    const cycleLength = text.length + beamWidth * 2;
    const beamCenter = (this.state.workingFrame % cycleLength) - beamWidth;
    let output = "";

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? "";
      const distance = Math.abs(index - beamCenter);

      if (distance < 0.32) {
        output += paint(char, { conceal: true });
        continue;
      }

      if (distance < 0.82) {
        output += fg("bgPanel", char);
        continue;
      }

      if (distance < 1.4) {
        output += fg("lineStrong", char);
        continue;
      }

      if (distance < 2.1) {
        output += fg("textMuted", char);
        continue;
      }

      output += fg("textSecondary", char);
    }

    const elapsed = formatElapsedDuration(this.state.activeTurnStartedAt);
    const suffix = `${ansiMetaMuted(" (")}${ansiMetaValue(elapsed)}${ansiMetaSeparator(" · ")}${ansiMetaMuted("Esc to stop")}${ansiMetaMuted(")")}`;

    return `${prefix}${ansiMetaMuted(" ")}${output}${suffix}`;
  }
}

function formatElapsedDuration(startedAt?: number) {
  if (!startedAt) {
    return "0s";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function buildBottomArea(input: {
  viewportWidth: number;
  promptValue: string;
  promptCursor: number;
  panel: TerminalPanelState;
  notice?: {
    title: string;
    body: string;
    tone: "info" | "error";
  };
  liveBlocks: TerminalMessageBlock[];
  session: SessionRecord;
  hasHistory: boolean;
}) {
  const lines: string[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;

  if (input.liveBlocks.length > 0) {
    lines.push("");
  }

  for (const [index, block] of input.liveBlocks.entries()) {
    if (index > 0) {
      lines.push("");
    }

    lines.push(...renderHistoryBlock(block, input.viewportWidth));
  }

  const prompt = renderPrompt({
    value: input.promptValue,
    cursor: input.promptCursor,
    viewportWidth: input.viewportWidth
  });
  if (lines.length > 0 || input.hasHistory) {
    lines.push("");
  }
  lines.push(renderComposerPadLine(input.viewportWidth));
  cursorRow = lines.length + prompt.cursorRow;
  cursorColumn = prompt.cursorColumn;
  lines.push(...prompt.lines);
  lines.push(renderComposerPadLine(input.viewportWidth));

  const footerLines = renderFooterLines({
    viewportWidth: input.viewportWidth,
    panel: input.panel,
    notice: input.notice,
    session: input.session
  });

  if (footerLines.length > 0) {
    lines.push(...footerLines);
  }

  return {
    lines,
    cursorRow,
    cursorColumn
  };
}

function renderHistoryBlock(message: TerminalMessageBlock, viewportWidth: number) {
  const contentWidth = Math.max(8, viewportWidth - 2);

  if (message.kind === "welcome") {
    return message.body.split("\n");
  }

  if (message.kind === "user") {
    const contentLines = message.body
      .split("\n")
      .flatMap((line, index) => wrapLine(line, Math.max(1, viewportWidth - 2))
        .map((segment, segmentIndex) => formatUserLine(
          segment,
          index === 0 && segmentIndex === 0 ? "› " : "  ",
          viewportWidth
        )));

    return [
      renderComposerPadLine(viewportWidth),
      ...contentLines,
      renderComposerPadLine(viewportWidth)
    ];
  }

  if (message.kind === "assistant") {
    return renderPrefixedBlock(message.body, contentWidth, "• ", "  ", ansiAssistantText);
  }

  if (message.kind === "assistant-working") {
    return renderPrefixedBlock(message.body, contentWidth, "", "  ", (text) => text);
  }

  if (message.kind === "tool") {
    return renderStructuredMetaBlock(message.body, contentWidth, "tool");
  }

  if (message.kind === "approval") {
    return renderStructuredMetaBlock(message.body, contentWidth, "approval");
  }

  if (message.kind === "error") {
    return renderStructuredMetaBlock(message.body, contentWidth, "error");
  }

  if (message.kind === "system") {
    const heading = message.title
      ? `${ansiMuted("· ")}${ansiSystemTitle(message.title.toLowerCase())}`
      : "";
    const body = renderPrefixedBlock(message.body, contentWidth, "· ", "  ", ansiSystemText);
    return [heading, ...body].filter(Boolean);
  }

  if (message.kind === "divider") {
    return [renderTurnDividerLine(message.body, viewportWidth)];
  }

  return renderPrefixedBlock(message.body, contentWidth, "", "", ansiSystemText);
}

function renderPrompt(input: {
  value: string;
  cursor: number;
  viewportWidth: number;
}) {
  const clampedCursor = Math.max(0, Math.min(input.cursor, input.value.length));
  const logicalLines = input.value.length > 0 ? input.value.split("\n") : [""];
  const physicalLines: string[] = [];
  let cursorRow = 0;
  let cursorColumn = 0;
  let consumed = 0;

  for (const logicalLine of logicalLines) {
    const contentWidth = Math.max(1, input.viewportWidth - 2);
    const wrapped = wrapLine(logicalLine, contentWidth);
    const wrappedOrBlank = wrapped.length > 0 ? wrapped : [""];

    for (const [segmentIndex, segment] of wrappedOrBlank.entries()) {
      const prefix = physicalLines.length === 0 ? "› " : "  ";
      physicalLines.push(`${ansiComposerPrefix(prefix)}${ansiComposerFill(padToDisplayWidth(segment || " ", contentWidth))}`);
    }

    const logicalEnd = consumed + logicalLine.length;

    if (clampedCursor >= consumed && clampedCursor <= logicalEnd) {
      const beforeCursor = logicalLine.slice(0, clampedCursor - consumed);
      const beforeWrapped = wrapLine(beforeCursor, contentWidth);
      const cursorSegmentCount = beforeWrapped.length > 0 ? beforeWrapped.length : 1;
      const lastSegment = beforeWrapped.at(-1) ?? "";
      cursorRow = physicalLines.length - (wrappedOrBlank.length - cursorSegmentCount) - 1;
      const lastPrefix = cursorRow === 0 ? "› " : "  ";
      cursorColumn = getDisplayWidth(lastPrefix) + getDisplayWidth(lastSegment);
    }

    consumed = logicalEnd + 1;
  }

  return {
    lines: physicalLines,
    cursorRow,
    cursorColumn
  };
}

function renderFooterLines(input: {
  viewportWidth: number;
  panel: TerminalPanelState;
  notice?: {
    title: string;
    body: string;
    tone: "info" | "error";
  };
  session: SessionRecord;
}) {
  if (input.panel.mode !== "idle") {
    return renderPanelFooter(input.panel, input.viewportWidth);
  }

  if (input.notice) {
    return renderNoticeFooter(input.notice, input.viewportWidth);
  }

  const model = input.session.model || "no-model";
  const directory = shortenHomePath(input.session.cwd ?? process.cwd());
  const text = `${ansiMetaValue(model)}${ansiMetaSeparator(" · ")}${ansiMetaMuted(directory)}`;

  return [truncateAnsiLine(text, input.viewportWidth)];
}

function renderPanelFooter(panel: TerminalPanelState, viewportWidth: number) {
  const lines: string[] = [];
  const header = [panel.title ? ansiPanelTitle(panel.title) : "", panel.subtitle ? ansiPanelSubtitle(panel.subtitle) : ""]
    .filter(Boolean)
    .join(ansiMetaSeparator(" · "));

  if (header) {
    lines.push(truncateAnsiLine(header, viewportWidth));
  }

  if (panel.description) {
    for (const line of panel.description.split("\n")) {
      lines.push(truncateAnsiLine(ansiPanelDescription(line), viewportWidth));
    }
  }

  const visibleOptions = panel.options;

  for (const [index, option] of visibleOptions.entries()) {
    const isSelected = index === panel.selectedIndex;
    const label = isSelected
      ? `${ansiPanelPointer("›")} ${ansiActionMenuItem(option.label, option.style)}${option.detail ? `  ${ansiPanelDetail(option.detail)}` : ""}`
      : `${ansiPanelMuted(" ")} ${ansiPanelOption(option.label, option.style)}${option.detail ? `  ${ansiPanelDetail(option.detail)}` : ""}`;
    lines.push(truncateAnsiLine(label, viewportWidth));
  }

  lines.push(truncateAnsiLine(
    `${ansiActionHint("↑↓")} ${ansiPanelHelp("select")}  ${ansiActionHint("Enter")} ${ansiPanelHelp(panel.confirmLabel ?? "confirm")}  ${ansiActionHint("Esc")} ${ansiPanelHelp("close")}`,
    viewportWidth
  ));

  return lines;
}

function renderNoticeFooter(
  notice: {
    title: string;
    body: string;
    tone: "info" | "error";
  },
  viewportWidth: number
) {
  const lines = wrapLine(
    notice.tone === "error" ? ansiNoticeErrorTitle(notice.title) : ansiNoticeTitle(notice.title),
    viewportWidth
  );

  for (const bodyLine of notice.body.split("\n")) {
    lines.push(...wrapLine(
      notice.tone === "error" ? ansiNoticeErrorBody(bodyLine) : ansiNoticeBody(bodyLine),
      viewportWidth
    ));
  }

  return lines;
}

function renderPrefixedBlock(
  body: string,
  width: number,
  firstPrefix: string,
  restPrefix: string,
  renderer: (text: string) => string
) {
  const output: string[] = [];
  let isFirstLine = true;

  for (const line of body.split("\n")) {
    const prefix = isFirstLine ? firstPrefix : restPrefix;
    const prefixWidth = Math.max(0, getDisplayWidth(prefix));
    const wrapped = wrapLine(line, Math.max(1, width - prefixWidth));
    const wrappedOrBlank = wrapped.length > 0 ? wrapped : [""];

    for (const [index, segment] of wrappedOrBlank.entries()) {
      const currentPrefix = isFirstLine && index === 0 ? firstPrefix : restPrefix;
      output.push(`${ansiMuted(currentPrefix)}${renderer(segment)}`);
    }

    isFirstLine = false;
  }

  return output;
}

function renderStructuredMetaBlock(
  body: string,
  width: number,
  tone: "tool" | "approval" | "error"
) {
  const lines = body.split("\n");
  const [headline = "", ...rest] = lines;
  const headlineRenderer = tone === "error"
    ? ansiErrorHeadline
    : (text: string) => text;
  const bodyRenderer = tone === "tool"
    ? ansiToolText
    : tone === "approval"
      ? ansiApprovalText
      : ansiErrorText;
  const bulletRenderer = tone === "tool"
    ? ansiToolBullet
    : tone === "approval"
      ? ansiApprovalBullet
      : tone === "error"
        ? ansiErrorBullet
        : ansiMuted;
  const wrappedHeadline = wrapLine(renderStructuredHeadline(headline, tone), width)
    .map((line, index) => `${index === 0 ? bulletRenderer("• ") : ansiMuted("  ")}${headlineRenderer(line)}`);
  const wrappedBody = rest.flatMap((line) => renderStructuredMetaBodyLine(line, width, tone, bodyRenderer));

  return [...wrappedHeadline, ...wrappedBody].filter(Boolean);
}

function renderStructuredHeadline(
  headline: string,
  tone: "tool" | "approval" | "error"
) {
  if (tone === "tool") {
    return renderToolHeadline(headline);
  }

  if (tone === "approval") {
    return renderApprovalHeadline(headline);
  }

  if (tone === "error") {
    return renderErrorHeadline(headline);
  }

  return headline;
}

function renderToolHeadline(headline: string) {
  const match = headline.match(/^([A-Z][A-Za-z]+)(\s+·\s+)([\s\S]+)$/);

  if (!match) {
    return headline;
  }

  const [, prefix = "", separator = "", rest = ""] = match;
  return `${paint(prefix, { fg: "accentPrimary", bold: true })}${ansiToolHeadline(separator)}${ansiToolHeadline(rest)}`;
}

function renderApprovalHeadline(headline: string) {
  const match = headline.match(/^(Approval)(\s+·\s+)(Approved|Denied)([\s\S]*)$/);

  if (!match) {
    return headline;
  }

  const [, prefix = "", separator = "", result = "", suffix = ""] = match;
  const resultColor = result === "Approved" ? "stateSuccess" : "stateError";

  return [
    paint(prefix, { fg: "accentWarm", bold: true }),
    ansiApprovalHeadline(separator),
    paint(result, { fg: resultColor, bold: true }),
    ansiApprovalHeadline(suffix)
  ].join("");
}

function renderErrorHeadline(headline: string) {
  const match = headline.match(/^([A-Z][A-Za-z]+)(\s+·\s+)(Failed)([\s\S]*)$/);

  if (!match) {
    return headline;
  }

  const [, prefix = "", separator = "", result = "", suffix = ""] = match;

  return [
    paint(prefix, { fg: "stateError", bold: true }),
    ansiErrorHeadline(separator),
    paint(result, { fg: "stateError", bold: true }),
    ansiErrorHeadline(suffix)
  ].join("");
}

function renderStructuredMetaBodyLine(
  line: string,
  width: number,
  tone: "tool" | "approval" | "error",
  renderer: (text: string) => string
) {
  if (tone === "tool") {
    const decoratedToolLine = renderToolMetaLine(line, renderer);

    if (decoratedToolLine) {
      const prefix = "  ";
      const wrapped = wrapLine(decoratedToolLine, Math.max(1, width - prefix.length));
      return wrapped.map((segment) => `${ansiMuted(prefix)}${segment}`);
    }
  }

  const isCodeLike = /^[ \t]*\d+[ \t]*\|/.test(line) || /^[ \t]*\.\.\./.test(line);
  const prefix = isCodeLike ? "    " : "  ";
  const wrapped = wrapLine(line, Math.max(1, width - prefix.length));

  return wrapped.map((segment) => `${ansiMuted(prefix)}${renderer(segment)}`);
}

function renderToolMetaLine(
  line: string,
  renderer: (text: string) => string
) {
  const targetMatch = line.match(/^(target)(\s+·\s+)([\s\S]+)$/i);

  if (targetMatch) {
    const [, label = "", separator = "", value = ""] = targetMatch;
    return `${paint(capitalizeWord(label), { fg: "accentSecondary", bold: true })}${ansiMuted(separator)}${renderer(value)}`;
  }

  const streamMatch = line.match(/^(stdout|stderr)(:\s*)([\s\S]*)$/i);

  if (streamMatch) {
    const [, label = "", separator = "", value = ""] = streamMatch;
    const labelColor = label.toLowerCase() === "stderr" ? "accentWarm" : "accentSecondary";
    return `${paint(capitalizeWord(label), { fg: labelColor, bold: true })}${ansiMuted(separator)}${renderer(value)}`;
  }

  return undefined;
}

function capitalizeWord(value: string) {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function wrapLine(line: string, width: number) {
  if (!line) {
    return [""];
  }

  const parts = splitAnsiAware(line);
  const output: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const part of parts) {
    if (part.type === "ansi") {
      current += part.value;
      continue;
    }

    for (const char of part.value) {
      const charWidth = getDisplayWidth(char);

      if (currentWidth > 0 && currentWidth + charWidth > width) {
        output.push(current);
        current = "";
        currentWidth = 0;
      }

      current += char;
      currentWidth += charWidth;
    }
  }

  if (current || output.length === 0) {
    output.push(current);
  }

  return output;
}

function splitAnsiAware(text: string) {
  const ansiPattern = /\u001b\[[0-9;]*m/g;
  const parts: Array<{ type: "text" | "ansi"; value: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(ansiPattern)) {
    const start = match.index ?? 0;

    if (start > lastIndex) {
      parts.push({
        type: "text",
        value: text.slice(lastIndex, start)
      });
    }

    parts.push({
      type: "ansi",
      value: match[0]
    });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      value: text.slice(lastIndex)
    });
  }

  return parts;
}

function getDisplayWidth(text: string) {
  let width = 0;

  for (const char of text) {
    width += getCharDisplayWidth(char);
  }

  return width;
}

function getCharDisplayWidth(char: string) {
  const codePoint = char.codePointAt(0);

  if (!codePoint) {
    return 0;
  }

  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }

  return 1;
}

function padToDisplayWidth(text: string, width: number) {
  return `${text}${" ".repeat(Math.max(0, width - getDisplayWidth(text)))}`;
}

function renderComposerPadLine(viewportWidth: number) {
  return ansiComposerFill(" ".repeat(Math.max(1, viewportWidth)));
}

function renderTurnDividerLine(label: string, viewportWidth: number) {
  if (!label) {
    return fg("lineStrong", "─".repeat(Math.max(2, viewportWidth)));
  }

  const text = ` ${label} `;
  const visibleWidth = Math.max(0, viewportWidth - getDisplayWidth(text));
  const leftWidth = Math.max(2, Math.floor(visibleWidth / 2));
  const rightWidth = Math.max(2, visibleWidth - leftWidth);

  return `${fg("lineStrong", "─".repeat(leftWidth))}${fg("textMuted", text)}${fg("lineStrong", "─".repeat(rightWidth))}`;
}

function truncateAnsiLine(text: string, viewportWidth: number) {
  const visibleWidth = getDisplayWidth(stripAnsi(text));

  if (visibleWidth <= viewportWidth) {
    return text;
  }

  const suffix = "...";
  const limit = Math.max(1, viewportWidth - suffix.length);
  let output = "";
  let currentWidth = 0;

  for (const part of splitAnsiAware(text)) {
    if (part.type === "ansi") {
      output += part.value;
      continue;
    }

    for (const char of part.value) {
      const charWidth = getDisplayWidth(char);

      if (currentWidth + charWidth > limit) {
        return `${output}${suffix}\u001b[0m`;
      }

      output += char;
      currentWidth += charWidth;
    }
  }

  return output;
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function shortenHomePath(path: string) {
  const home = homedir();

  if (path === home) {
    return "~";
  }

  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }

  return path;
}

function renderWelcomeLines(session: SessionRecord) {
  const logo = [
    fg("accentPrimary", "  ▟██▙"),
    fg("accentPrimary", "▗██████"),
    fg("accentPrimary", " ▝▘▝▘▝▘")
  ];

  return [
    `${logo[0]}   ${paint("SelfMe", { fg: "textPrimary", bold: true })} ${fg("textMuted", `v${session.version}`)}`,
    `${logo[1]}  ${fg("textMuted", session.model)}`,
    `${logo[2]}  ${fg("textMuted", shortenHomePath(session.cwd ?? process.cwd()))}`
  ];
}

function createToolRunningMessage(toolName: string, input?: unknown) {
  const target = renderToolTargetLine(toolName, input);
  const headline = formatToolSummaryLine(toolName, "running");
  return target ? `${headline}\n${target}` : headline;
}

function appendToolOutput(current: string, toolName: string, chunk: string) {
  const sanitizedChunk = sanitizeToolChunk(chunk);

  if (!sanitizedChunk) {
    return current || createToolRunningMessage(toolName);
  }

  return clipToolTranscript(`${current || createToolRunningMessage(toolName)}\n${sanitizedChunk}`.trimEnd());
}

function finalizeToolMessage(current: string, toolName: string, summary: string, rawOutput?: string) {
  const sanitizedOutput = sanitizeToolChunk(rawOutput ?? "");
  const meaningfulOutput = hasMeaningfulToolOutput(sanitizedOutput) ? sanitizedOutput : "";
  const lines = current ? current.split("\n").filter(Boolean) : [];
  const header = formatToolSummaryLine(toolName, summary);
  const hasStructuredOutput = /^(stdout:|stderr:)/m.test(meaningfulOutput);

  if (lines.length === 0) {
    return meaningfulOutput ? clipToolTranscript([header, meaningfulOutput].join("\n")) : header;
  }

  if (hasStructuredOutput) {
    return clipToolTranscript([header, meaningfulOutput].join("\n"));
  }

  const preserved = lines.slice(1).filter((line) =>
    !line.startsWith("target · ") &&
    !line.startsWith("command · ") &&
    !line.startsWith("path · ")
  );
  const next = [header, ...preserved].join("\n");

  if (meaningfulOutput && next === header) {
    return clipToolTranscript([header, meaningfulOutput].join("\n"));
  }

  if (!meaningfulOutput && preserved.length === 0) {
    return header;
  }

  return clipToolTranscript(next);
}

function renderToolTargetLine(toolName: string, input?: unknown) {
  if (toolName === "shell" && input && typeof input === "object" && "command" in input && typeof input.command === "string") {
    return `target · ${createToolPreview(input.command, 140)}`;
  }

  if ((toolName === "files" || toolName === "write" || toolName === "edit") && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
    const range = "startLine" in input && typeof input.startLine === "number"
      ? `:${input.startLine}${"endLine" in input && typeof input.endLine === "number" ? `-${input.endLine}` : ""}`
      : "";
    return `target · ${input.path}${range}`;
  }

  return "";
}

function createApprovalResolvedMessage(message: TerminalMessageBlock | undefined, approved: boolean) {
  const headline = `Approval · ${approved ? "Approved" : "Denied"}`;
  const reason = message?.approvalContext?.reason?.trim();

  if (!reason) {
    return headline;
  }

  return `${headline}\n${reason}`;
}

function createTaskErrorMessage(previousBody: string | undefined, message: string) {
  const headline = previousBody ? deriveTaskHeadline(previousBody) : "Error";
  const normalizedHeadline = capitalizeWord(headline);
  return [normalizedHeadline.endsWith("Failed") ? normalizedHeadline : `${normalizedHeadline} · Failed`, message].join("\n");
}

function sanitizeToolChunk(chunk: string) {
  return chunk
    .replace(/\r/g, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .trimEnd();
}

function clipToolTranscript(text: string, maxLines = 12, maxChars = 2400) {
  const lines = text.split("\n");
  const [header = "", ...bodyLines] = lines;
  const bodyBudget = Math.max(0, maxChars - header.length - 1);
  const clippedBody = clipToolBodyByChars(normalizeToolClipMarkers(bodyLines.join("\n")), bodyBudget);
  const normalizedLines = [header, ...clippedBody.split("\n").filter(Boolean)].filter(Boolean);

  if (normalizedLines.length <= maxLines) {
    return normalizedLines.join("\n");
  }

  const visibleBodyLines = normalizedLines.slice(1);
  const maxBodyLines = Math.max(1, maxLines - 1);
  const keepHeadLines = Math.min(4, Math.max(1, Math.floor((maxBodyLines - 1) / 2)));
  const keepTailLines = Math.max(0, maxBodyLines - keepHeadLines - 1);
  const omittedLineCount = Math.max(1, visibleBodyLines.length - keepHeadLines - keepTailLines);

  return [
    header,
    ...visibleBodyLines.slice(0, keepHeadLines),
    formatToolLineClipMarker(omittedLineCount),
    ...(keepTailLines > 0 ? visibleBodyLines.slice(-keepTailLines) : [])
  ].filter(Boolean).join("\n");
}

function clipToolBodyByChars(body: string, maxChars: number) {
  if (!body || body.length <= maxChars) {
    return body;
  }

  const marker = "\n... output clipped ...\n";
  const budgetWithoutMarker = Math.max(0, maxChars - marker.length);

  if (budgetWithoutMarker <= 0) {
    return marker.trim();
  }

  const headBudget = Math.max(1, Math.floor(budgetWithoutMarker * 0.58));
  const tailBudget = Math.max(1, budgetWithoutMarker - headBudget);
  const head = trimToolClipHead(body.slice(0, headBudget));
  const tail = trimToolClipTail(body.slice(-tailBudget));

  return `${head}${marker}${tail}`;
}

function normalizeToolClipMarkers(text: string) {
  return text.replace(/^\.\.\.truncated\.\.\.$/gim, "... output truncated ...");
}

function formatToolLineClipMarker(omittedLineCount: number) {
  return `... ${omittedLineCount} ${omittedLineCount === 1 ? "line" : "lines"} omitted ...`;
}

function trimToolClipHead(text: string) {
  const trimmed = text.trimEnd();
  const lastNewline = trimmed.lastIndexOf("\n");

  if (lastNewline > 0) {
    return trimmed.slice(0, lastNewline).trimEnd() || trimmed;
  }

  return trimmed;
}

function trimToolClipTail(text: string) {
  const trimmed = text.trimStart();
  const firstNewline = trimmed.indexOf("\n");

  if (firstNewline >= 0 && firstNewline < trimmed.length - 1) {
    return trimmed.slice(firstNewline + 1).trimStart() || trimmed;
  }

  return trimmed;
}

function hasMeaningfulToolOutput(text: string) {
  return text.split("\n").map((line) => line.trim()).some(Boolean);
}

function createToolPreview(content: string, maxLength: number) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function deriveTaskHeadline(body: string) {
  const [firstLine] = body.split("\n").filter(Boolean);

  if (!firstLine) {
    return "task";
  }

  return firstLine
    .replace(/\s*·\s*timed out$/i, "")
    .replace(/\s*·\s*cancelled$/i, "")
    .replace(/\s*·\s*truncated$/i, "")
    .replace(/\s*·\s*timed out\s*·\s*truncated$/i, "")
    .replace(/\s*·\s*cancelled\s*·\s*truncated$/i, "")
    .replace(/\s*·\s*running$/i, "")
    .replace(/\s*·\s*completed$/i, "")
    .replace(/\s*·\s*Shell command completed$/i, "")
    .replace(/\s*·\s*Shell command failed\s*\(\d+\)$/i, "")
    .trim();
}

function buildTurnSummaryLabel(state: "completed" | "failed" | "cancelled", startedAt: number, toolSteps = 0) {
  const elapsedSeconds = getElapsedSeconds(startedAt);
  const duration = formatElapsedDuration(startedAt);
  const stepLabel = toolSteps > 0 ? `${toolSteps} ${toolSteps === 1 ? "step" : "steps"}` : "";

  if (state === "failed") {
    return joinSummaryParts(`Failed after ${duration}`, stepLabel);
  }

  if (state === "cancelled") {
    return joinSummaryParts(`Stopped after ${duration}`, stepLabel);
  }

  if (elapsedSeconds < 5) {
    return stepLabel;
  }

  return joinSummaryParts(`Done in ${duration}`, stepLabel);
}

function getElapsedSeconds(startedAt?: number) {
  if (!startedAt) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function joinSummaryParts(...parts: string[]) {
  return parts.filter(Boolean).join(" · ");
}

function shouldTightGroup(previous: TerminalMessageBlock | undefined, next: TerminalMessageBlock) {
  if (!previous?.taskId || !next.taskId || previous.taskId !== next.taskId) {
    return false;
  }

  if (previous.kind === "approval" || next.kind === "approval") {
    return false;
  }

  if (previous.kind === "user") {
    return isTaskFlowKind(next.kind);
  }

  if (previous.kind === "assistant" || next.kind === "assistant") {
    return false;
  }

  return isTaskFlowKind(previous.kind) && isTaskFlowKind(next.kind);
}

function isTaskFlowKind(kind: TerminalMessageBlock["kind"]) {
  return kind === "assistant" ||
    kind === "assistant-working" ||
    kind === "tool" ||
    kind === "approval" ||
    kind === "error";
}

function isTransientSystemNotice(title: string) {
  return title === "Help" || title === "Busy" || title === "Stopped";
}

function isTransientRuntimeNotice(message: string) {
  return message.startsWith("Unknown command:") ||
    message.startsWith("Unknown approval id:") ||
    message.startsWith("Command requires ") ||
    message.startsWith("Command does not take ") ||
    message.startsWith("Invalid /");
}

function ansiComposerPrefix(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
}

function ansiComposerFill(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
}

function formatUserLine(text: string, prefix: string, viewportWidth: number) {
  const contentWidth = Math.max(1, viewportWidth - getDisplayWidth(prefix));
  const padded = padToDisplayWidth(text || " ", contentWidth);

  return `${paint(prefix, { bg: "bgSubtle", fg: "textMuted" })}${paint(padded, { bg: "bgSubtle", fg: "textSecondary" })}`;
}

function ansiMuted(text: string) {
  return fg("textMuted", text);
}

function ansiAssistantText(text: string) {
  return fg("textPrimary", text);
}

function ansiToolText(text: string) {
  return fg("textSecondary", text);
}

function ansiToolHeadline(text: string) {
  return fg("textPrimary", text);
}

function ansiToolBullet(text: string) {
  return paint(text, { fg: "accentPrimary", bold: true });
}

function ansiApprovalText(text: string) {
  return fg("accentWarm", text);
}

function ansiApprovalHeadline(text: string) {
  return fg("textPrimary", text);
}

function ansiApprovalBullet(text: string) {
  return paint(text, { fg: "accentWarm", bold: true });
}

function ansiErrorText(text: string) {
  return fg("stateError", text);
}

function ansiErrorHeadline(text: string) {
  return fg("stateError", text);
}

function ansiErrorBullet(text: string) {
  return paint(text, { fg: "stateError", bold: true });
}

function ansiSystemText(text: string) {
  return fg("textSecondary", text);
}

function ansiSystemTitle(text: string) {
  return fg("textMuted", text);
}

function ansiMetaValue(text: string) {
  return fg("textSecondary", text);
}

function ansiMetaMuted(text: string) {
  return fg("textMuted", text);
}

function ansiMetaSeparator(text: string) {
  return fg("textMuted", text);
}

function ansiPanelTitle(text: string) {
  return fg("textPrimary", text);
}

function ansiPanelSubtitle(text: string) {
  return fg("textMuted", text);
}

function ansiPanelDescription(text: string) {
  return fg("textSecondary", text);
}

function ansiPanelQuery(text: string) {
  return fg("textSecondary", text);
}

function ansiPanelPointer(text: string) {
  return fg("accentPrimary", text);
}

function ansiPanelMuted(text: string) {
  return fg("textMuted", text);
}

function ansiPanelOption(text: string, style?: "primary" | "secondary" | "danger") {
  if (style === "danger") {
    return fg("stateError", text);
  }

  if (style === "primary") {
    return fg("accentWarm", text);
  }

  return fg("textSecondary", text);
}

function ansiPanelDetail(text: string) {
  return fg("textMuted", text);
}

function ansiPanelHelp(text: string) {
  return fg("textMuted", text);
}

function ansiActionHint(text: string) {
  return fg("textMuted", text);
}

function ansiActionMenuItem(text: string, style?: "primary" | "secondary" | "danger") {
  const bgCode = style === "danger"
    ? "stateError"
    : style === "primary"
      ? "accentWarm"
      : "textSecondary";

  return paint(` ${text} `, { fg: "bgBase", bg: bgCode, bold: true });
}

function ansiNoticeTitle(text: string) {
  return paint(text, { fg: "textPrimary", bold: true });
}

function ansiNoticeBody(text: string) {
  return fg("textSecondary", text);
}

function ansiNoticeErrorTitle(text: string) {
  return paint(text, { fg: "stateError", bold: true });
}

function ansiNoticeErrorBody(text: string) {
  return fg("stateError", text);
}
