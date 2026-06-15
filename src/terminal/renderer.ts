import type { EventBus } from "../app/event-bus.js";
import { homedir } from "node:os";
import type { TerminalPanelController, TerminalPanelState } from "./panel-controller.js";
import { clearLine, hideCursor, moveCursorTo, readCursorPosition, showCursor } from "./screen.js";
import { renderTerminalLayout, type TerminalMessageBlock } from "./layout.js";
import type { SessionRecord } from "../types/session.js";
import { fg, paint } from "./theme.js";

interface RenderState {
  editorValue: string;
  editorCursor: number;
  messages: TerminalMessageBlock[];
  messageViewportOffset: number;
  workingFrame: number;
  workingTaskId?: string;
  notice?: {
    title: string;
    body: string;
    tone: "info" | "error";
  };
}

export class TerminalRenderer {
  private anchorRow = 0;
  private renderedLineCount = 0;

  private state: RenderState = {
    editorValue: "",
    editorCursor: 0,
    messages: [],
    messageViewportOffset: 0,
    workingFrame: 0,
    workingTaskId: undefined,
    notice: undefined
  };
  private workingTimer?: NodeJS.Timeout;

  constructor(
    private readonly input: {
      bus: EventBus;
      panel: TerminalPanelController;
      session: SessionRecord;
    }
  ) {}

  async start() {
    const cursorPosition = await readCursorPosition();
    this.anchorRow = cursorPosition.row;
    const logo = renderWelcomeLogo();
    const welcomeLines = [
      `${logo[0]}   ${ansiBright("SelfMe")} ${ansiDim(`v${this.input.session.version}`)}`,
      `${logo[1]}  ${ansiDim(this.input.session.model)}`,
      `${logo[2]}  ${ansiDim(shortenHomePath(this.input.session.cwd ?? process.cwd()))}`
    ];

    this.state.messages.push({
      kind: "welcome",
      title: "",
      body: welcomeLines.join("\n")
    });

    this.syncActions();

    this.input.bus.on("editor.state.changed", (event) => {
      this.state.editorValue = String(event.payload.value ?? "");
      this.state.editorCursor = Number(event.payload.cursor ?? 0);

      if (this.state.notice && this.state.editorValue.trim().length > 0) {
        this.state.notice = undefined;
      }

      this.render();
    });

    this.input.bus.on("terminal.ui.state.changed", () => {
      this.render();
    });

    this.input.bus.on("user.message.submitted", (event) => {
      const userMessage: TerminalMessageBlock = {
        kind: "user",
        title: "",
        body: event.payload.content
      };

      const last = this.state.messages.at(-1);

      if (last?.kind === "assistant-working") {
        this.state.messages.splice(this.state.messages.length - 1, 0, userMessage);
      } else {
        this.state.messages.push(userMessage);
      }

      this.state.messageViewportOffset = 0;
      this.state.editorValue = "";
      this.state.editorCursor = 0;
      this.state.notice = undefined;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("system.message.appended", (event) => {
      if (isTransientSystemNotice(event.payload.title)) {
        this.state.notice = {
          title: event.payload.title,
          body: event.payload.content,
          tone: "info"
        };
        this.render();
        return;
      }

      const nextMessage: TerminalMessageBlock = {
        kind: "system",
        title: event.payload.title,
        body: event.payload.content
      };

      if (shouldUpsertSystemMessage(event.payload.title)) {
        upsertSystemMessageByTitle(this.state.messages, nextMessage);
      } else {
        this.state.messages.push(nextMessage);
      }

      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("assistant.stream.started", (event) => {
      const workingMessage: TerminalMessageBlock = {
        kind: "assistant-working",
        title: "",
        taskId: event.taskId,
        body: this.renderWorkingLabel()
      };
      upsertMessageByTaskId(this.state.messages, event.taskId, workingMessage);

      this.state.messageViewportOffset = 0;
      this.state.workingTaskId = event.taskId;
      this.state.notice = undefined;
      this.syncActions();
      this.startWorkingAnimation();
      this.render();
    });

    this.input.bus.on("assistant.delta.received", (event) => {
      const existing = findMessageByTaskId(this.state.messages, event.taskId);
      const body = existing?.kind === "assistant" || existing?.kind === "assistant-working"
        ? `${existing.kind === "assistant-working" ? "" : existing.body}${event.payload.delta}`
        : event.payload.delta;
      upsertMessageByTaskId(this.state.messages, event.taskId, {
        kind: "assistant",
        title: "",
        taskId: event.taskId,
        body
      });

      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("assistant.completed", (event) => {
      const existing = findMessageByTaskId(this.state.messages, event.taskId);

      if (existing?.kind === "assistant-working") {
        removeMessageByTaskId(this.state.messages, event.taskId);
      }

      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("tool.execution.requested", (event) => {
      const nextMessage: TerminalMessageBlock = {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body: createToolRunningMessage(event.payload.toolName, event.payload.input)
      };
      upsertMessageByTaskId(this.state.messages, event.taskId, nextMessage);
      this.state.messageViewportOffset = 0;
      this.state.notice = undefined;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("tool.stdout.appended", (event) => {
      const existing = findMessageByTaskId(this.state.messages, event.taskId);
      const nextBody = appendToolOutput(existing?.kind === "tool" ? existing.body : "", event.payload.toolName, event.payload.chunk);

      upsertMessageByTaskId(this.state.messages, event.taskId, {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body: nextBody
      });

      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("tool.execution.completed", (event) => {
      const existing = findMessageByTaskId(this.state.messages, event.taskId);
      const completedBody = finalizeToolMessage(
        existing?.kind === "tool" ? existing.body : "",
        event.payload.toolName,
        event.payload.summary,
        event.payload.rawOutput
      );

      upsertMessageByTaskId(this.state.messages, event.taskId, {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body: completedBody
      });

      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("approval.requested", (event) => {
      const nextMessage: TerminalMessageBlock = {
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
      };
      this.state.messages.push(nextMessage);
      this.state.messageViewportOffset = 0;
      this.state.notice = undefined;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("approval.resolved", (event) => {
      const updated = upsertMessageByApprovalId(this.state.messages, event.payload.approvalId, {
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
        approvalContext: undefined,
        actions: [],
        body: createApprovalResolvedMessage(event.payload.approvalId, event.payload.approved)
      });

      if (!updated) {
        return;
      }

      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("runtime.error.raised", (event) => {
      if (!event.taskId && isTransientRuntimeNotice(event.payload.message)) {
        this.state.notice = {
          title: "Error",
          body: event.payload.message,
          tone: "error"
        };
        this.render();
        return;
      }

      this.stopWorkingAnimation();
      this.state.workingTaskId = undefined;
      const existing = findMessageByTaskId(this.state.messages, event.taskId);
      upsertMessageByTaskId(this.state.messages, event.taskId, {
        kind: "error",
        title: "Error",
        taskId: event.taskId,
        body: createTaskErrorMessage(existing?.body, event.payload.message)
      });
      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("message.viewport.changed", (event) => {
      this.state.messageViewportOffset = Math.max(0, this.state.messageViewportOffset + event.payload.offset);
      this.render();
    });

    process.on("exit", () => {
      this.stopWorkingAnimation();
      process.stdout.write(showCursor());
    });

    process.stdout.write("\n");
    this.anchorRow += 1;
    this.render();
  }

  private render() {
    const prompt = this.renderPrompt();
    const footerLines = this.renderFooterLines(process.stdout.columns ?? 80);
    const layout = renderTerminalLayout({
      messages: this.state.messages,
      promptLines: prompt.lines,
      footerLines,
      promptCursorRow: prompt.cursorRow,
      viewportHeight: process.stdout.rows ?? 24,
      viewportWidth: process.stdout.columns ?? 80,
      messageViewportOffset: this.state.messageViewportOffset
    });
    const lines = layout.content.split("\n");
    const linesToClear = Math.max(this.renderedLineCount, lines.length);
    const terminalRows = process.stdout.rows ?? 24;
    const overflow = Math.max(0, this.anchorRow + lines.length - terminalRows);

    if (overflow > 0) {
      process.stdout.write(moveCursorTo(terminalRows - 1, 0));
      process.stdout.write("\n".repeat(overflow));
      this.anchorRow = Math.max(0, this.anchorRow - overflow);
    }

    process.stdout.write(hideCursor());
    for (let row = 0; row < linesToClear; row += 1) {
      process.stdout.write(moveCursorTo(this.anchorRow + row, 0));
      process.stdout.write(clearLine());
      if (row < lines.length) {
        process.stdout.write(lines[row] ?? "");
      }
    }
    process.stdout.write(moveCursorTo(this.anchorRow + layout.inputRow + prompt.cursorRow, prompt.cursorColumn));
    process.stdout.write(showCursor());
    this.renderedLineCount = lines.length;
  }

  private syncActions() {
    this.input.panel.sync(this.state.messages, this.state.editorValue);
  }

  private renderPrompt() {
    const clampedCursor = Math.max(0, Math.min(this.state.editorCursor, this.state.editorValue.length));
    const value = this.state.editorValue;
    const lines = value.length > 0 ? value.split("\n") : [""];
    const viewportWidth = process.stdout.columns ?? 80;
    const promptLines = lines.map((line, index) => {
      const prefix = index === 0 ? "› " : "  ";
      const contentWidth = Math.max(1, viewportWidth - getDisplayWidth(prefix));
      return `${ansiComposerPrefix(prefix)}${ansiComposerFill(padToDisplayWidth(line || " ", contentWidth))}`;
    });
    const beforeCursor = value.slice(0, clampedCursor);
    const cursorSegments = beforeCursor.split("\n");
    const cursorRow = cursorSegments.length - 1;
    const cursorColumn = 2 + getDisplayWidth(cursorSegments.at(-1) ?? "");

    return {
      lines: promptLines,
      cursorRow,
      cursorColumn
    };
  }

  private renderFooterLines(viewportWidth: number) {
    const panel = this.input.panel.getState(this.state.editorValue);

    if (panel.mode !== "idle") {
      return this.renderPanelFooter(panel, viewportWidth);
    }

    if (this.state.notice) {
      return this.renderNoticeFooter(viewportWidth);
    }

    return [this.renderComposerMetaLine(viewportWidth)];
  }

  private renderComposerMetaLine(viewportWidth: number) {
    const model = this.input.session.model || "no-model";
    const directory = shortenHomePath(this.input.session.cwd ?? process.cwd());
    const separator = ansiMetaSeparator(" · ");
    const text = `${ansiMetaValue(model)}${separator}${ansiMetaMuted(directory)}`;

    return truncateAnsiLine(text, viewportWidth);
  }

  private renderPanelFooter(panel: TerminalPanelState, viewportWidth: number) {
    const lines: string[] = [];
    const separator = ansiMetaSeparator(" · ");
    const title = panel.title ? ansiPanelTitle(panel.title) : "";
    const subtitle = panel.subtitle ? ansiPanelSubtitle(panel.subtitle) : "";

    lines.push(truncateAnsiLine([title, subtitle].filter(Boolean).join(separator), viewportWidth));

    if (panel.description) {
      for (const line of panel.description.split("\n")) {
        lines.push(truncateAnsiLine(ansiPanelDescription(line), viewportWidth));
      }
    }

    if (panel.mode === "command" && panel.query !== undefined) {
      lines.push(truncateAnsiLine(ansiPanelQuery(`/${panel.query}`), viewportWidth));
    }

    const visibleOptions = panel.options.slice(0, 5);

    for (const [index, option] of visibleOptions.entries()) {
      const isSelected = index === panel.selectedIndex;
      lines.push(truncateAnsiLine(this.renderPanelOption(option.label, option.detail, option.style, isSelected), viewportWidth));
    }

    lines.push(truncateAnsiLine(
      `${ansiActionHint("↑↓")} ${ansiPanelHelp("select")}  ${ansiActionHint("Enter")} ${ansiPanelHelp("confirm")}  ${ansiActionHint("Esc")} ${ansiPanelHelp("close")}`,
      viewportWidth
    ));

    return lines;
  }

  private renderNoticeFooter(viewportWidth: number) {
    const notice = this.state.notice;

    if (!notice) {
      return [this.renderComposerMetaLine(viewportWidth)];
    }

    const lines = [
      truncateAnsiLine(
        notice.tone === "error"
          ? ansiNoticeErrorTitle(notice.title)
          : ansiNoticeTitle(notice.title),
        viewportWidth
      )
    ];

    for (const line of notice.body.split("\n").slice(0, 6)) {
      lines.push(truncateAnsiLine(
        notice.tone === "error"
          ? ansiNoticeErrorBody(line)
          : ansiNoticeBody(line),
        viewportWidth
      ));
    }

    return lines;
  }

  private renderPanelOption(
    label: string,
    detail: string | undefined,
    style: "primary" | "secondary" | "danger" | undefined,
    isSelected: boolean
  ) {
    const mark = isSelected ? ansiPanelPointer("›") : ansiPanelMuted(" ");
    const content = isSelected
      ? ansiActionMenuItem(label, style)
      : ansiPanelOption(label, style);
    const detailText = detail ? `  ${ansiPanelDetail(detail)}` : "";

    return `${mark} ${content}${detailText}`;
  }

  private startWorkingAnimation() {
    this.stopWorkingAnimation();
    this.state.workingFrame = 0;
    const taskId = this.state.workingTaskId;
    const existing = findMessageByTaskId(this.state.messages, taskId);

    if (existing?.kind === "assistant-working") {
      upsertMessageByTaskId(this.state.messages, taskId, {
        ...existing,
        body: this.renderWorkingLabel()
      });
    }

    this.workingTimer = setInterval(() => {
      const currentTaskId = this.state.workingTaskId;
      const next = findMessageByTaskId(this.state.messages, currentTaskId);

      if (!next || next.kind !== "assistant-working") {
        this.stopWorkingAnimation();
        return;
      }

      this.state.workingFrame += 0.55;
      upsertMessageByTaskId(this.state.messages, currentTaskId, {
        ...next,
        body: this.renderWorkingLabel()
      });
      this.render();
    }, 60);
  }

  private stopWorkingAnimation() {
    if (!this.workingTimer) {
      return;
    }

    clearInterval(this.workingTimer);
    this.workingTimer = undefined;
  }

  private renderWorkingLabel() {
    const text = "• Working";
    const beamWidth = 3;
    const cycleLength = text.length + beamWidth * 2;
    const beamCenter = (this.state.workingFrame % cycleLength) - beamWidth;
    let output = "";

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] ?? "";
      const distance = Math.abs(index - beamCenter);

      if (distance < 0.32) {
        output += ansiWorkingBeamHidden(char);
        continue;
      }

      if (distance < 0.82) {
        output += ansiWorkingBeamCore(char);
        continue;
      }

      if (distance < 1.4) {
        output += ansiWorkingBeamMid(char);
        continue;
      }

      if (distance < 2.1) {
        output += ansiWorkingBeamTrail(char);
        continue;
      }

      output += ansiWorkingBase(char);
    }

    return output;
  }
}

function getDisplayWidth(text: string) {
  let width = 0;

  for (const char of text) {
    width += getCharDisplayWidth(char);
  }

  return width;
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

function ansiBright(text: string) {
  return paint(text, { fg: "textPrimary", bold: true });
}

function ansiDim(text: string) {
  return fg("textMuted", text);
}

function ansiMuted(text: string) {
  return fg("textMuted", text);
}

function ansiPrompt(text: string) {
  return fg("textPrimary", text);
}

function ansiComposerPrefix(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
}

function ansiComposerFill(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
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

function ansiActionHint(text: string) {
  return fg("textMuted", text);
}

function ansiPanelTitle(text: string) {
  return fg("textPrimary", text);
}

function ansiPanelSubtitle(text: string) {
  return fg("textMuted", text);
}

function ansiPanelLabel(text: string) {
  return fg("textMuted", text);
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

function ansiPanelDescription(text: string) {
  return fg("textSecondary", text);
}

function ansiPanelHelp(text: string) {
  return fg("textMuted", text);
}

function ansiNoticeTitle(text: string) {
  return fg("textMuted", text);
}

function ansiNoticeBody(text: string) {
  return fg("textSecondary", text);
}

function ansiNoticeErrorTitle(text: string) {
  return fg("stateError", text);
}

function ansiNoticeErrorBody(text: string) {
  return fg("stateError", text);
}

function ansiActionMenuItem(text: string, style?: "primary" | "secondary" | "danger") {
  const fgCode = style === "danger"
    ? "bgBase"
    : "bgBase";
  const bgCode = style === "danger"
    ? "stateError"
    : style === "primary"
      ? "accentWarm"
      : "textSecondary";

  return paint(` ${text} `, { fg: fgCode, bg: bgCode, bold: true });
}

function ansiWorkingBase(text: string) {
  return fg("textSecondary", text);
}

function ansiWorkingBeamHidden(text: string) {
  return paint(text, { conceal: true });
}

function ansiWorkingBeamCore(text: string) {
  return fg("bgPanel", text);
}

function ansiWorkingBeamMid(text: string) {
  return fg("lineStrong", text);
}

function ansiWorkingBeamTrail(text: string) {
  return fg("textMuted", text);
}

function ansiLogo(text: string) {
  return fg("accentPrimary", text);
}

function renderWelcomeLogo() {
  return [
    ansiLogo("  ▟██▙"),
    ansiLogo("▗██████"),
    ansiLogo(" ▝▘▝▘▝▘")
  ];
}

function createToolRunningMessage(toolName: string, input?: unknown) {
  const target = renderToolTarget(toolName, input);

  return target
    ? `${toolName} · running\n${target}`
    : `${toolName} · running`;
}

function appendToolOutput(current: string, toolName: string, chunk: string) {
  const normalizedCurrent = current || createToolRunningMessage(toolName);
  const content = `${normalizedCurrent}\n${sanitizeToolChunk(chunk)}`.trimEnd();
  return clipToolTranscript(content);
}

function finalizeToolMessage(current: string, toolName: string, summary: string, rawOutput?: string) {
  const sanitizedOutput = sanitizeToolChunk(rawOutput ?? "");
  const meaningfulOutput = hasMeaningfulToolOutput(sanitizedOutput) ? sanitizedOutput : "";
  const lines = current
    ? current.split("\n").filter(Boolean)
    : [];
  const header = `${toolName} · ${summary}`;

  if (lines.length === 0) {
    return meaningfulOutput
      ? clipToolTranscript([header, meaningfulOutput].join("\n"))
      : header;
  }

  const preserved = lines.slice(1).filter((line) =>
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

function renderToolTarget(toolName: string, input?: unknown) {
  if (toolName === "shell" && input && typeof input === "object" && "command" in input && typeof input.command === "string") {
    return createToolPreview(input.command, 140);
  }

  if (toolName === "files" && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
    const range = "startLine" in input && typeof input.startLine === "number"
      ? `:${input.startLine}${"endLine" in input && typeof input.endLine === "number" ? `-${input.endLine}` : ""}`
      : "";
    return `${input.path}${range}`;
  }

  if ((toolName === "write" || toolName === "edit") && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
    const range = "startLine" in input && typeof input.startLine === "number"
      ? `:${input.startLine}${"endLine" in input && typeof input.endLine === "number" ? `-${input.endLine}` : ""}`
      : "";
    return `${input.path}${range}`;
  }

  return "";
}

function createApprovalResolvedMessage(_approvalId: string, approved: boolean) {
  return `approval · ${approved ? "approved" : "denied"}`;
}

function createTaskErrorMessage(previousBody: string | undefined, message: string) {
  const headline = previousBody
    ? deriveTaskHeadline(previousBody)
    : "task · failed";

  return [
    headline.endsWith("failed") ? headline : `${headline} · failed`,
    message
  ].join("\n");
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
  const compactBody = bodyLines.join("\n");
  const clippedBody = compactBody.length <= Math.max(0, maxChars - header.length - 1)
    ? compactBody
    : `${compactBody.slice(Math.max(0, compactBody.length - Math.max(0, maxChars - header.length - 17)))}\n...truncated...`;
  const normalized = [header, clippedBody].filter(Boolean).join("\n");
  const normalizedLines = normalized.split("\n");

  if (normalizedLines.length <= maxLines) {
    return normalized;
  }

  const visibleBodyLines = normalizedLines.slice(1);

  return [header, "...truncated...", ...visibleBodyLines.slice(-(maxLines - 2))].join("\n");
}

function hasMeaningfulToolOutput(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .some(Boolean);
}

function createToolPreview(content: string, maxLength: number) {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function deriveTaskHeadline(body: string) {
  const [firstLine] = body.split("\n").filter(Boolean);

  if (!firstLine) {
    return "task";
  }

  return firstLine
    .replace(/\s*·\s*running$/i, "")
    .replace(/\s*·\s*completed$/i, "")
    .replace(/\s*·\s*Shell command completed$/i, "")
    .replace(/\s*·\s*Shell command failed\s*\(\d+\)$/i, "")
    .trim();
}

function findMessageByTaskId(messages: TerminalMessageBlock[], taskId?: string) {
  if (!taskId) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.taskId === taskId) {
      return message;
    }
  }

  return undefined;
}

function upsertMessageByTaskId(messages: TerminalMessageBlock[], taskId: string | undefined, nextMessage: TerminalMessageBlock) {
  if (!taskId) {
    messages.push(nextMessage);
    return false;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.taskId !== taskId) {
      continue;
    }

    messages[index] = {
      ...messages[index],
      ...nextMessage
    };
    return true;
  }

  messages.push(nextMessage);
  return false;
}

function removeMessageByTaskId(messages: TerminalMessageBlock[], taskId: string | undefined) {
  if (!taskId) {
    return false;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.taskId !== taskId) {
      continue;
    }

    messages.splice(index, 1);
    return true;
  }

  return false;
}

function upsertMessageByApprovalId(messages: TerminalMessageBlock[], approvalId: string, nextMessage: TerminalMessageBlock) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.approvalId !== approvalId) {
      continue;
    }

    messages[index] = {
      ...messages[index],
      ...nextMessage
    };
    return true;
  }

  return false;
}

function shouldUpsertSystemMessage(title: string) {
  return title === "Help" || title === "Tools";
}

function isTransientSystemNotice(title: string) {
  return title === "Help" || title === "Tools" || title === "Busy" || title === "Stopped";
}

function isTransientRuntimeNotice(message: string) {
  return message.startsWith("Unknown command:") || message.startsWith("Unknown approval id:");
}

function upsertSystemMessageByTitle(messages: TerminalMessageBlock[], nextMessage: TerminalMessageBlock) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.kind !== "system" || message.title !== nextMessage.title) {
      continue;
    }

    messages[index] = {
      ...message,
      ...nextMessage
    };
    return;
  }

  messages.push(nextMessage);
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

function truncateAnsiLine(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  let output = "";
  let currentWidth = 0;

  for (const part of splitAnsiAware(text)) {
    if (part.type === "ansi") {
      output += part.value;
      continue;
    }

    for (const char of part.value) {
      const charWidth = getCharDisplayWidth(char);

      if (currentWidth + charWidth > width) {
        return output;
      }

      output += char;
      currentWidth += charWidth;
    }
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

function padToDisplayWidth(text: string, width: number) {
  const fillWidth = Math.max(0, width - getDisplayWidth(text));

  return `${text}${" ".repeat(fillWidth)}`;
}
