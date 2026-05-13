import type { ApprovalRisk } from "./approval.js";
import type { TaskState } from "./task.js";

export interface ToolCheckpointRecord {
  taskId?: string;
  toolName: string;
  status: "running" | "completed";
  summary?: string;
  updatedAt: string;
}

export interface ApprovalCheckpointRecord {
  approvalId: string;
  taskId?: string;
  toolName: string;
  reason: string;
  risk: ApprovalRisk;
  createdAt: string;
}

export interface TaskCheckpointRecord {
  taskId: string;
  title: string;
  state: TaskState;
  updatedAt: string;
}

export interface SessionCheckpoint {
  sessionId: string;
  title: string;
  version: string;
  model: string;
  cwd?: string;
  updatedAt: string;
  compactedSummary?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  latestTask?: TaskCheckpointRecord;
  pendingApproval?: ApprovalCheckpointRecord;
  recentTools: ToolCheckpointRecord[];
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolExecutions: number;
    errors: number;
  };
}
