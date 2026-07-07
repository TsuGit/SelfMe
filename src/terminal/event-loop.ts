import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { EditorController } from "../editor/composer.js";
import { getIncompleteSlashCommandNotice } from "../runtime/commands.js";
import {
  createMessageViewportChangedEvent,
  createRuntimeErrorRaisedEvent,
  createRuntimeInterruptRequestedEvent,
  createSystemMessageAppendedEvent,
  createTerminalCommandInvokedEvent,
  createTerminalUiStateChangedEvent
} from "../runtime/events.js";
import type { TerminalPanelController } from "./panel-controller.js";
import { parseTerminalInput } from "./input-parser.js";
import type { LinearTerminalRenderer } from "./linear-renderer.js";

export class TerminalEventLoop {
  private isBusy = false;
  private inputListener?: (chunk: Buffer | string) => void;
  private processExitListener?: () => void;
  private cleanedUp = false;

  constructor(
    private readonly input: {
      bus: EventBus;
      editor: EditorController;
      panel: TerminalPanelController;
      renderer?: LinearTerminalRenderer;
      sessionId?: string;
    }
  ) {}

  start() {
    this.input.bus.on("runtime.busy.changed", (event) => {
      this.isBusy = event.payload.active;
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    enableExtendedKeyboardReporting();
    process.stdin.resume();
    this.input.bus.on("terminal.command.invoked", (event) => {
      if (event.sessionId !== (this.input.sessionId ?? "local-session")) {
        return;
      }

      if (event.payload.content.trim() === "/exit") {
        this.shutdown(0);
      }
    });

    this.inputListener = (chunk) => {
      for (const event of parseTerminalInput(chunk)) {
        const currentValue = this.input.editor.getState().value;
        const panelState = this.input.panel.getState(currentValue);
        const approvalPanelOpen = panelState.mode === "approval";

        if (event.type === "quit") {
          if (this.hasInterruptibleTask()) {
            this.input.bus.emit(createRuntimeInterruptRequestedEvent({
              sessionId: this.input.sessionId ?? "local-session",
              reason: "quit"
            }));
            continue;
          }

          this.shutdown(0);
          return;
        }

        if (event.type === "newline") {
          if (approvalPanelOpen || panelState.mode === "command") {
            continue;
          }

          this.input.editor.handleNewline();
          this.emitEditorState();
          continue;
        }

        if (event.type === "submit") {
          const commandInsertion = this.input.panel.getCommandInsertion(currentValue);

          if (commandInsertion && commandInsertion !== currentValue) {
            this.input.editor.setValue(commandInsertion);
            this.input.panel.acceptCommandInsertion(commandInsertion);
            this.emitEditorState();
            this.emitUiState();
            continue;
          }

          if (this.input.panel.submit(this.input.bus, this.input.sessionId ?? "local-session", currentValue)) {
            if (panelState.mode === "command") {
              this.input.editor.setValue("");
              this.emitEditorState();
            }

            this.emitUiState();
            continue;
          }

          if (looksLikeSlashCommand(currentValue)) {
            const incompleteNotice = getIncompleteSlashCommandNotice(currentValue);

            if (incompleteNotice) {
              this.input.bus.emit(createRuntimeErrorRaisedEvent({
                sessionId: this.input.sessionId ?? "local-session",
                message: incompleteNotice.message
              }));
              continue;
            }

            const panel = this.input.panel.getState(currentValue);

            if (
              panel.mode === "command" &&
              panel.options.length > 0 &&
              !hasSlashArguments(currentValue)
            ) {
              continue;
            }

            this.input.bus.emit(createTerminalCommandInvokedEvent({
              sessionId: this.input.sessionId ?? "local-session",
              content: currentValue
            }));
            this.input.editor.setValue("");
            this.emitEditorState();
            this.emitUiState();
            continue;
          }

          if (this.hasInterruptibleTask()) {
            this.input.bus.emit(createSystemMessageAppendedEvent({
              sessionId: this.input.sessionId ?? "local-session",
              title: "Busy",
              content: "A task is still running. Press Esc, Ctrl+C, /stop, or /exit before sending a new message."
            }));
            continue;
          }

          this.input.editor.submit(this.input.bus, this.input.sessionId ?? "local-session");
          continue;
        }

        if (event.type === "action-next") {
          if (this.input.panel.focusNext(currentValue)) {
            this.emitUiState();
            continue;
          }
        }

        if (event.type === "action-prev") {
          if (this.input.panel.focusPrevious(currentValue)) {
            this.emitUiState();
            continue;
          }
        }

        if (event.type === "action-cancel") {
          if (this.input.panel.clear(currentValue)) {
            this.emitUiState();
            continue;
          }

          if (this.hasInterruptibleTask()) {
            this.input.bus.emit(createRuntimeInterruptRequestedEvent({
              sessionId: this.input.sessionId ?? "local-session",
              reason: "cancel"
            }));
          }

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
          if (approvalPanelOpen) {
            continue;
          }

          this.input.editor.handleBackspace();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-left") {
          if (approvalPanelOpen || panelState.mode === "command") {
            continue;
          }

          this.input.editor.handleLeft();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-right") {
          if (approvalPanelOpen || panelState.mode === "command") {
            continue;
          }

          this.input.editor.handleRight();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-up") {
          if (panelState.mode === "approval" || panelState.mode === "command") {
            if (this.input.panel.focusPrevious(currentValue)) {
              this.emitUiState();
            }
            continue;
          }

          this.input.editor.handleUp();
          this.emitEditorState();
          continue;
        }

        if (event.type === "move-down") {
          if (panelState.mode === "approval" || panelState.mode === "command") {
            if (this.input.panel.focusNext(currentValue)) {
              this.emitUiState();
            }
            continue;
          }

          this.input.editor.handleDown();
          this.emitEditorState();
          continue;
        }

        if (event.type === "text") {
          if (approvalPanelOpen) {
            continue;
          }

          this.input.editor.handlePrintable(event.value);
          this.emitEditorState();
        }
      }
    };
    process.stdin.on("data", this.inputListener);

    this.processExitListener = () => {
      this.cleanupTerminalState();
    };
    process.on("exit", this.processExitListener);
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

  private hasInterruptibleTask() {
    return this.isBusy || this.input.renderer?.hasInterruptibleVisualState() === true;
  }

  private shutdown(code: number) {
    this.cleanupTerminalState();
    process.stdout.write("\n");
    process.exit(code);
  }

  private cleanupTerminalState() {
    if (this.cleanedUp) {
      return;
    }

    this.cleanedUp = true;
    disableExtendedKeyboardReporting();

    if (this.inputListener) {
      process.stdin.off("data", this.inputListener);
      this.inputListener = undefined;
    }

    if (this.processExitListener) {
      process.off("exit", this.processExitListener);
      this.processExitListener = undefined;
    }

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore TTY teardown failures during shutdown.
      }
    }
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

function looksLikeSlashCommand(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("/");
}

function hasSlashArguments(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("/")) {
    return false;
  }

  const withoutSlash = trimmed.slice(1);
  const firstWhitespace = withoutSlash.search(/\s/);

  if (firstWhitespace === -1) {
    return false;
  }

  return withoutSlash.slice(firstWhitespace).trim().length > 0;
}
