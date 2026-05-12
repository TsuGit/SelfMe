import type { EventBus } from "../app/event-bus.js";
import { homedir } from "node:os";
import { clearLine, hideCursor, moveCursorTo, readCursorPosition, showCursor } from "./screen.js";
import { renderTerminalLayout, type TerminalMessageBlock } from "./layout.js";
import type { SettingsStore } from "../storage/settings.js";
import type { SessionRecord } from "../types/session.js";
import { fg, paint } from "./theme.js";

interface RenderState {
  editorValue: string;
  editorCursor: number;
  messages: TerminalMessageBlock[];
  messageViewportOffset: number;
  workingFrame: number;
}

export class TerminalRenderer {
  private anchorRow = 0;
  private renderedLineCount = 0;

  private state: RenderState = {
    editorValue: "",
    editorCursor: 0,
    messages: [],
    messageViewportOffset: 0,
    workingFrame: 0
  };
  private workingTimer?: NodeJS.Timeout;

  constructor(
    private readonly input: {
      bus: EventBus;
      settings: SettingsStore;
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

    this.input.bus.on("editor.state.changed", (event) => {
      this.state.editorValue = String(event.payload.value ?? "");
      this.state.editorCursor = Number(event.payload.cursor ?? 0);
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
      this.render();
    });

    this.input.bus.on("system.message.appended", (event) => {
      this.state.messages.push({
        kind: "system",
        title: event.payload.title,
        body: event.payload.content
      });
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("assistant.stream.started", () => {
      const last = this.state.messages.at(-1);
      const workingMessage: TerminalMessageBlock = {
        kind: "assistant-working",
        title: "",
        body: this.renderWorkingLabel()
      };

      if (last?.kind === "assistant-working" || last?.kind === "assistant") {
        this.state.messages[this.state.messages.length - 1] = workingMessage;
      } else {
        this.state.messages.push(workingMessage);
      }

      this.state.messageViewportOffset = 0;
      this.startWorkingAnimation();
      this.render();
    });

    this.input.bus.on("assistant.delta.received", (event) => {
      const last = this.state.messages.at(-1);

      if (last?.kind === "assistant-working") {
        this.state.messages[this.state.messages.length - 1] = {
          kind: "assistant",
          title: "",
          body: event.payload.delta
        };
      } else if (!last || last.kind !== "assistant") {
        this.state.messages.push({
          kind: "assistant",
          title: "",
          body: event.payload.delta
        });
      } else {
        this.state.messages[this.state.messages.length - 1] = {
          kind: "assistant",
          title: "",
          body: `${last.body}${event.payload.delta}`
        };
      }

      this.stopWorkingAnimation();
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("assistant.completed", () => {
      this.stopWorkingAnimation();
      this.render();
    });

    this.input.bus.on("tool.execution.started", (event) => {
      this.state.messages.push({
        kind: "tool",
        title: "Tool",
        body: `[${event.payload.toolName}] running...`
      });
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("tool.execution.completed", (event) => {
      this.state.messages.push({
        kind: "tool",
        title: "Tool",
        body: [
          `[${event.payload.toolName}] ${event.payload.summary}`,
          event.payload.rawOutput ?? ""
        ].filter(Boolean).join("\n\n")
      });
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("approval.requested", (event) => {
      this.state.messages.push({
        kind: "approval",
        title: "Approval",
        body: [
          `[${event.payload.toolName}] ${event.payload.reason}`,
          `Risk: ${event.payload.risk}`,
          `Approve: /approve ${event.payload.approvalId}`,
          `Deny: /deny ${event.payload.approvalId}`
        ].join("\n")
      });
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("approval.resolved", (event) => {
      this.state.messages.push({
        kind: "approval",
        title: "Approval",
        body: `${event.payload.approved ? "Approved" : "Denied"}: ${event.payload.approvalId}`
      });
      this.state.messageViewportOffset = 0;
      this.render();
    });

    this.input.bus.on("runtime.error.raised", (event) => {
      this.stopWorkingAnimation();
      this.state.messages.push({
        kind: "error",
        title: "Error",
        body: event.payload.message
      });
      this.state.messageViewportOffset = 0;
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
    const layout = renderTerminalLayout({
      messages: this.state.messages,
      promptLines: prompt.lines,
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

  private renderPrompt() {
    const clampedCursor = Math.max(0, Math.min(this.state.editorCursor, this.state.editorValue.length));
    const value = this.state.editorValue;
    const lines = value.length > 0 ? value.split("\n") : [""];
    const viewportWidth = process.stdout.columns ?? 80;
    const promptLines = lines.map((line, index) => {
      const prefix = index === 0 ? "> " : "· ";
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

  private startWorkingAnimation() {
    this.stopWorkingAnimation();
    this.state.workingFrame = 0;
    const last = this.state.messages.at(-1);

    if (last?.kind === "assistant-working") {
      this.state.messages[this.state.messages.length - 1] = {
        ...last,
        body: this.renderWorkingLabel()
      };
    }

    this.workingTimer = setInterval(() => {
      const last = this.state.messages.at(-1);

      if (!last || last.kind !== "assistant-working") {
        this.stopWorkingAnimation();
        return;
      }

      this.state.workingFrame += 0.55;
      this.state.messages[this.state.messages.length - 1] = {
        ...last,
        body: this.renderWorkingLabel()
      };
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
  const fillWidth = Math.max(0, width - getDisplayWidth(text));

  return `${text}${" ".repeat(fillWidth)}`;
}
