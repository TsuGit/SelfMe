import { randomUUID } from "node:crypto";

import type {
  AssistantCompletedEvent,
  AssistantDeltaReceivedEvent,
  AssistantStreamStartedEvent,
  MessageViewportChangedEvent,
  TerminalCommandInvokedEvent,
  RuntimeInterruptRequestedEvent,
  RuntimeBusyStateChangedEvent,
  TerminalUiStateChangedEvent,
  SystemMessageAppendedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  RuntimeErrorRaisedEvent,
  TaskStateChangedEvent,
  ToolExecutionCompletedEvent,
  ToolExecutionRequestedEvent,
  ToolExecutionStartedEvent,
  UserMessageSubmittedEvent
} from "../types/events.js";
import type { TaskState } from "../types/task.js";

function createBase<TType extends string>(input: {
  sessionId: string;
  taskId?: string;
  source: "user" | "runtime" | "provider" | "tool" | "system";
  type: TType;
}) {
  return {
    eventId: randomUUID(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    timestamp: new Date().toISOString(),
    source: input.source,
    type: input.type
  };
}

export function createUserMessageSubmittedEvent(input: {
  sessionId: string;
  content: string;
}): UserMessageSubmittedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "user",
      type: "user.message.submitted"
    }),
    payload: {
      content: input.content
    }
  };
}

export function createSystemMessageAppendedEvent(input: {
  sessionId: string;
  taskId?: string;
  title: string;
  content: string;
}): SystemMessageAppendedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "system",
      type: "system.message.appended"
    }),
    payload: {
      title: input.title,
      content: input.content
    }
  };
}

export function createMessageViewportChangedEvent(input: {
  sessionId: string;
  offset: number;
}): MessageViewportChangedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "user",
      type: "message.viewport.changed"
    }),
    payload: {
      offset: input.offset
    }
  };
}

export function createTerminalUiStateChangedEvent(input: {
  sessionId: string;
}): TerminalUiStateChangedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "user",
      type: "terminal.ui.state.changed"
    }),
    payload: {}
  };
}

export function createTerminalCommandInvokedEvent(input: {
  sessionId: string;
  content: string;
}): TerminalCommandInvokedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "user",
      type: "terminal.command.invoked"
    }),
    payload: {
      content: input.content
    }
  };
}

export function createRuntimeInterruptRequestedEvent(input: {
  sessionId: string;
  reason: "cancel" | "quit" | "command";
}): RuntimeInterruptRequestedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "user",
      type: "runtime.interrupt.requested"
    }),
    payload: {
      reason: input.reason
    }
  };
}

export function createRuntimeBusyStateChangedEvent(input: {
  sessionId: string;
  active: boolean;
  phase: "idle" | "assistant" | "tool" | "approval";
}): RuntimeBusyStateChangedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      source: "runtime",
      type: "runtime.busy.changed"
    }),
    payload: {
      active: input.active,
      phase: input.phase
    }
  };
}

export function createAssistantStartedEvent(input: {
  sessionId: string;
  taskId: string;
}): AssistantStreamStartedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "runtime",
      type: "assistant.stream.started"
    }),
    payload: {}
  };
}

export function createAssistantDeltaEvent(input: {
  sessionId: string;
  taskId: string;
  delta: string;
}): AssistantDeltaReceivedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "provider",
      type: "assistant.delta.received"
    }),
    payload: {
      delta: input.delta
    }
  };
}

export function createAssistantCompletedEvent(input: {
  sessionId: string;
  taskId: string;
  model: string;
}): AssistantCompletedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "provider",
      type: "assistant.completed"
    }),
    payload: {
      model: input.model
    }
  };
}

export function createToolExecutionRequestedEvent(input: {
  sessionId: string;
  taskId?: string;
  toolName: string;
  input: unknown;
}): ToolExecutionRequestedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "runtime",
      type: "tool.execution.requested"
    }),
    payload: {
      toolName: input.toolName,
      input: input.input
    }
  };
}

export function createToolStdoutAppendedEvent(input: {
  sessionId: string;
  taskId?: string;
  toolName: string;
  chunk: string;
}) {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "tool",
      type: "tool.stdout.appended"
    }),
    payload: {
      toolName: input.toolName,
      chunk: input.chunk
    }
  } as const;
}

export function createToolExecutionCompletedEvent(input: {
  sessionId: string;
  taskId?: string;
  toolName: string;
  summary: string;
  rawOutput?: string;
}) {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "tool",
      type: "tool.execution.completed"
    }),
    payload: {
      toolName: input.toolName,
      summary: input.summary,
      rawOutput: input.rawOutput
    }
  } as const;
}

export function createToolExecutionStartedEvent(input: {
  sessionId: string;
  taskId?: string;
  toolName: string;
}): ToolExecutionStartedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "tool",
      type: "tool.execution.started"
    }),
    payload: {
      toolName: input.toolName
    }
  };
}

export function createApprovalRequestedEvent(input: {
  sessionId: string;
  taskId?: string;
  toolName: string;
  input?: unknown;
  reason: string;
  risk: "low" | "medium" | "high";
}): ApprovalRequestedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "runtime",
      type: "approval.requested"
    }),
    payload: {
      approvalId: randomUUID(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolName: input.toolName,
      input: input.input,
      reason: input.reason,
      risk: input.risk,
      createdAt: new Date().toISOString()
    }
  };
}

export function createApprovalResolvedEvent(input: {
  sessionId: string;
  taskId?: string;
  approvalId: string;
  approved: boolean;
}): ApprovalResolvedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "user",
      type: "approval.resolved"
    }),
    payload: {
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      approved: input.approved,
      resolvedAt: new Date().toISOString()
    }
  };
}

export function createTaskStateChangedEvent(input: {
  sessionId: string;
  taskId: string;
  title: string;
  state: TaskState;
}): TaskStateChangedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "runtime",
      type: "task.state.changed"
    }),
    payload: {
      title: input.title,
      state: input.state
    }
  };
}

export function createRuntimeErrorRaisedEvent(input: {
  sessionId: string;
  taskId?: string;
  message: string;
}): RuntimeErrorRaisedEvent {
  return {
    ...createBase({
      sessionId: input.sessionId,
      taskId: input.taskId,
      source: "system",
      type: "runtime.error.raised"
    }),
    payload: {
      message: input.message
    }
  };
}
