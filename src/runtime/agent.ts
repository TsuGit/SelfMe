import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { ProviderClient } from "../providers/base.js";
import type { ToolRegistry } from "../tools/base.js";
import type { ApprovalRequest } from "../types/approval.js";
import type { SessionRecord } from "../types/session.js";
import type { LogStore } from "../storage/logs.js";
import type { CheckpointStore } from "../storage/checkpoints.js";
import type { SessionStore } from "../storage/sessions.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import { parseBuiltInCommand, parseSessionCommand, parseToolCommand } from "./commands.js";
import {
  buildContextMessages,
  createInlinePreview,
  normalizeSearchText,
  projectSessionTimeline,
  renderTimelineEntry,
  summarizeTimelineEntries
} from "./context-compaction.js";
import { TaskController } from "./tasks.js";
import {
  createAssistantCompletedEvent,
  createAssistantDeltaEvent,
  createAssistantStartedEvent,
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createRuntimeErrorRaisedEvent,
  createSystemMessageAppendedEvent,
  createTaskStateChangedEvent,
  createToolExecutionRequestedEvent,
  createToolExecutionCompletedEvent,
  createToolExecutionStartedEvent,
  createToolStdoutAppendedEvent
} from "./events.js";

export class AgentRuntime {
  private readonly pendingApprovals = new Map<string, {
    request: ApprovalRequest;
    toolName: string;
    input: unknown;
  }>();
  private readonly resumableToolExecutions = new Map<string, {
    sessionId: string;
    taskId?: string;
    toolName: string;
    input: unknown;
    requestedAt: string;
  }>();
  private readonly tasks = new TaskController();
  private lastRetryableUserMessage?: string;

  constructor(
    private readonly input: {
      bus: EventBus;
      provider: ProviderClient;
      tools: ToolRegistry;
      session: SessionRecord;
      transcriptStore: TranscriptStore;
      logStore: LogStore;
      checkpointStore: CheckpointStore;
      sessionStore: SessionStore;
    }
  ) {}

  async start() {
    const restoredEvents = await this.input.transcriptStore.readEventsBySession(this.input.session.sessionId);
    this.tasks.restoreFromEvents(restoredEvents);
    this.restoreRetryableMessage(restoredEvents);
    this.restorePendingApprovals(restoredEvents);
    this.restoreResumableToolExecutions(restoredEvents);
    await this.announceRecoverySummary();

    this.input.bus.on("task.state.changed", (event) => {
      if (!event.taskId) {
        return;
      }

      this.tasks.upsert({
        taskId: event.taskId,
        sessionId: event.sessionId,
        title: event.payload.title,
        state: event.payload.state,
        timestamp: event.timestamp
      });

      if (
        event.payload.state === "completed" ||
        event.payload.state === "failed" ||
        event.payload.state === "cancelled"
      ) {
        this.resumableToolExecutions.delete(event.taskId);
      }
    });

    this.input.bus.on("tool.execution.requested", (event) => {
      if (!event.taskId) {
        return;
      }

      this.resumableToolExecutions.set(event.taskId, {
        sessionId: event.sessionId,
        taskId: event.taskId,
        toolName: event.payload.toolName,
        input: event.payload.input,
        requestedAt: event.timestamp
      });
    });

    this.input.bus.on("tool.execution.completed", (event) => {
      if (!event.taskId) {
        return;
      }

      this.resumableToolExecutions.delete(event.taskId);
    });

    this.input.bus.on("user.message.submitted", async (event) => {
      const handled = await this.handleCommandContent(event.sessionId, event.payload.content, true);

      if (handled) {
        return;
      }

      await this.input.transcriptStore.appendEvent(event);
      this.lastRetryableUserMessage = event.payload.content;
      await this.handleAssistantTurn(event.sessionId, event.payload.content);
    });

    this.input.bus.on("terminal.command.invoked", async (event) => {
      await this.handleCommandContent(event.sessionId, event.payload.content, false);
    });

    this.input.bus.on("approval.resolved", async (event) => {
      if (!event.payload.approved) {
        const taskState = createTaskStateChangedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId ?? randomUUID(),
          state: "cancelled",
          title: "Approval denied"
        });
        this.input.bus.emit(taskState);
        await this.input.transcriptStore.appendEvent(taskState);
      }
    });

    this.input.bus.on("tool.execution.requested", async (event) => {
      if (event.taskId) {
        this.input.bus.emit(createTaskStateChangedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          state: "running",
          title: `Run ${event.payload.toolName}`
        }));
      }

      const tool = this.input.tools.get(event.payload.toolName);

      if (!tool) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          message: `Unknown tool: ${event.payload.toolName}`
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);
        return;
      }

      const started = createToolExecutionStartedEvent({
        sessionId: event.sessionId,
        taskId: event.taskId,
        toolName: event.payload.toolName
      });
      this.input.bus.emit(started);
      await this.input.transcriptStore.appendEvent(started);

      try {
        const result = await tool.invoke(event.payload.input, {
          cwd: this.input.session.cwd ?? process.cwd(),
          sessionId: event.sessionId,
          taskId: event.taskId,
          onStdoutChunk: async (chunk) => {
            const stdoutEvent = createToolStdoutAppendedEvent({
              sessionId: event.sessionId,
              taskId: event.taskId,
              toolName: event.payload.toolName,
              chunk
            });
            this.input.bus.emit(stdoutEvent);
            await this.input.transcriptStore.appendEvent(stdoutEvent);
          }
        });

        if (result.summary) {
          await this.input.logStore.append({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            kind: "summary",
            content: result.summary
          });
        }

        if (result.rawLogs?.stdout) {
          await this.input.logStore.append({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            kind: "stdout",
            content: result.rawLogs.stdout
          });
        }

        if (result.rawLogs?.stderr) {
          await this.input.logStore.append({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            kind: "stderr",
            content: result.rawLogs.stderr
          });
        }

        const completed = createToolExecutionCompletedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          toolName: event.payload.toolName,
          summary: result.summary,
          rawOutput: result.rawLogs?.stdout || result.rawLogs?.stderr
        });
        this.input.bus.emit(completed);
        await this.input.transcriptStore.appendEvent(completed);

        if (event.taskId) {
          const taskCompleted = createTaskStateChangedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            state: result.ok ? "completed" : "failed",
            title: `Run ${event.payload.toolName}`
          });
          this.input.bus.emit(taskCompleted);
          await this.input.transcriptStore.appendEvent(taskCompleted);
        }
      } catch (error) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          message: error instanceof Error ? error.message : "Tool execution failed"
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);

        if (event.taskId) {
          const taskFailed = createTaskStateChangedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            state: "failed",
            title: `Run ${event.payload.toolName}`
          });
          this.input.bus.emit(taskFailed);
          await this.input.transcriptStore.appendEvent(taskFailed);
        }
      }
    });
  }

  private async handleCommandContent(sessionId: string, content: string, persistUserMessage: boolean) {
    const approvalMatch = content.trim().match(/^\/(approve|deny)\s+([a-f0-9-]+)$/i);

    if (approvalMatch) {
      const [, action, approvalId] = approvalMatch;
      const pending = this.pendingApprovals.get(approvalId);

      if (!pending) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId,
          message: `Unknown approval id: ${approvalId}`
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);
        return true;
      }

      const resolved = createApprovalResolvedEvent({
        sessionId,
        taskId: pending.request.taskId,
        approvalId,
        approved: action === "approve"
      });
      this.input.bus.emit(resolved);
      await this.input.transcriptStore.appendEvent(resolved);

      this.pendingApprovals.delete(approvalId);

      if (action === "approve") {
        const toolEvent = createToolExecutionRequestedEvent({
          sessionId,
          taskId: pending.request.taskId,
          toolName: pending.toolName,
          input: pending.input
        });
        this.input.bus.emit(toolEvent);
        await this.input.transcriptStore.appendEvent(toolEvent);
      }

      return true;
    }

    if (!persistUserMessage) {
      const parsedToolCommand = parseToolCommand(content);

      if (parsedToolCommand || parseSessionCommand(content) || parseBuiltInCommand(content)) {
        await this.processCommandOnlyInput({
          sessionId,
          content,
          persistUserEvent: false
        });
        return true;
      }
    }

    return false;
  }

  private async processCommandOnlyInput(input: {
    sessionId: string;
    content: string;
    persistUserEvent: boolean;
  }) {
    const parsedToolCommand = parseToolCommand(input.content);

    if (parsedToolCommand) {
      const taskId = randomUUID();
      const { toolName, input: toolInput } = parsedToolCommand;

      if (toolName === "shell") {
        const waitingApprovalTask = createTaskStateChangedEvent({
          sessionId: input.sessionId,
          taskId,
          state: "waiting_approval",
          title: `Run shell · ${createInlinePreview(toolInput.command ?? "", 96)}`
        });
        const approval = createApprovalRequestedEvent({
          sessionId: input.sessionId,
          taskId,
          toolName,
          input: toolInput,
          reason: `Run shell command: ${toolInput.command ?? ""}`,
          risk: "high"
        });

        this.pendingApprovals.set(approval.payload.approvalId, {
          request: approval.payload,
          toolName,
          input: toolInput
        });

        this.input.bus.emit(waitingApprovalTask);
        this.input.bus.emit(approval);
        await this.input.transcriptStore.appendEvent(waitingApprovalTask);
        await this.input.transcriptStore.appendEvent(approval);
        return true;
      }

      const toolEvent = createToolExecutionRequestedEvent({
        sessionId: input.sessionId,
        taskId,
        toolName,
        input: toolInput
      });

      this.input.bus.emit(toolEvent);
      await this.input.transcriptStore.appendEvent(toolEvent);
      return true;
    }

    const sessionCommand = parseSessionCommand(input.content);

    if (sessionCommand?.name === "history") {
      const events = await this.input.transcriptStore.readEventsBySession(input.sessionId);
      const historyLines = projectSessionTimeline(events)
        .slice(-12)
        .map((entry) => renderTimelineEntry(entry));
      const historyEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "History",
        content: historyLines.length > 0
          ? historyLines.join("\n")
          : "No conversation history yet."
      });
      this.input.bus.emit(historyEvent);
      await this.input.transcriptStore.appendEvent(historyEvent);
      return true;
    }

    if (sessionCommand?.name === "search") {
      const events = await this.input.transcriptStore.readEventsBySession(input.sessionId);
      const query = normalizeSearchText(sessionCommand.query ?? "");
      const searchLines = projectSessionTimeline(events)
        .filter((entry) => entry.searchText.includes(query))
        .slice(-12)
        .map((entry) => renderTimelineEntry(entry));
      const searchEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Search",
        content: searchLines.length > 0
          ? searchLines.join("\n")
          : `No matches for "${sessionCommand.query ?? ""}".`
      });
      this.input.bus.emit(searchEvent);
      await this.input.transcriptStore.appendEvent(searchEvent);
      return true;
    }

    if (sessionCommand?.name === "jump" && sessionCommand.target === "latest") {
      const events = await this.input.transcriptStore.readEventsBySession(input.sessionId);
      const latestEntry = projectSessionTimeline(events).at(-1);
      const jumpEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Jump",
        content: latestEntry
          ? `Latest\n${renderTimelineEntry(latestEntry)}`
          : "No latest history item yet."
      });
      this.input.bus.emit(jumpEvent);
      await this.input.transcriptStore.appendEvent(jumpEvent);
      return true;
    }

    if (sessionCommand?.name === "retry" && sessionCommand.target === "latest") {
      if (!this.lastRetryableUserMessage) {
        const retryMissingEvent = createSystemMessageAppendedEvent({
          sessionId: input.sessionId,
          title: "Retry",
          content: "No retryable user message yet."
        });
        this.input.bus.emit(retryMissingEvent);
        await this.input.transcriptStore.appendEvent(retryMissingEvent);
        return true;
      }

      await this.handleAssistantTurn(input.sessionId, this.lastRetryableUserMessage);
      return true;
    }

    if (sessionCommand?.name === "resume" && sessionCommand.target === "latest") {
      const latestResumable = this.getLatestResumableToolExecution(input.sessionId);

      if (!latestResumable) {
        const resumeMissingEvent = createSystemMessageAppendedEvent({
          sessionId: input.sessionId,
          title: "Resume",
          content: "No resumable tool task yet."
        });
        this.input.bus.emit(resumeMissingEvent);
        await this.input.transcriptStore.appendEvent(resumeMissingEvent);
        return true;
      }

      await this.resumeToolExecution(latestResumable);
      return true;
    }

    if (sessionCommand?.name === "resume" && sessionCommand.target === "list") {
      const resumables = this.listResumableToolExecutions(input.sessionId);
      const resumeListEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Resume",
        content: resumables.length > 0
          ? resumables
              .map((entry, index) => {
                const taskId = entry.taskId ?? `item-${index + 1}`;
                return [
                  `${index + 1}. ${entry.toolName} · ${taskId}`,
                  `   ${renderToolInputPreview(entry.input)}`,
                  `   /resume ${taskId}`
                ].join("\n");
              })
              .join("\n\n")
          : "No resumable tool tasks."
      });
      this.input.bus.emit(resumeListEvent);
      await this.input.transcriptStore.appendEvent(resumeListEvent);
      return true;
    }

    if (
      sessionCommand?.name === "resume" &&
      sessionCommand.target &&
      sessionCommand.target !== "latest" &&
      sessionCommand.target !== "list"
    ) {
      const resumable = this.getResumableToolExecutionByTaskId(input.sessionId, sessionCommand.target);

      if (!resumable) {
        const resumeMissingEvent = createSystemMessageAppendedEvent({
          sessionId: input.sessionId,
          title: "Resume",
          content: `Unknown resumable task id: ${sessionCommand.target}`
        });
        this.input.bus.emit(resumeMissingEvent);
        await this.input.transcriptStore.appendEvent(resumeMissingEvent);
        return true;
      }

      await this.resumeToolExecution(resumable);
      return true;
    }

    const builtInCommand = parseBuiltInCommand(input.content);

    if (builtInCommand === "help") {
      const helpEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Help",
        content: [
          formatCommandSection("Workspace", [
            "/sessions",
            "/tasks",
            "/plan",
            "/checkpoint"
          ]),
          formatCommandSection("History", [
            "/history",
            "/search <query>",
            "/jump latest",
            "/retry latest"
          ]),
          formatCommandSection("Recovery", [
            "/resume",
            "/resume latest",
            "/resume <taskId>",
            "/approve <id>",
            "/deny <id>"
          ]),
          formatCommandSection("Tools", [
            "/tools",
            "/read <path>",
            "/read <path:start-end>",
            "/read <path> --max-bytes <n>",
            "/shell <command>"
          ]),
          formatCommandSection("Launch", [
            "selfme --new",
            "selfme --session <id>"
          ]),
          formatCommandSection("Navigation", [
            "PageUp / PageDown  scroll messages",
            "Ctrl+Up / Ctrl+Down  fine scroll"
          ])
        ].join("\n\n")
      });
      this.input.bus.emit(helpEvent);
      await this.input.transcriptStore.appendEvent(helpEvent);
      return true;
    }

    if (builtInCommand === "tools") {
      const toolsEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Tools",
        content: this.input.tools.list()
          .map((tool) => `${tool.name}  ${tool.description}  [approval: ${tool.approvalPolicy}]`)
          .join("\n")
      });
      this.input.bus.emit(toolsEvent);
      await this.input.transcriptStore.appendEvent(toolsEvent);
      return true;
    }

    if (builtInCommand === "sessions") {
      const sessions = (await this.input.sessionStore.list())
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10);
      const checkpoints = await this.input.checkpointStore.list();
      const checkpointsBySessionId = new Map(checkpoints.map((checkpoint) => [checkpoint.sessionId, checkpoint] as const));
      const sessionsEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Sessions",
        content: sessions.length > 0
          ? sessions
              .map((session, index) => {
                const isCurrent = session.sessionId === this.input.session.sessionId;
                const checkpoint = checkpointsBySessionId.get(session.sessionId);

                return [
                  `${index + 1}. ${session.title}${isCurrent ? " · current" : ""}`,
                  `   ${session.model} · ${shortSessionId(session.sessionId)}`,
                  `   ${renderSessionCheckpointStatus(checkpoint)}`,
                  `   ${session.cwd ?? process.cwd()}`,
                  isCurrent
                    ? "   attached"
                    : `   open with selfme --session ${shortSessionId(session.sessionId)}`
                ].join("\n");
              })
              .join("\n\n")
          : "No sessions yet."
      });
      this.input.bus.emit(sessionsEvent);
      await this.input.transcriptStore.appendEvent(sessionsEvent);
      return true;
    }

    if (builtInCommand === "tasks") {
      const sessionTasks = this.tasks.listBySession(input.sessionId);
      const pendingApprovals = this.listPendingApprovals(input.sessionId);
      const resumableTasks = this.listResumableToolExecutions(input.sessionId);
      const sections: string[] = [];

      sections.push(
        sessionTasks.length > 0
          ? sessionTasks
              .map((task, index) => {
                const marker = task.state === "completed"
                  ? "done"
                  : task.state === "running"
                    ? "running"
                    : task.state;
                return `${index + 1}. ${task.title} · ${marker}`;
              })
              .join("\n")
          : "No tasks yet."
      );

      if (pendingApprovals.length > 0) {
        sections.push([
          `Pending approvals: ${pendingApprovals.length}`,
          ...pendingApprovals.map((entry) => [
            `[${entry.toolName}] ${entry.request.reason}`,
            `Approve: /approve ${entry.request.approvalId}`,
            `Deny: /deny ${entry.request.approvalId}`
          ].join("\n"))
        ].join("\n\n"));
      }

      if (resumableTasks.length > 0) {
        sections.push([
          `Resumable tasks: ${resumableTasks.length}`,
          ...resumableTasks.map((entry, index) => {
            const taskId = entry.taskId ?? `item-${index + 1}`;
            return [
              `[${entry.toolName}] ${renderToolInputPreview(entry.input)}`,
              `Resume: /resume ${taskId}`
            ].join("\n");
          })
        ].join("\n\n"));
      }

      const tasksEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Tasks",
        content: sections.join("\n\n")
      });
      this.input.bus.emit(tasksEvent);
      await this.input.transcriptStore.appendEvent(tasksEvent);
      return true;
    }

    if (builtInCommand === "plan") {
      const activeTasks = this.tasks.getActiveBySession(input.sessionId);
      const latestTask = this.tasks.getLatestBySession(input.sessionId);
      const pendingApprovals = this.listPendingApprovals(input.sessionId);
      const resumableTasks = this.listResumableToolExecutions(input.sessionId);
      const historyEvents = await this.input.transcriptStore.readEventsBySession(input.sessionId);
      const timeline = projectSessionTimeline(historyEvents);
      const recoveryStatus = this.describeRecoveryStatus(input.sessionId);
      const nextStep = pendingApprovals.length > 0
        ? `Next: resolve approval ${pendingApprovals[0]?.request.approvalId} with /approve or /deny.`
        : resumableTasks.length > 0
          ? `Next: resume ${resumableTasks[0]?.toolName} with /resume latest.`
          : activeTasks.length > 0
            ? "Next: finish the current active task."
            : "Next: send the next request to start a new task.";
      const followUpStep = pendingApprovals.length > 1
        ? "Then: clear the remaining approval backlog."
        : resumableTasks.length > 1
          ? "Then: resume the next unfinished tool task."
          : activeTasks.length > 1
            ? "Then: reduce parallel work and close one active thread."
            : "Then: review the latest result and continue.";
      const planEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Plan",
        content: [
          formatCommandSection("Current", [
            activeTasks.length > 0
              ? activeTasks.map((task) => task.title).join(" | ")
              : "idle",
            latestTask
              ? `latest: ${latestTask.state} · ${latestTask.title}`
              : "latest: none"
          ]),
          formatCommandSection("Recovery", [
            recoveryStatus.replace("Recovery: ", ""),
            nextStep,
            followUpStep
          ]),
          formatCommandSection("Context", [
            timeline.length > 8
              ? `compacted (${timeline.length - 8} earlier items summarized)`
              : "full recent history"
          ])
        ].join("\n\n")
      });
      this.input.bus.emit(planEvent);
      await this.input.transcriptStore.appendEvent(planEvent);
      return true;
    }

    if (builtInCommand === "checkpoint") {
      const snapshot = await this.input.checkpointStore.getLatest(input.sessionId);

      const checkpointEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Checkpoint",
        content: snapshot
          ? this.renderCheckpointSnapshot(snapshot, input.sessionId).join("\n\n")
          : "No checkpoint snapshot yet."
      });
      this.input.bus.emit(checkpointEvent);
      await this.input.transcriptStore.appendEvent(checkpointEvent);
      return true;
    }

    return false;
  }

  private async handleAssistantTurn(sessionId: string, content: string) {
    const taskId = randomUUID();

    this.input.bus.emit(createTaskStateChangedEvent({
      sessionId,
      taskId,
      state: "running",
      title: "Respond to user input"
    }));

    this.input.bus.emit(createAssistantStartedEvent({
      sessionId,
      taskId
    }));

    try {
      const historyEvents = await this.input.transcriptStore.readEventsBySession(sessionId);
      const contextMessages = buildContextMessages(stripLatestRetryableTurn(historyEvents, content));

      for await (const delta of this.input.provider.streamResponse({
        content,
        contextMessages
      })) {
        const nextEvent = createAssistantDeltaEvent({
          sessionId,
          taskId,
          delta: delta.delta
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
      }

      const completedEvent = createAssistantCompletedEvent({
        sessionId,
        taskId,
        model: this.input.session.model
      });
      this.input.bus.emit(completedEvent);
      await this.input.transcriptStore.appendEvent(completedEvent);

      const taskCompleted = createTaskStateChangedEvent({
        sessionId,
        taskId,
        state: "completed",
        title: "Respond to user input"
      });
      this.input.bus.emit(taskCompleted);
      await this.input.transcriptStore.appendEvent(taskCompleted);
    } catch (error) {
      const runtimeError = createRuntimeErrorRaisedEvent({
        sessionId,
        taskId,
        message: error instanceof Error ? error.message : "Unknown runtime error"
      });
      this.input.bus.emit(runtimeError);
      await this.input.transcriptStore.appendEvent(runtimeError);

      const taskFailed = createTaskStateChangedEvent({
        sessionId,
        taskId,
        state: "failed",
        title: "Respond to user input"
      });
      this.input.bus.emit(taskFailed);
      await this.input.transcriptStore.appendEvent(taskFailed);
    }
  }

  private restoreRetryableMessage(events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];

      if (event?.type !== "user.message.submitted") {
        continue;
      }

      const content = event.payload.content.trim();

      if (!content || content.startsWith("/")) {
        continue;
      }

      this.lastRetryableUserMessage = event.payload.content;
      return;
    }
  }

  private restorePendingApprovals(events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>) {
    const pendingById = new Map<string, {
      request: ApprovalRequest;
      toolName: string;
      input: unknown;
    }>();

    for (const event of events) {
      if (event.type === "approval.requested") {
        pendingById.set(event.payload.approvalId, {
          request: event.payload,
          toolName: event.payload.toolName,
          input: event.payload.input ?? {}
        });
        continue;
      }

      if (event.type === "approval.resolved") {
        pendingById.delete(event.payload.approvalId);
      }
    }

    this.pendingApprovals.clear();

    for (const [approvalId, entry] of pendingById) {
      this.pendingApprovals.set(approvalId, entry);
    }
  }

  private restoreResumableToolExecutions(events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>) {
    const pendingByTaskId = new Map<string, {
      sessionId: string;
      taskId?: string;
      toolName: string;
      input: unknown;
      requestedAt: string;
    }>();

    for (const event of events) {
      if (event.type === "tool.execution.requested" && event.taskId) {
        pendingByTaskId.set(event.taskId, {
          sessionId: event.sessionId,
          taskId: event.taskId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          requestedAt: event.timestamp
        });
        continue;
      }

      if (event.type === "tool.execution.completed" && event.taskId) {
        pendingByTaskId.delete(event.taskId);
        continue;
      }

      if (
        event.type === "task.state.changed" &&
        event.taskId &&
        (event.payload.state === "completed" || event.payload.state === "failed" || event.payload.state === "cancelled")
      ) {
        pendingByTaskId.delete(event.taskId);
      }
    }

    this.resumableToolExecutions.clear();

    for (const [taskId, entry] of pendingByTaskId) {
      this.resumableToolExecutions.set(taskId, entry);
    }
  }

  private async announceRecoverySummary() {
    const approvals = [...this.pendingApprovals.values()];
    const resumables = this.listResumableToolExecutions(this.input.session.sessionId);
    const sections: string[] = [];

    if (this.lastRetryableUserMessage) {
      sections.push([
        "Retry",
        `Latest: /retry latest`,
        `Message: ${createInlinePreview(this.lastRetryableUserMessage, 140)}`
      ].join("\n"));
    }

    if (approvals.length > 0) {
      sections.push([
        `Pending approvals: ${approvals.length}`,
        ...approvals.slice(0, 3).map((entry) => [
          `[${entry.toolName}] ${entry.request.reason}`,
          `Approve: /approve ${entry.request.approvalId}`,
          `Deny: /deny ${entry.request.approvalId}`
        ].join("\n"))
      ].join("\n\n"));
    }

    if (resumables.length > 0) {
      sections.push([
        `Resumable tasks: ${resumables.length}`,
        ...resumables.slice(0, 3).map((entry) => {
          const taskId = entry.taskId ?? "unknown-task";
          return `[${entry.toolName}] ${renderToolInputPreview(entry.input)}\nResume: /resume ${taskId}`;
        }),
        resumables.length > 3 ? "More: /resume" : "Latest: /resume latest"
      ].join("\n\n"));
    }

    if (sections.length === 0) {
      return;
    }

    const event = createSystemMessageAppendedEvent({
      sessionId: this.input.session.sessionId,
      title: "Recovery",
      content: sections.join("\n\n")
    });
    this.input.bus.emit(event);
    await this.input.transcriptStore.appendEvent(event);
  }

  private getLatestResumableToolExecution(sessionId: string) {
    return this.listResumableToolExecutions(sessionId)[0];
  }

  private listPendingApprovals(sessionId: string) {
    return [...this.pendingApprovals.values()]
      .filter((entry) => entry.request.sessionId === sessionId)
      .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt));
  }

  private listResumableToolExecutions(sessionId: string) {
    return [...this.resumableToolExecutions.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  }

  private getResumableToolExecutionByTaskId(sessionId: string, taskId: string) {
    return this.listResumableToolExecutions(sessionId)
      .find((entry) => entry.taskId === taskId);
  }

  private async resumeToolExecution(entry: {
    sessionId: string;
    taskId?: string;
    toolName: string;
    input: unknown;
    requestedAt: string;
  }) {
    const toolEvent = createToolExecutionRequestedEvent({
      sessionId: entry.sessionId,
      taskId: entry.taskId,
      toolName: entry.toolName,
      input: entry.input
    });
    this.input.bus.emit(toolEvent);
    await this.input.transcriptStore.appendEvent(toolEvent);
  }

  private describeRecoveryStatus(sessionId: string) {
    const parts: string[] = [];

    if (this.lastRetryableUserMessage) {
      parts.push("retry ready");
    }

    const pendingApprovals = this.listPendingApprovals(sessionId);

    if (pendingApprovals.length > 0) {
      parts.push(`approvals ${pendingApprovals.length}`);
    }

    const resumableTasks = this.listResumableToolExecutions(sessionId);

    if (resumableTasks.length > 0) {
      parts.push(`resumable ${resumableTasks.length}`);
    }

    return parts.length > 0
      ? `Recovery: ${parts.join(" | ")}`
      : "Recovery: clear";
  }

  private renderCheckpointSnapshot(
    snapshot: {
      title: string;
      version: string;
      model: string;
      cwd?: string;
      compactedSummary?: string;
      lastUserMessage?: string;
      lastAssistantMessage?: string;
      latestTask?: {
        taskId: string;
        title: string;
        state: string;
      };
      pendingApproval?: {
        approvalId: string;
        reason: string;
      };
      recentTools: Array<{
        taskId?: string;
        toolName: string;
        status: string;
        summary?: string;
      }>;
      stats: {
        userMessages: number;
        assistantMessages: number;
        toolExecutions: number;
        errors: number;
      };
    },
    sessionId: string
  ) {
    const sections = [
      formatCommandSection("Session", [
        snapshot.title,
        `${snapshot.model} · ${snapshot.version}`,
        snapshot.cwd ?? process.cwd()
      ]),
      formatCommandSection("Recovery", [
        this.describeRecoveryStatus(sessionId).replace("Recovery: ", ""),
        snapshot.latestTask
          ? `latest task: ${snapshot.latestTask.state} · ${snapshot.latestTask.title}`
          : "latest task: none",
        snapshot.pendingApproval
          ? `pending approval: ${snapshot.pendingApproval.approvalId} · ${snapshot.pendingApproval.reason}`
          : "pending approval: none"
      ]),
      formatCommandSection("Stats", [
        `user ${snapshot.stats.userMessages} · assistant ${snapshot.stats.assistantMessages}`,
        `tools ${snapshot.stats.toolExecutions} · errors ${snapshot.stats.errors}`
      ])
    ];

    if (snapshot.compactedSummary) {
      sections.push(formatCommandSection("Summary", [snapshot.compactedSummary]));
    }

    sections.push(formatCommandSection("Recent", [
      snapshot.lastUserMessage
        ? `user: ${snapshot.lastUserMessage}`
        : "user: none",
      snapshot.lastAssistantMessage
        ? `assistant: ${snapshot.lastAssistantMessage}`
        : "assistant: none"
    ]));

    if (snapshot.recentTools.length > 0) {
      sections.push(formatCommandSection("Tools", [
        ...snapshot.recentTools.map((tool, index) => {
          const taskId = tool.taskId ? ` · ${tool.taskId}` : "";
          const summary = tool.summary ? ` · ${tool.summary}` : "";
          return `${index + 1}. ${tool.toolName} · ${tool.status}${taskId}${summary}`;
        })
      ]));
    }

    return sections;
  }
}

function stripLatestRetryableTurn(
  events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>,
  content: string
) {
  let matchedUserIndex = -1;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type !== "user.message.submitted") {
      continue;
    }

    if (event.payload.content !== content) {
      continue;
    }

    matchedUserIndex = index;
    break;
  }

  if (matchedUserIndex === -1) {
    return events;
  }

  let endIndex = matchedUserIndex + 1;

  while (endIndex < events.length) {
    const event = events[endIndex];

    if (event?.type === "user.message.submitted") {
      break;
    }

    endIndex += 1;
  }

  return [...events.slice(0, matchedUserIndex), ...events.slice(endIndex)];
}

function renderToolInputPreview(input: unknown) {
  if (input && typeof input === "object" && "command" in input && typeof input.command === "string") {
    return input.command;
  }

  if (input && typeof input === "object" && "path" in input && typeof input.path === "string") {
    return input.path;
  }

  return createInlinePreview(JSON.stringify(input ?? {}), 140);
}

function shortSessionId(sessionId: string) {
  return sessionId.slice(0, 8);
}

function formatCommandSection(title: string, lines: string[]) {
  return [title, ...lines.map((line) => `  ${line}`)].join("\n");
}

function renderSessionCheckpointStatus(checkpoint?: {
  latestTask?: { title: string; state: string };
  pendingApproval?: { reason: string };
}) {
  if (checkpoint?.pendingApproval) {
    return `approval · ${checkpoint.pendingApproval.reason}`;
  }

  if (
    checkpoint?.latestTask &&
    checkpoint.latestTask.state !== "completed" &&
    checkpoint.latestTask.state !== "failed" &&
    checkpoint.latestTask.state !== "cancelled"
  ) {
    return `task · ${checkpoint.latestTask.title} · ${checkpoint.latestTask.state}`;
  }

  return "clear";
}
