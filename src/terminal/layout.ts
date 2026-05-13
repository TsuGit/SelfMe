import { fg, paint } from "./theme.js";

export interface LayoutState {
  width: number;
  height: number;
}

export interface TerminalMessageBlock {
  kind?: "welcome" | "user" | "assistant" | "assistant-working" | "system" | "tool" | "approval" | "error";
  title: string;
  body: string;
  taskId?: string;
  approvalId?: string;
  actions?: Array<{
    id: string;
    label: string;
    command: string;
    style?: "primary" | "secondary" | "danger";
  }>;
}

export interface TerminalLayoutInput {
  messages: TerminalMessageBlock[];
  promptLines: string[];
  footerLines?: string[];
  promptCursorRow: number;
  viewportHeight: number;
  viewportWidth: number;
  messageViewportOffset: number;
}

export interface RenderedTerminalLayout {
  content: string;
  inputRow: number;
  inputColumn: number;
  isPinnedToBottom: boolean;
  visibleMessageRows: number;
  maxScrollOffset: number;
  normalizedScrollOffset: number;
}

export function renderTerminalLayout(input: TerminalLayoutInput): RenderedTerminalLayout {
  const hasMessages = input.messages.length > 0;
  const hasViewportHint = input.messageViewportOffset > 0;
  const composerTopPad = 1;
  const composerBottomPad = 1;
  const footerRows = input.footerLines?.length ?? 0;
  const messageLines = input.messages.length > 0
    ? renderMessageSequence(input.messages, input.viewportWidth).split("\n")
    : [];

  const reservedRows =
    composerTopPad +
    input.promptLines.length +
    footerRows +
    composerBottomPad +
    (hasMessages ? 1 : 0) +
    (hasViewportHint ? 1 : 0);
  const fullHeight = reservedRows + messageLines.length;
  const shouldPinInput = fullHeight > input.viewportHeight;
  const availableMessageRows = Math.max(1, input.viewportHeight - reservedRows);
  const maxScrollOffset = Math.max(0, messageLines.length - availableMessageRows);
  const normalizedOffset = shouldPinInput
    ? Math.max(0, Math.min(input.messageViewportOffset, maxScrollOffset))
    : 0;
  const isPinnedToBottom = normalizedOffset === 0;
  const sliceStart = shouldPinInput
    ? Math.max(0, messageLines.length - availableMessageRows - normalizedOffset)
    : 0;
  const sliceEnd = shouldPinInput ? sliceStart + availableMessageRows : messageLines.length;
  const visibleMessageLines = messageLines.slice(sliceStart, sliceEnd);
  const viewportHint = shouldPinInput
    ? isPinnedToBottom
      ? ""
      : `history ${normalizedOffset}/${maxScrollOffset}`
    : "";

  const lines = visibleMessageLines.length > 0 ? [...visibleMessageLines, ""] : [];

  if (viewportHint) {
    lines.push(ansiViewportHint(viewportHint));
  }

  lines.push(renderComposerPadLine(input.viewportWidth));
  lines.push(...input.promptLines);
  lines.push(renderComposerPadLine(input.viewportWidth));

  if (input.footerLines?.length) {
    for (const footerLine of input.footerLines) {
      lines.push(formatComposerMetaLine(footerLine, input.viewportWidth));
    }
  }

  const content = lines.join("\n");
  const inputRow = Math.max(0, lines.length - input.promptLines.length - composerBottomPad - footerRows);

  return {
    content,
    inputRow,
    inputColumn: 0,
    isPinnedToBottom,
    visibleMessageRows: availableMessageRows,
    maxScrollOffset,
    normalizedScrollOffset: normalizedOffset
  };
}

function renderMessageSequence(
  messages: TerminalMessageBlock[],
  viewportWidth: number
) {
  const chunks: string[] = [];

  for (const [index, message] of messages.entries()) {
    if (index > 0) {
      const previous = messages[index - 1];
      chunks.push(shouldTightGroup(previous, message) ? "\n" : "\n\n");
    }

    chunks.push(renderMessageBlock(message, viewportWidth));
  }

  return chunks.join("");
}

function renderMessageBlock(
  message: TerminalMessageBlock,
  viewportWidth: number
) {
  const contentWidth = Math.max(12, viewportWidth - 1);

  if (message.kind === "user") {
    const userContentWidth = Math.max(8, viewportWidth - 2);
    const contentLines = wrapBlockLines(message.body, userContentWidth)
      .map((line, index) => formatUserComposerLine(line, index === 0 ? "› " : "  ", viewportWidth))
      .join("\n");

    return [
      renderComposerPadLine(viewportWidth),
      contentLines,
      renderComposerPadLine(viewportWidth)
    ].join("\n");
  }

  if (message.kind === "tool") {
    return renderStructuredMetaBlock(message.body, Math.max(8, contentWidth - 2), "tool");
  }

  if (message.kind === "approval") {
    return renderStructuredMetaBlock(
      message.body,
      Math.max(8, contentWidth - 2),
      "approval"
    );
  }

  if (message.kind === "error") {
    return renderStructuredMetaBlock(message.body, Math.max(8, contentWidth - 2), "error");
  }

  if (message.kind === "system") {
    const wrappedBody = wrapBlockLines(message.body, Math.max(8, contentWidth - 2))
      .map((line) => `${ansiMuted("│ ")}${line}`);

    return [formatMetaTitle(message.title.toLowerCase()), ...wrappedBody].join("\n");
  }

  if (message.kind === "assistant") {
    return wrapBlockLines(message.body, Math.max(8, contentWidth - 2))
      .map((line, index) => formatAssistantLine(line, index === 0 ? "• " : "  "))
      .join("\n");
  }

  if (message.kind === "assistant-working") {
    return wrapBlockLines(message.body, contentWidth)
      .map((line, index) => formatAssistantWorkingLine(line, index === 0))
      .join("\n");
  }

  if (!message.title) {
    return wrapBlockLines(message.body, contentWidth).join("\n");
  }

  const wrappedBody = wrapBlockLines(message.body, Math.max(8, contentWidth - 2))
    .map((line) => `${ansiMuted("  ")}${line}`);

  return [formatMetaTitle(message.title), ...wrappedBody].join("\n");
}

function wrapBlockLines(block: string, width: number) {
  return block
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
}

function wrapLine(line: string, width: number) {
  if (!line) {
    return [""];
  }

  const output: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const part of splitAnsiAware(line)) {
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

function formatComposerLine(line: string, prefix: string, viewportWidth: number) {
  const contentWidth = Math.max(1, viewportWidth - getDisplayWidth(prefix));
  const padded = padToDisplayWidth(line || " ", contentWidth);

  return `${ansiComposerPrefix(prefix)}${ansiInputFill(padded)}`;
}

function formatUserComposerLine(line: string, prefix: string, viewportWidth: number) {
  const contentWidth = Math.max(1, viewportWidth - getDisplayWidth(prefix));
  const padded = padToDisplayWidth(line || " ", contentWidth);

  return `${ansiUserComposerPrefix(prefix)}${ansiInputFill(padded)}`;
}

function renderComposerPadLine(viewportWidth: number) {
  return ansiInputFill(" ".repeat(Math.max(1, viewportWidth)));
}

function formatComposerMetaLine(line: string, viewportWidth: number) {
  return ansiInputMeta(padToDisplayWidth(line, Math.max(1, viewportWidth)));
}

function formatAssistantLine(line: string, prefix: string) {
  return `${ansiAssistantMark(prefix)}${line}`;
}

function formatAssistantWorkingLine(line: string, isFirstLine: boolean) {
  if (isFirstLine) {
    return line;
  }

  return `${ansiMuted("  ")}${line}`;
}

function formatMetaTitle(title: string) {
  return `${ansiMuted("[" + title + "]")}`;
}

function renderStructuredMetaBlock(
  body: string,
  width: number,
  tone: "tool" | "approval" | "error"
) {
  const lines = body.split("\n");
  const [headline = "", ...rest] = lines;
  const headlineRenderer = tone === "tool"
    ? ansiToolHeadline
    : tone === "approval"
      ? ansiApprovalHeadline
      : ansiErrorHeadline;
  const bodyRenderer = tone === "tool"
    ? ansiTool
    : tone === "approval"
      ? ansiApproval
      : ansiError;
  const wrappedHeadline = wrapBlockLines(headline, width)
    .map((line, index) => `${index === 0 ? ansiMuted("• ") : ansiMuted("  ")}${headlineRenderer(line)}`);
  const filteredBody = tone === "approval"
    ? rest.filter((line) => !line.startsWith("approve · /approve ") && !line.startsWith("deny · /deny "))
    : rest;
  const wrappedBody = filteredBody.flatMap((line) => renderStructuredMetaBodyLine(line, width, bodyRenderer));

  return [...wrappedHeadline, ...wrappedBody].join("\n");
}

function renderStructuredMetaBodyLine(
  line: string,
  width: number,
  renderer: (text: string) => string
) {
  const isCodeLike = /^[ \t]*\d+[ \t]*\|/.test(line) || /^[ \t]*\.\.\.truncated\.\.\./.test(line);
  const prefix = isCodeLike ? "    " : "  ";
  const wrapped = wrapBlockLines(line, Math.max(1, width - prefix.length));

  return wrapped.map((segment) => `${ansiMuted(prefix)}${renderer(segment)}`);
}

function shouldTightGroup(previous: TerminalMessageBlock | undefined, next: TerminalMessageBlock) {
  if (!previous?.taskId || !next.taskId || previous.taskId !== next.taskId) {
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

function ansiPrompt(text: string) {
  return fg("textPrimary", text);
}

function ansiComposerPrefix(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
}

function ansiUserComposerPrefix(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textSecondary" });
}

function ansiInputFill(text: string) {
  return paint(text, { bg: "bgSubtle", fg: "textPrimary" });
}

function ansiInputMeta(text: string) {
  return fg("textMuted", text);
}

function ansiMuted(text: string) {
  return fg("textMuted", text);
}

function ansiAssistantMark(text: string) {
  return fg("textMuted", text);
}

function ansiViewportHint(text: string) {
  return fg("textMuted", text);
}

function ansiActionLine(text: string) {
  return fg("textSecondary", text);
}

function ansiTool(text: string) {
  return fg("textSecondary", text);
}

function ansiToolHeadline(text: string) {
  return fg("textPrimary", text);
}

function ansiApproval(text: string) {
  return fg("accentWarm", text);
}

function ansiApprovalHeadline(text: string) {
  return fg("accentWarm", text);
}

function ansiError(text: string) {
  return fg("stateError", text);
}

function ansiErrorHeadline(text: string) {
  return fg("stateError", text);
}

function padToDisplayWidth(text: string, width: number) {
  const fillWidth = Math.max(0, width - getDisplayWidth(text));

  return `${text}${" ".repeat(fillWidth)}`;
}
