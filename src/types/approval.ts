export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  taskId?: string;
  toolName: string;
  input?: unknown;
  reason: string;
  risk: ApprovalRisk;
  createdAt: string;
}

export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  taskId?: string;
  approved: boolean;
  resolvedAt: string;
}
