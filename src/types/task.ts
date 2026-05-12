export type TaskState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  parentTaskId?: string;
  title: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

