import type { EventBus } from "../app/event-bus.js";
import { listCommandPaletteItems } from "../runtime/commands.js";
import { createTerminalCommandInvokedEvent } from "../runtime/events.js";
import type { TerminalMessageBlock } from "./layout.js";

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
  query?: string;
  options: TerminalPanelOption[];
  selectedIndex: number;
}

interface ApprovalItem {
  key: string;
  label: string;
  detail?: string;
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
        detail: deriveActionContext(message),
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

    const commandPanel = buildCommandPanel(editorValue);

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
    const commandPanel = buildCommandPanel(editorValue);

    if (commandPanel && this.suppressedCommandValue !== editorValue) {
      return {
        ...commandPanel,
        selectedIndex: getSelectedIndex(commandPanel.options, this.selectedCommandKey)
      };
    }

    if (this.approvals.length > 0 && !this.approvalSuppressed) {
      return {
        mode: "approval",
        title: "Approval Required",
        subtitle: this.approvals[0]?.detail,
        options: this.approvals.map((item) => ({
          key: item.key,
          label: item.label,
          detail: item.detail,
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
    return this.getState(editorValue).mode !== "idle";
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

    if (!item) {
      return undefined;
    }

    if (!item.requiresInput) {
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

function buildCommandPanel(editorValue: string): TerminalPanelState | undefined {
  const query = deriveSlashQuery(editorValue);

  if (query === undefined) {
    return undefined;
  }

  const options = filterCommandItems(query).map((item) => ({
    key: item.key,
    label: item.command,
    detail: item.summary,
    style: "secondary" as const
  }));

  return {
    mode: "command",
    title: "Commands",
    subtitle: options.length > 0 ? "Type to filter commands" : "No matching commands",
    query,
    options,
    selectedIndex: 0
  };
}

function filterCommandItems(query: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return listCommandPaletteItems();
  }

  return listCommandPaletteItems().filter((item) =>
    item.command.slice(1).toLowerCase().startsWith(normalized) ||
    item.summary.toLowerCase().includes(normalized)
  );
}

function deriveSlashQuery(value: string) {
  if (!value.startsWith("/")) {
    return undefined;
  }

  if (value.includes("\n")) {
    return undefined;
  }

  return value.slice(1);
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

function deriveActionContext(message: TerminalMessageBlock) {
  const [headline] = message.body.split("\n");

  if (!headline) {
    return message.title || "Action";
  }

  return headline;
}
