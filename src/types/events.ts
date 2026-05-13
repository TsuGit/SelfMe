import type { ApprovalDecision, ApprovalRequest } from "./approval.js";
import type { TaskState } from "./task.js";

interface RuntimeEventBase<TType extends string, TPayload> {
  eventId: string;
  sessionId: string;
  taskId?: string;
  timestamp: string;
  source: "user" | "runtime" | "provider" | "tool" | "system";
  type: TType;
  payload: TPayload;
}

export type UserMessageSubmittedEvent = RuntimeEventBase<
  "user.message.submitted",
  { content: string }
>;

export type EditorStateChangedEvent = RuntimeEventBase<
  "editor.state.changed",
  { value: string; cursor: number }
>;

export type SystemMessageAppendedEvent = RuntimeEventBase<
  "system.message.appended",
  { title: string; content: string }
>;

export type MessageViewportChangedEvent = RuntimeEventBase<
  "message.viewport.changed",
  { offset: number }
>;

export type TerminalUiStateChangedEvent = RuntimeEventBase<
  "terminal.ui.state.changed",
  Record<string, never>
>;

export type TerminalCommandInvokedEvent = RuntimeEventBase<
  "terminal.command.invoked",
  { content: string }
>;

export type AssistantStreamStartedEvent = RuntimeEventBase<
  "assistant.stream.started",
  Record<string, never>
>;

export type AssistantDeltaReceivedEvent = RuntimeEventBase<
  "assistant.delta.received",
  { delta: string }
>;

export type AssistantCompletedEvent = RuntimeEventBase<
  "assistant.completed",
  { model: string }
>;

export type ToolExecutionRequestedEvent = RuntimeEventBase<
  "tool.execution.requested",
  { toolName: string; input: unknown }
>;

export type ToolExecutionStartedEvent = RuntimeEventBase<
  "tool.execution.started",
  { toolName: string }
>;

export type ToolExecutionCompletedEvent = RuntimeEventBase<
  "tool.execution.completed",
  { toolName: string; summary: string; rawOutput?: string }
>;

export type ToolStdoutAppendedEvent = RuntimeEventBase<
  "tool.stdout.appended",
  { toolName: string; chunk: string }
>;

export type ApprovalRequestedEvent = RuntimeEventBase<
  "approval.requested",
  ApprovalRequest
>;

export type ApprovalResolvedEvent = RuntimeEventBase<
  "approval.resolved",
  ApprovalDecision
>;

export type TaskStateChangedEvent = RuntimeEventBase<
  "task.state.changed",
  { title: string; state: TaskState }
>;

export type RuntimeErrorRaisedEvent = RuntimeEventBase<
  "runtime.error.raised",
  { message: string }
>;

export type RuntimeEvent =
  | UserMessageSubmittedEvent
  | EditorStateChangedEvent
  | SystemMessageAppendedEvent
  | MessageViewportChangedEvent
  | TerminalUiStateChangedEvent
  | TerminalCommandInvokedEvent
  | AssistantStreamStartedEvent
  | AssistantDeltaReceivedEvent
  | AssistantCompletedEvent
  | ToolExecutionRequestedEvent
  | ToolExecutionStartedEvent
  | ToolStdoutAppendedEvent
  | ToolExecutionCompletedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | TaskStateChangedEvent
  | RuntimeErrorRaisedEvent;
