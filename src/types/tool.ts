export type ToolApprovalPolicy = "always" | "on-risk" | "never";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  approvalPolicy: ToolApprovalPolicy;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  taskId?: string;
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
