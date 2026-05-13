import type { EventBus } from "../app/event-bus.js";
import { homedir } from "node:os";
import type { TerminalPanelController, TerminalPanelState } from "./panel-controller.js";
import { clearLine, hideCursor, moveCursorTo, readCursorPosition, showCursor } from "./screen.js";
import { renderTerminalLayout, type TerminalMessageBlock } from "./layout.js";
import type { SettingsStore } from "../storage/settings.js";
import type { RuntimeEvent } from "../types/events.js";
import type { SessionRecord } from "../types/session.js";
import { fg, paint } from "./theme.js";

interface RenderState {
  editorValue: string;
  editorCursor: number;
  messages: TerminalMessageBlock[];
  messageViewportOffset: number;
  workingFrame: number;
  workingTaskId?: string;
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
    workingTaskId: undefined
  };
  private workingTimer?: NodeJS.Timeout;

  constructor(
    private readonly input: {
      bus: EventBus;
      panel: TerminalPanelController;
      settings: SettingsStore;
      session: SessionRecord;
      restoredEvents?: RuntimeEvent[];
      resumedSession?: boolean;
      startupMode?: "new" | "resume-latest" | "resume-selected";
      latestSessionHint?: string;
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
    const restoredMessages = this.input.restoredEvents?.length
      ? projectRestoredMessages(this.input.restoredEvents)
      : [];

    this.state.messages.push({
      kind: "welcome",
      title: "",
      body: welcomeLines.join("\n")
    });

    if (this.input.resumedSession) {
      this.state.messages.push({
        kind: "system",
        title: "Session",
        body: createSessionStartupMessage({
          startupMode: this.input.startupMode,
          restoredCount: restoredMessages.length
        })
      });
    } else if (this.input.latestSessionHint) {
      this.state.messages.push({
        kind: "system",
        title: "Resume",
        body: this.input.latestSessionHint
      });
    }

    if (restoredMessages.length > 0) {
      this.state.messages.push(...restoredMessages);
    }

    this.syncActions();

    this.input.bus.on("editor.state.changed", (event) => {
      this.state.editorValue = String(event.payload.value ?? "");
      this.state.editorCursor = Number(event.payload.cursor ?? 0);
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
      this.syncActions();
      this.render();
    });

    this.input.bus.on("system.message.appended", (event) => {
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

    this.input.bus.on("assistant.completed", () => {
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
        body: createApprovalRequestedMessage({
          toolName: event.payload.toolName,
          reason: event.payload.reason,
          risk: event.payload.risk,
          approvalId: event.payload.approvalId
        })
      };
      this.state.messages.push(nextMessage);
      this.state.messageViewportOffset = 0;
      this.syncActions();
      this.render();
    });

    this.input.bus.on("approval.resolved", (event) => {
      const updated = upsertMessageByApprovalId(this.state.messages, event.payload.approvalId, {
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
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

    if (panel.mode === "command" && panel.query !== undefined) {
      lines.push(truncateAnsiLine(`${ansiPanelLabel("Filter")} ${ansiPanelQuery(`/${panel.query}`)}`, viewportWidth));
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

function ansiPanelHelp(text: string) {
  return fg("textMuted", text);
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

function createSessionStartupMessage(input: {
  startupMode?: "new" | "resume-latest" | "resume-selected";
  restoredCount: number;
}) {
  const recoveredLine = input.restoredCount > 0
    ? `Recovered session history (${input.restoredCount} items)`
    : "Reopened session";
  const attachLine = input.startupMode === "resume-selected"
    ? "Attached using selfme --session <id>"
    : "Attached to session";

  return [
    recoveredLine,
    attachLine,
    "New session: selfme --new",
    "Other sessions: /sessions"
  ].join("\n");
}

function createToolRunningMessage(toolName: string, input?: unknown) {
  const target = renderToolTarget(toolName, input);

  return target
    ? `${toolName} · running\n${target}\nwaiting for output...`
    : `${toolName} · running\nwaiting for output...`;
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
    line !== "waiting for output..." &&
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
    return `command · ${createToolPreview(input.command, 140)}`;
  }

  if (toolName === "files" && input && typeof input === "object" && "path" in input && typeof input.path === "string") {
    const range = "startLine" in input && typeof input.startLine === "number"
      ? `:${input.startLine}${"endLine" in input && typeof input.endLine === "number" ? `-${input.endLine}` : ""}`
      : "";
    return `path · ${input.path}${range}`;
  }

  return "";
}

function createApprovalRequestedMessage(input: {
  toolName: string;
  reason: string;
  risk: string;
  approvalId: string;
}) {
  return [
    `${input.toolName} · approval required`,
    input.reason,
    `risk · ${input.risk}`,
    `approve · /approve ${input.approvalId}`,
    `deny · /deny ${input.approvalId}`
  ].join("\n");
}

function createApprovalResolvedMessage(approvalId: string, approved: boolean) {
  return `approval · ${approved ? "approved" : "denied"} · ${approvalId}`;
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
  const normalized = text.length <= maxChars
    ? text
    : `${text.slice(text.length - maxChars + 16)}\n...truncated...`;
  const lines = normalized.split("\n");

  if (lines.length <= maxLines) {
    return normalized;
  }

  return ["...truncated...", ...lines.slice(-maxLines + 1)].join("\n");
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
  return title === "Help" ||
    title === "Sessions" ||
    title === "Tasks" ||
    title === "Plan" ||
    title === "Checkpoint" ||
    title === "Tools" ||
    title === "History" ||
    title === "Search" ||
    title === "Jump" ||
    title === "Resume" ||
    title === "Retry" ||
    title === "Recovery";
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

function projectRestoredMessages(events: RuntimeEvent[]): TerminalMessageBlock[] {
  const projected: TerminalMessageBlock[] = [];

  for (const event of events) {
    if (event.type === "system.message.appended") {
      const nextMessage: TerminalMessageBlock = {
        kind: "system",
        title: event.payload.title,
        body: event.payload.content
      };

      if (shouldUpsertSystemMessage(event.payload.title)) {
        upsertSystemMessageByTitle(projected, nextMessage);
      } else {
        projected.push(nextMessage);
      }
      continue;
    }

    if (event.type === "user.message.submitted") {
      projected.push({
        kind: "user",
        title: "",
        body: event.payload.content
      });
      continue;
    }

    if (event.type === "approval.requested") {
      projected.push({
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
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
        body: createApprovalRequestedMessage({
          toolName: event.payload.toolName,
          reason: event.payload.reason,
          risk: event.payload.risk,
          approvalId: event.payload.approvalId
        })
      });
      continue;
    }

    if (event.type === "approval.resolved") {
      upsertMessageByApprovalId(projected, event.payload.approvalId, {
        kind: "approval",
        title: "Approval",
        taskId: event.taskId,
        approvalId: event.payload.approvalId,
        actions: [],
        body: createApprovalResolvedMessage(event.payload.approvalId, event.payload.approved)
      });
      continue;
    }

    if (event.type === "runtime.error.raised") {
      const existing = findMessageByTaskId(projected, event.taskId);
      upsertMessageByTaskId(projected, event.taskId, {
        kind: "error",
        title: "Error",
        taskId: event.taskId,
        body: createTaskErrorMessage(existing?.body, event.payload.message)
      });
      continue;
    }

    if (event.type === "tool.execution.requested") {
      upsertMessageByTaskId(projected, event.taskId, {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body: createToolRunningMessage(event.payload.toolName, event.payload.input)
      });
      continue;
    }

    if (event.type === "tool.execution.completed") {
      const existing = findMessageByTaskId(projected, event.taskId);
      const body = finalizeToolMessage(
        existing?.kind === "tool" ? existing.body : "",
        event.payload.toolName,
        event.payload.summary,
        event.payload.rawOutput
      );
      upsertMessageByTaskId(projected, event.taskId, {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body
      });
      continue;
    }

    if (event.type === "tool.stdout.appended") {
      const existing = findMessageByTaskId(projected, event.taskId);
      const body = appendToolOutput(existing?.kind === "tool" ? existing.body : "", event.payload.toolName, event.payload.chunk);
      upsertMessageByTaskId(projected, event.taskId, {
        kind: "tool",
        title: "Tool",
        taskId: event.taskId,
        body
      });
      continue;
    }

    if (event.type !== "assistant.delta.received") {
      continue;
    }

    const existing = findMessageByTaskId(projected, event.taskId);
    const body = existing?.kind === "assistant"
      ? `${existing.body}${event.payload.delta}`
      : event.payload.delta;
    upsertMessageByTaskId(projected, event.taskId, {
      kind: "assistant",
      title: "",
      taskId: event.taskId,
      body
    });
  }

  return projected;
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
