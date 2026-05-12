import { randomUUID } from "node:crypto";
import readline from "node:readline";

import type { EventBus } from "../app/event-bus.js";
import type { EditorController } from "../editor/composer.js";
import { createMessageViewportChangedEvent } from "../runtime/events.js";

export class TerminalEventLoop {
  constructor(
    private readonly input: {
      bus: EventBus;
      editor: EditorController;
      sessionId?: string;
    }
  ) {}

  start() {
    readline.emitKeypressEvents(process.stdin);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    process.stdin.on("keypress", (input, key) => {
      if (key.ctrl && key.name === "c") {
        process.stdout.write("\n");
        process.exit(0);
      }

      if (key.ctrl && key.name === "j") {
        this.input.editor.handleNewline();
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
        return;
      }

      if (key.name === "return") {
        this.input.editor.submit(this.input.bus, this.input.sessionId ?? "local-session");
        return;
      }

      if (key.name === "pageup") {
        this.input.bus.emit(createMessageViewportChangedEvent({
          sessionId: this.input.sessionId ?? "local-session",
          offset: -10
        }));
        return;
      }

      if (key.name === "pagedown") {
        this.input.bus.emit(createMessageViewportChangedEvent({
          sessionId: this.input.sessionId ?? "local-session",
          offset: 10
        }));
        return;
      }

      if (key.ctrl && key.name === "up") {
        this.input.bus.emit(createMessageViewportChangedEvent({
          sessionId: this.input.sessionId ?? "local-session",
          offset: -3
        }));
        return;
      }

      if (key.ctrl && key.name === "down") {
        this.input.bus.emit(createMessageViewportChangedEvent({
          sessionId: this.input.sessionId ?? "local-session",
          offset: 3
        }));
        return;
      }

      if (key.name === "backspace") {
        this.input.editor.handleBackspace();
      } else if (key.name === "left") {
        this.input.editor.handleLeft();
      } else if (key.name === "right") {
        this.input.editor.handleRight();
      } else if (!key.ctrl && !key.meta && input) {
        this.input.editor.handlePrintable(input);
      } else {
        return;
      }

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
    });
  }
}
