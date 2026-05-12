export interface EditorBufferState {
  value: string;
  cursor: number;
}

export function createEmptyBuffer(): EditorBufferState {
  return {
    value: "",
    cursor: 0
  };
}

export function insertText(state: EditorBufferState, text: string): EditorBufferState {
  return {
    value: `${state.value.slice(0, state.cursor)}${text}${state.value.slice(state.cursor)}`,
    cursor: state.cursor + text.length
  };
}

export function deleteBackward(state: EditorBufferState): EditorBufferState {
  if (state.cursor === 0) {
    return state;
  }

  return {
    value: `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`,
    cursor: state.cursor - 1
  };
}

export function moveLeft(state: EditorBufferState): EditorBufferState {
  return {
    ...state,
    cursor: Math.max(0, state.cursor - 1)
  };
}

export function moveRight(state: EditorBufferState): EditorBufferState {
  return {
    ...state,
    cursor: Math.min(state.value.length, state.cursor + 1)
  };
}

export function moveUp(state: EditorBufferState): EditorBufferState {
  const segments = getCursorSegments(state);

  if (segments.row === 0) {
    return state;
  }

  const targetRow = segments.row - 1;
  const targetColumn = Math.min(segments.column, segments.lines[targetRow].length);

  return {
    ...state,
    cursor: getCursorIndex(segments.lines, targetRow, targetColumn)
  };
}

export function moveDown(state: EditorBufferState): EditorBufferState {
  const segments = getCursorSegments(state);

  if (segments.row >= segments.lines.length - 1) {
    return state;
  }

  const targetRow = segments.row + 1;
  const targetColumn = Math.min(segments.column, segments.lines[targetRow].length);

  return {
    ...state,
    cursor: getCursorIndex(segments.lines, targetRow, targetColumn)
  };
}

function getCursorSegments(state: EditorBufferState) {
  const lines = state.value.split("\n");
  let remaining = state.cursor;

  for (let row = 0; row < lines.length; row += 1) {
    const lineLength = lines[row].length;

    if (remaining <= lineLength) {
      return {
        lines,
        row,
        column: remaining
      };
    }

    remaining -= lineLength + 1;
  }

  return {
    lines,
    row: lines.length - 1,
    column: lines.at(-1)?.length ?? 0
  };
}

function getCursorIndex(lines: string[], row: number, column: number) {
  let index = 0;

  for (let currentRow = 0; currentRow < row; currentRow += 1) {
    index += lines[currentRow].length + 1;
  }

  return index + column;
}
