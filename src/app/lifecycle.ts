import type { EventBus } from "./event-bus.js";
import type { AgentRuntime } from "../runtime/agent.js";
import type { TerminalRenderer } from "../terminal/renderer.js";
import type { TerminalEventLoop } from "../terminal/event-loop.js";
import type { CheckpointStore } from "../storage/checkpoints.js";
import type { SessionStore } from "../storage/sessions.js";
import type { SettingsStore } from "../storage/settings.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import { projectSessionTimeline, summarizeTimelineEntries } from "../runtime/context-compaction.js";
import type { SessionCheckpoint } from "../types/checkpoint.js";
import type { RuntimeEvent } from "../types/events.js";
import type { SessionRecord } from "../types/session.js";

export class AppLifecycle {
  private sessionPersistChain = Promise.resolve();
  private checkpointPersistChain = Promise.resolve();
  private checkpoint?: SessionCheckpoint;

  constructor(
    private readonly input: {
      bus: EventBus;
      runtime: AgentRuntime;
      renderer: TerminalRenderer;
      terminal: TerminalEventLoop;
      settings: SettingsStore;
      transcriptStore: TranscriptStore;
      sessionStore: SessionStore;
      checkpointStore: CheckpointStore;
      session: SessionRecord;
    }
  ) {
  }

  async start() {
    await this.input.transcriptStore.ensureInitialized();
    await this.input.checkpointStore.ensureInitialized();
    this.checkpoint = await this.loadCheckpoint();
    await this.input.checkpointStore.upsert(cloneCheckpoint(this.checkpoint));
    this.input.bus.on("user.message.submitted", (event) => {
      this.persistSession((session) => {
        if (session.title === "New session") {
          const derivedTitle = deriveSessionTitle(event.payload.content);

          if (derivedTitle) {
            session.title = derivedTitle;
          }
        }

        session.updatedAt = new Date().toISOString();
      });
    });
    this.input.bus.onAny((event) => {
      if (!shouldCheckpointEvent(event)) {
        return;
      }

      this.persistCheckpoint(event);
    });

    await this.input.renderer.start();
    await this.input.runtime.start();
    this.input.terminal.start();
  }

  private persistSession(mutator: (session: SessionRecord) => void) {
    this.sessionPersistChain = this.sessionPersistChain
      .then(async () => {
        mutator(this.input.session);
        await this.input.sessionStore.upsert({ ...this.input.session });
      })
      .catch((error) => {
        process.stderr.write(`Failed to persist session metadata: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }

  private persistCheckpoint(event: RuntimeEvent) {
    this.checkpointPersistChain = this.checkpointPersistChain
      .then(async () => {
        if (!this.checkpoint) {
          this.checkpoint = await this.loadCheckpoint();
        }

        if (!this.checkpoint) {
          return;
        }

        applyCheckpointEvent(this.checkpoint, event, this.input.session);
        const transcriptEvents = await this.input.transcriptStore.readEventsBySession(this.input.session.sessionId);
        const timeline = projectSessionTimeline(transcriptEvents);
        this.checkpoint.compactedSummary = summarizeTimelineEntries(timeline.slice(0, -8)) || undefined;
        await this.input.checkpointStore.upsert(cloneCheckpoint(this.checkpoint));
      })
      .catch((error) => {
        process.stderr.write(`Failed to persist checkpoint: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }

  private async loadCheckpoint() {
    const stored = await this.input.checkpointStore.getLatest(this.input.session.sessionId);

    if (!stored) {
      return createInitialCheckpoint(this.input.session);
    }

    return {
      ...stored,
      title: this.input.session.title,
      version: this.input.session.version,
      model: this.input.session.model,
      cwd: this.input.session.cwd
    };
  }
}

function deriveSessionTitle(content: string) {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine || firstLine.startsWith("/")) {
    return "";
  }

  const normalized = firstLine.replace(/\s+/g, " ").trim();
  const maxLength = 56;

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function createInitialCheckpoint(session: SessionRecord): SessionCheckpoint {
  return {
    sessionId: session.sessionId,
    title: session.title,
    version: session.version,
    model: session.model,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    recentTools: [],
    stats: {
      userMessages: 0,
      assistantMessages: 0,
      toolExecutions: 0,
      errors: 0
    }
  };
}

function cloneCheckpoint(checkpoint: SessionCheckpoint): SessionCheckpoint {
  return {
    ...checkpoint,
    stats: { ...checkpoint.stats },
    recentTools: checkpoint.recentTools.map((tool) => ({ ...tool })),
    latestTask: checkpoint.latestTask ? { ...checkpoint.latestTask } : undefined,
    pendingApproval: checkpoint.pendingApproval ? { ...checkpoint.pendingApproval } : undefined
  };
}

function shouldCheckpointEvent(event: RuntimeEvent) {
  return event.type !== "editor.state.changed" &&
    event.type !== "message.viewport.changed" &&
    event.type !== "terminal.ui.state.changed";
}

function applyCheckpointEvent(checkpoint: SessionCheckpoint, event: RuntimeEvent, session: SessionRecord) {
  checkpoint.title = session.title;
  checkpoint.version = session.version;
  checkpoint.model = session.model;
  checkpoint.cwd = session.cwd;
  checkpoint.updatedAt = event.timestamp;

  if (event.type === "user.message.submitted") {
    checkpoint.lastUserMessage = createPreview(event.payload.content);
    checkpoint.stats.userMessages += 1;
    checkpoint.lastAssistantMessage = "";
    return;
  }

  if (event.type === "assistant.delta.received") {
    checkpoint.lastAssistantMessage = appendPreview(checkpoint.lastAssistantMessage, event.payload.delta);
    return;
  }

  if (event.type === "assistant.completed") {
    checkpoint.stats.assistantMessages += 1;
    return;
  }

  if (event.type === "task.state.changed" && event.taskId) {
    checkpoint.latestTask = {
      taskId: event.taskId,
      title: event.payload.title,
      state: event.payload.state,
      updatedAt: event.timestamp
    };
    return;
  }

  if (event.type === "approval.requested") {
    checkpoint.pendingApproval = {
      approvalId: event.payload.approvalId,
      taskId: event.payload.taskId,
      toolName: event.payload.toolName,
      reason: event.payload.reason,
      risk: event.payload.risk,
      createdAt: event.payload.createdAt
    };
    return;
  }

  if (event.type === "approval.resolved") {
    checkpoint.pendingApproval = undefined;
    return;
  }

  if (event.type === "tool.execution.started") {
    checkpoint.stats.toolExecutions += 1;
    checkpoint.recentTools = [
      {
        taskId: event.taskId,
        toolName: event.payload.toolName,
        status: "running" as const,
        updatedAt: event.timestamp
      },
      ...checkpoint.recentTools.filter((item) => !(item.taskId === event.taskId && item.toolName === event.payload.toolName))
    ].slice(0, 5);
    return;
  }

  if (event.type === "tool.execution.completed") {
    checkpoint.recentTools = [
      {
        taskId: event.taskId,
        toolName: event.payload.toolName,
        status: "completed" as const,
        summary: createPreview(event.payload.summary, 120),
        updatedAt: event.timestamp
      },
      ...checkpoint.recentTools.filter((item) => !(item.taskId === event.taskId && item.toolName === event.payload.toolName))
    ].slice(0, 5);
    return;
  }

  if (event.type === "runtime.error.raised") {
    checkpoint.stats.errors += 1;
  }
}

function createPreview(content: string, maxLength = 240) {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function appendPreview(current = "", delta: string, maxLength = 240) {
  if (!delta) {
    return current;
  }

  if (current.length >= maxLength) {
    return current;
  }

  const next = `${current}${delta}`;
  return next.length <= maxLength ? next : next.slice(0, maxLength);
}
