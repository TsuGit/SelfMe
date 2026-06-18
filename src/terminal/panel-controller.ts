import type { EventBus } from "../app/event-bus.js";
import {
  listCommandPaletteItems,
  type CommandPaletteItem
} from "../runtime/commands.js";
import { createTerminalCommandInvokedEvent } from "../runtime/events.js";
import type { TerminalMessageBlock } from "./message-types.js";

export interface TerminalPanelOption {
  key: string;
  label: string;
  detail?: string;
  style?: "primary" | "secondary" | "danger";
  command?: string;
}

export interface TerminalPanelState {
  mode: "idle" | "approval" | "command";
  title?: string;
  subtitle?: string;
  description?: string;
  confirmLabel?: string;
  query?: string;
  options: TerminalPanelOption[];
  selectedIndex: number;
}

interface ApprovalItem {
  key: string;
  label: string;
  toolName?: string;
  reason?: string;
  risk?: string;
  command: string;
  style?: "primary" | "secondary" | "danger";
}

export class TerminalPanelController {
  private approvals: ApprovalItem[] = [];
  private approvalSuppressed = false;
  private selectedApprovalKey?: string;
  private selectedCommandKey?: string;
  private suppressedCommandValue?: string;

  sync(messages: TerminalMessageBlock[], editorValue: string) {
    const previousSignature = this.approvals.map((item) => item.key).join("|");
    const nextApprovals = messages.flatMap((message) => {
      if (!message.actions?.length) {
        return [];
      }

      return message.actions.map((action) => ({
        key: getActionKey(message, action.id),
        label: action.label,
        toolName: message.approvalContext?.toolName,
        reason: message.approvalContext?.reason,
        risk: message.approvalContext?.risk,
        command: action.command,
        style: action.style
      }));
    });

    this.approvals = nextApprovals;
    const nextSignature = this.approvals.map((item) => item.key).join("|");

    if (this.approvals.length === 0) {
      this.approvalSuppressed = false;
      this.selectedApprovalKey = undefined;
    } else {
      if (previousSignature !== nextSignature) {
        this.approvalSuppressed = false;
      }

      if (!this.selectedApprovalKey || !this.approvals.some((item) => item.key === this.selectedApprovalKey)) {
        this.selectedApprovalKey = this.approvals[0]?.key;
      }
    }

    const commandPanel = buildCommandPanel(editorValue, this.selectedCommandKey);

    if (!commandPanel) {
      this.selectedCommandKey = undefined;
      this.suppressedCommandValue = undefined;
      return;
    }

    if (this.suppressedCommandValue && this.suppressedCommandValue !== editorValue) {
      this.suppressedCommandValue = undefined;
    }

    if (!commandPanel.options.some((option) => option.key === this.selectedCommandKey)) {
      this.selectedCommandKey = commandPanel.options[0]?.key;
    }
  }

  getState(editorValue: string): TerminalPanelState {
    const commandPanel = buildCommandPanel(editorValue, this.selectedCommandKey);

    if (commandPanel && this.suppressedCommandValue !== editorValue) {
      return {
        ...commandPanel,
        selectedIndex: getSelectedIndex(commandPanel.options, this.selectedCommandKey)
      };
    }

    if (this.approvals.length > 0 && !this.approvalSuppressed) {
      const current = this.approvals[getSelectedIndex(this.approvals, this.selectedApprovalKey)];
      const descriptionLines = [
        current?.reason,
        current?.risk ? `Risk · ${current.risk}` : undefined
      ].filter(Boolean);

      return {
        mode: "approval",
        title: "Approval Required",
        subtitle: current?.toolName,
        description: descriptionLines.join("\n"),
        confirmLabel: current?.label.toLowerCase(),
        options: this.approvals.map((item) => ({
          key: item.key,
          label: item.label,
          style: item.style,
          command: item.command
        })),
        selectedIndex: getSelectedIndex(this.approvals, this.selectedApprovalKey)
      };
    }

    return {
      mode: "idle",
      options: [],
      selectedIndex: 0
    };
  }

  hasOpenPanel(editorValue: string) {
    const panel = this.getState(editorValue);
    return panel.mode !== "idle" && panel.options.length > 0;
  }

  focusNext(editorValue: string) {
    const panel = this.getState(editorValue);

    if (panel.mode === "idle" || panel.options.length === 0) {
      return false;
    }

    const nextIndex = (panel.selectedIndex + 1) % panel.options.length;
    this.setSelectedKey(panel.mode, panel.options[nextIndex]?.key);
    return true;
  }

  focusPrevious(editorValue: string) {
    const panel = this.getState(editorValue);

    if (panel.mode === "idle" || panel.options.length === 0) {
      return false;
    }

    const nextIndex = (panel.selectedIndex - 1 + panel.options.length) % panel.options.length;
    this.setSelectedKey(panel.mode, panel.options[nextIndex]?.key);
    return true;
  }

  clear(editorValue: string) {
    const panel = this.getState(editorValue);

    if (panel.mode === "command") {
      this.suppressedCommandValue = editorValue;
      return true;
    }

    if (panel.mode === "approval") {
      this.approvalSuppressed = true;
      return true;
    }

    return false;
  }

  submit(bus: EventBus, sessionId: string, editorValue: string) {
    const panel = this.getState(editorValue);

    if (panel.mode === "idle") {
      return false;
    }

    const selected = panel.options[panel.selectedIndex];

    if (!selected) {
      return false;
    }

    if (panel.mode === "command") {
      const item = listCommandPaletteItems().find((entry) => entry.key === selected.key);

      if (!item) {
        return false;
      }

      if (item.requiresInput) {
        return false;
      }

      bus.emit(createTerminalCommandInvokedEvent({
        sessionId,
        content: item.command
      }));
      this.selectedCommandKey = undefined;
      return true;
    }

    if (!selected.command) {
      return false;
    }

    bus.emit(createTerminalCommandInvokedEvent({
      sessionId,
      content: selected.command
    }));
    this.approvalSuppressed = false;
    return true;
  }

  getCommandInsertion(editorValue: string) {
    const panel = this.getState(editorValue);

    if (panel.mode !== "command") {
      return undefined;
    }

    const selected = panel.options[panel.selectedIndex];

    if (!selected) {
      return undefined;
    }

    const item = listCommandPaletteItems().find((entry) => entry.key === selected.key);

    if (!item || !shouldInsertCommand(item, editorValue)) {
      return undefined;
    }

    return item.command;
  }

  acceptCommandInsertion(value: string) {
    this.suppressedCommandValue = value;
  }

  private setSelectedKey(mode: TerminalPanelState["mode"], key?: string) {
    if (!key) {
      return;
    }

    if (mode === "command") {
      this.selectedCommandKey = key;
      return;
    }

    if (mode === "approval") {
      this.selectedApprovalKey = key;
    }
  }
}

function buildCommandPanel(editorValue: string, selectedKey?: string): TerminalPanelState | undefined {
  const query = deriveSlashQuery(editorValue);

  if (query === undefined) {
    return undefined;
  }

  const items = filterCommandItems(query);
  const options = items.map((item) => ({
    key: item.key,
    label: item.display,
    detail: item.summary,
    style: "secondary" as const
  }));

  if (options.length === 0) {
    return undefined;
  }

  const selectedIndex = getSelectedIndex(options, selectedKey);
  const selectedItem = items[selectedIndex] ?? items[0];
  const descriptionLines = [
    selectedItem?.usage ? `Usage · ${selectedItem.usage}` : undefined,
    selectedItem?.hint
  ].filter(Boolean);

  return {
    mode: "command",
    title: "Commands",
    subtitle: undefined,
    description: descriptionLines.join("\n"),
    confirmLabel: selectedItem?.requiresInput ? "insert" : "run",
    query,
    options,
    selectedIndex
  };
}

function filterCommandItems(query: string) {
  const normalized = query.toLowerCase();

  if (!normalized) {
    return listCommandPaletteItems();
  }

  const commandToken = normalized.trimStart().split(/\s+/, 1)[0] ?? "";

  if (!commandToken) {
    return listCommandPaletteItems();
  }

  return listCommandPaletteItems().filter((item) =>
    getCommandToken(item).startsWith(commandToken)
  );
}

function deriveSlashQuery(value: string) {
  if (!value.startsWith("/")) {
    return undefined;
  }

  if (value.includes("\n")) {
    return undefined;
  }

  if (/\s/.test(value.slice(1))) {
    return undefined;
  }

  return value.slice(1);
}

function shouldInsertCommand(item: CommandPaletteItem, editorValue: string) {
  if (!item.requiresInput) {
    return false;
  }

  const trimmedLeft = editorValue.trimStart();
  const typedWithoutSlash = trimmedLeft.startsWith("/") ? trimmedLeft.slice(1) : trimmedLeft;
  const typedCommand = typedWithoutSlash.trim();

  if (!typedCommand) {
    return true;
  }

  return getCommandToken(item).startsWith(typedCommand.toLowerCase());
}

function getSelectedIndex(options: Array<{ key: string }>, selectedKey?: string) {
  if (!selectedKey) {
    return 0;
  }

  const index = options.findIndex((option) => option.key === selectedKey);
  return index === -1 ? 0 : index;
}

function getActionKey(message: Pick<TerminalMessageBlock, "approvalId" | "taskId">, actionId: string) {
  return `${message.approvalId ?? message.taskId ?? "message"}:${actionId}`;
}

function getCommandToken(item: CommandPaletteItem) {
  return item.command.slice(1).trimEnd().toLowerCase();
}
