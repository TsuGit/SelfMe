import type { TaskRecord, TaskState } from "../types/task.js";
import type { RuntimeEvent } from "../types/events.js";

export class TaskController {
  private readonly tasks = new Map<string, TaskRecord>();

  upsert(input: {
    taskId: string;
    sessionId: string;
    title: string;
    state: TaskState;
    timestamp?: string;
    parentTaskId?: string;
  }) {
    const now = input.timestamp ?? new Date().toISOString();
    const previous = this.tasks.get(input.taskId);
    const next: TaskRecord = previous
      ? {
          ...previous,
          title: input.title,
          state: input.state,
          updatedAt: now
        }
      : {
          taskId: input.taskId,
          sessionId: input.sessionId,
          parentTaskId: input.parentTaskId,
          title: input.title,
          state: input.state,
          createdAt: now,
          updatedAt: now
        };

    this.tasks.set(input.taskId, next);
    return next;
  }

  listBySession(sessionId: string) {
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getActiveBySession(sessionId: string) {
    return this.listBySession(sessionId)
      .filter((task) => task.state === "running" || task.state === "pending" || task.state === "waiting_approval");
  }

  getLatestBySession(sessionId: string) {
    return this.listBySession(sessionId)[0];
  }

  restoreFromEvents(events: RuntimeEvent[]) {
    for (const event of events) {
      if (event.type !== "task.state.changed" || !event.taskId) {
        continue;
      }

      this.upsert({
        taskId: event.taskId,
        sessionId: event.sessionId,
        title: event.payload.title,
        state: event.payload.state,
        timestamp: event.timestamp
      });
    }
  }
}
