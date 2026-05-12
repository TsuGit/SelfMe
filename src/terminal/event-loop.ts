import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { EditorController } from "../editor/composer.js";
import { createMessageViewportChangedEvent } from "../runtime/events.js";
import { parseTerminalInput } from "./input-parser.js";

export class TerminalEventLoop {
  constructor(
    private readonly input: {
      bus: EventBus;
      editor: EditorController;
      sessionId?: string;
    }
  ) {}

  start() {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    enableExtendedKeyboardReporting();
    process.stdin.resume();
    process.stdin.on("data", (chunk) => {
      for (const event of parseTerminalInput(chunk)) {
        if (event.type === "quit") {
          process.stdout.write("\n");
          process.exit(0);
        }

        if (event.type === "newline") {
          this.input.editor.handleNewline();
          this.emitEditorState();
          continue;
        }

        if (event.type === "submit") {
          this.input.editor.submit(this.input.bus, this.input.sessionId ?? "local-session");
          continue;
        }

        if (event.type === "scroll") {
          this.input.bus.emit(createMessageViewportChangedEvent({
            sessionId: this.input.sessionId ?? "local-session",
            offset: event.delta
          }));
          continue;
        }

        if (event.type === "backspace") {
          this.input.editor.handleBackspace();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-left") {
          this.input.editor.handleLeft();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-right") {
          this.input.editor.handleRight();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-up") {
          this.input.editor.handleUp();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-down") {
          this.input.editor.handleDown();
          this.emitEditorState();
          continue;
        }

        if (event.type === "text") {
          this.input.editor.handlePrintable(event.value);
          this.emitEditorState();
        }
      }
    });

    process.on("exit", () => {
      disableExtendedKeyboardReporting();
    });
  }

  private emitEditorState() {
    const state = this.input.editor.getState();
    this.input.bus.emit({
      eventId: randomUUID(),
      sessionId: this.input.sessionId ?? "local-session",
      timestamp: new Date().toISOString(),
      source: "user",
      type: "editor.state.changed",
      payload: {
        value: state.value,
        cursor: state.cursor
      }
    });
  }
}

function enableExtendedKeyboardReporting() {
  process.stdout.write("\u001b[>1u");
  process.stdout.write("\u001b[>4;2m");
}

function disableExtendedKeyboardReporting() {
  process.stdout.write("\u001b[<u");
  process.stdout.write("\u001b[>4m");
}
