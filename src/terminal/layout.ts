export interface LayoutState {
  width: number;
  height: number;
}

export interface TerminalMessageBlock {
  title: string;
  body: string;
}

export interface TerminalLayoutInput {
  messages: TerminalMessageBlock[];
  promptLines: string[];
  viewportHeight: number;
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
  const messageLines = input.messages.length > 0
    ? input.messages
        .map((message) => renderMessageBlock(message))
        .join("\n\n---\n\n")
        .split("\n")
    : [];

  const reservedRows =
    1 +
    1 +
    input.promptLines.length;
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
      ? "tail"
      : `scrolled ${normalizedOffset}/${maxScrollOffset}`
    : "";

  const lines = [
    ...visibleMessageLines,
    "",
    viewportHint,
    ...input.promptLines
  ];

  const content = lines.join("\n");
  const inputRow = Math.max(0, lines.length - input.promptLines.length);

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

function renderMessageBlock(message: TerminalMessageBlock) {
  if (!message.title) {
    return message.body;
  }

  return `${message.title}\n${message.body}`;
}
