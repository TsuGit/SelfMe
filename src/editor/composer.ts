import { EventBus } from "../app/event-bus.js";
import { createUserMessageSubmittedEvent } from "../runtime/events.js";
import { createEmptyBuffer, deleteBackward, insertText, moveLeft, moveRight, type EditorBufferState } from "./buffer.js";

export class EditorController {
  private state: EditorBufferState = createEmptyBuffer();

  getState() {
    return this.state;
  }

  handlePrintable(input: string) {
    this.state = insertText(this.state, input);
  }

  handleBackspace() {
    this.state = deleteBackward(this.state);
  }

  handleLeft() {
    this.state = moveLeft(this.state);
  }

  handleRight() {
    this.state = moveRight(this.state);
  }

  handleNewline() {
    this.state = insertText(this.state, "\n");
  }

  submit(bus: EventBus, sessionId: string) {
    const content = this.state.value.trim();

    if (!content) {
      return;
    }

    bus.emit(createUserMessageSubmittedEvent({
      sessionId,
      content: this.state.value
    }));
    this.state = createEmptyBuffer();
  }
}

