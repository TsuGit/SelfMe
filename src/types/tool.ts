import type { ApprovalRisk } from "./approval.js";

export type ToolApprovalPolicy = "always" | "on-risk" | "never";

export interface ToolApprovalDescriptor {
  title: string;
  reason: string;
  risk: ApprovalRisk;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  approvalPolicy: ToolApprovalPolicy;
  buildApproval?(input: unknown): ToolApprovalDescriptor;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  taskId?: string;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => Promise<void> | void;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  structuredOutput?: unknown;
  rawLogs?: {
    stdout?: string;
    stderr?: string;
  };
  exitCode?: number;
  errorMessage?: string;
}

export interface ToolImplementation<TInput = unknown> extends ToolDefinition {
  invoke(input: TInput, context: ToolContext): Promise<ToolResult>;
}
