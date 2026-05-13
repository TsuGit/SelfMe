import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { EditorController } from "../editor/composer.js";
import {
  createMessageViewportChangedEvent,
  createTerminalCommandInvokedEvent,
  createTerminalUiStateChangedEvent
} from "../runtime/events.js";
import type { TerminalPanelController } from "./panel-controller.js";
import { parseTerminalInput } from "./input-parser.js";

export class TerminalEventLoop {
  constructor(
    private readonly input: {
      bus: EventBus;
      editor: EditorController;
      panel: TerminalPanelController;
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
          if (this.input.panel.hasOpenPanel(this.input.editor.getState().value)) {
            continue;
          }

          this.input.editor.handleNewline();
          this.emitEditorState();
          continue;
        }

        if (event.type === "submit") {
          const currentValue = this.input.editor.getState().value;
          const commandInsertion = this.input.panel.getCommandInsertion(currentValue);

          if (commandInsertion && commandInsertion !== currentValue) {
            this.input.editor.setValue(commandInsertion);
            this.input.panel.acceptCommandInsertion(commandInsertion);
            this.emitEditorState();
            this.emitUiState();
            continue;
          }

          if (this.input.panel.submit(this.input.bus, this.input.sessionId ?? "local-session", currentValue)) {
            this.emitUiState();
            continue;
          }

          if (isSlashCommand(currentValue)) {
            this.input.bus.emit(createTerminalCommandInvokedEvent({
              sessionId: this.input.sessionId ?? "local-session",
              content: currentValue.trim()
            }));
            this.input.editor.setValue("");
            this.emitEditorState();
            this.emitUiState();
            continue;
          }

          this.input.editor.submit(this.input.bus, this.input.sessionId ?? "local-session");
          continue;
        }

        if (event.type === "action-next") {
          if (this.input.panel.focusNext(this.input.editor.getState().value)) {
            this.emitUiState();
            continue;
          }
        }

        if (event.type === "action-prev") {
          if (this.input.panel.focusPrevious(this.input.editor.getState().value)) {
            this.emitUiState();
            continue;
          }
        }

        if (event.type === "action-cancel") {
          if (this.input.panel.clear(this.input.editor.getState().value)) {
            this.emitUiState();
            continue;
          }
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
          if (this.input.panel.hasOpenPanel(this.input.editor.getState().value)) {
            continue;
          }

          this.input.editor.handleLeft();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-right") {
          if (this.input.panel.hasOpenPanel(this.input.editor.getState().value)) {
            continue;
          }

          this.input.editor.handleRight();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-up") {
          if (this.input.panel.hasOpenPanel(this.input.editor.getState().value)) {
            if (this.input.panel.focusPrevious(this.input.editor.getState().value)) {
              this.emitUiState();
            }
            continue;
          }

          this.input.editor.handleUp();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-down") {
          if (this.input.panel.hasOpenPanel(this.input.editor.getState().value)) {
            if (this.input.panel.focusNext(this.input.editor.getState().value)) {
              this.emitUiState();
            }
            continue;
          }

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

  private emitUiState() {
    this.input.bus.emit(createTerminalUiStateChangedEvent({
      sessionId: this.input.sessionId ?? "local-session"
    }));
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

function isSlashCommand(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("/") && !trimmed.includes("\n");
}
