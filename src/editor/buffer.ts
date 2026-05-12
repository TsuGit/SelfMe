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

