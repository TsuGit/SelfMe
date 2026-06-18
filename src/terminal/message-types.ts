export interface TerminalMessageBlock {
  kind?: "welcome" | "user" | "assistant" | "assistant-working" | "system" | "tool" | "approval" | "error" | "divider";
  title: string;
  body: string;
  taskId?: string;
  stepIndex?: number;
  approvalId?: string;
  approvalContext?: {
    toolName: string;
    reason: string;
    risk: string;
  };
  actions?: Array<{
    id: string;
    label: string;
    command: string;
    style?: "primary" | "secondary" | "danger";
  }>;
}
