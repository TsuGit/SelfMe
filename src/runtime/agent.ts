import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { ProviderClient } from "../providers/base.js";
import type { ToolRegistry } from "../tools/base.js";
import type { ApprovalRequest } from "../types/approval.js";
import type { SessionRecord } from "../types/session.js";
import type { TranscriptStore } from "../storage/transcripts.js";
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
  createToolExecutionStartedEvent
} from "./events.js";

export class AgentRuntime {
  private readonly pendingApprovals = new Map<string, {
    request: ApprovalRequest;
    toolName: string;
    input: unknown;
  }>();

  constructor(
    private readonly input: {
      bus: EventBus;
      provider: ProviderClient;
      tools: ToolRegistry;
      session: SessionRecord;
      transcriptStore: TranscriptStore;
    }
  ) {}

  async start() {
    this.input.bus.on("user.message.submitted", async (event) => {
      const approvalMatch = event.payload.content.trim().match(/^\/(approve|deny)\s+([a-f0-9-]+)$/i);

      if (approvalMatch) {
        const [, action, approvalId] = approvalMatch;
        const pending = this.pendingApprovals.get(approvalId);

        if (!pending) {
          const runtimeError = createRuntimeErrorRaisedEvent({
            sessionId: event.sessionId,
            message: `Unknown approval id: ${approvalId}`
          });
          this.input.bus.emit(runtimeError);
          await this.input.transcriptStore.appendEvent(runtimeError);
          return;
        }

        const resolved = createApprovalResolvedEvent({
          sessionId: event.sessionId,
          taskId: pending.request.taskId,
          approvalId,
          approved: action === "approve"
        });
        this.input.bus.emit(resolved);
        await this.input.transcriptStore.appendEvent(event);
        await this.input.transcriptStore.appendEvent(resolved);

        this.pendingApprovals.delete(approvalId);

        if (action === "approve") {
          const toolEvent = createToolExecutionRequestedEvent({
            sessionId: event.sessionId,
            taskId: pending.request.taskId,
            toolName: pending.toolName,
            input: pending.input
          });
          this.input.bus.emit(toolEvent);
          await this.input.transcriptStore.appendEvent(toolEvent);
        }

        return;
      }

      const commandMatch = event.payload.content.trim().match(/^\/(shell|read)\s+([\s\S]+)$/);

      if (commandMatch) {
        const [, command, rawInput] = commandMatch;
        const taskId = randomUUID();
        const toolName = command === "read" ? "files" : "shell";
        const input = command === "read"
          ? { path: rawInput.trim() }
          : { command: rawInput.trim() };

        if (toolName === "shell") {
          const approval = createApprovalRequestedEvent({
            sessionId: event.sessionId,
            taskId,
            toolName,
            reason: `Run shell command: ${input.command}`,
            risk: "high"
          });

          this.pendingApprovals.set(approval.payload.approvalId, {
            request: approval.payload,
            toolName,
            input
          });

          this.input.bus.emit(approval);
          await this.input.transcriptStore.appendEvent(event);
          await this.input.transcriptStore.appendEvent(approval);
          return;
        }

        const toolEvent = createToolExecutionRequestedEvent({
          sessionId: event.sessionId,
          taskId,
          toolName,
          input
        });

        this.input.bus.emit(toolEvent);
        await this.input.transcriptStore.appendEvent(event);
        await this.input.transcriptStore.appendEvent(toolEvent);
        return;
      }

      const builtInCommand = event.payload.content.trim();

      if (builtInCommand === "/help") {
        const helpEvent = createSystemMessageAppendedEvent({
          sessionId: event.sessionId,
          title: "Help",
          content: [
            "/help",
            "/tools",
            "/read <path>",
            "/shell <command>",
            "/approve <id>",
            "/deny <id>",
            "PageUp / PageDown  scroll messages",
            "Ctrl+Up / Ctrl+Down  fine scroll"
          ].join("\n")
        });
        this.input.bus.emit(helpEvent);
        await this.input.transcriptStore.appendEvent(event);
        await this.input.transcriptStore.appendEvent(helpEvent);
        return;
      }

      if (builtInCommand === "/tools") {
        const toolsEvent = createSystemMessageAppendedEvent({
          sessionId: event.sessionId,
          title: "Tools",
          content: this.input.tools.list()
            .map((tool) => `${tool.name}  ${tool.description}  [approval: ${tool.approvalPolicy}]`)
            .join("\n")
        });
        this.input.bus.emit(toolsEvent);
        await this.input.transcriptStore.appendEvent(event);
        await this.input.transcriptStore.appendEvent(toolsEvent);
        return;
      }

      const taskId = randomUUID();

      this.input.bus.emit(createTaskStateChangedEvent({
        sessionId: event.sessionId,
        taskId,
        state: "running",
        title: "Respond to user input"
      }));

      this.input.bus.emit(createAssistantStartedEvent({
        sessionId: event.sessionId,
        taskId
      }));

      await this.input.transcriptStore.appendEvent(event);

      try {
        for await (const delta of this.input.provider.streamResponse({
          content: event.payload.content
        })) {
          const nextEvent = createAssistantDeltaEvent({
            sessionId: event.sessionId,
            taskId,
            delta: delta.delta
          });
          this.input.bus.emit(nextEvent);
          await this.input.transcriptStore.appendEvent(nextEvent);
        }

        const completedEvent = createAssistantCompletedEvent({
          sessionId: event.sessionId,
          taskId,
          model: this.input.session.model
        });
        this.input.bus.emit(completedEvent);
        await this.input.transcriptStore.appendEvent(completedEvent);

        const taskCompleted = createTaskStateChangedEvent({
          sessionId: event.sessionId,
          taskId,
          state: "completed",
          title: "Respond to user input"
        });
        this.input.bus.emit(taskCompleted);
        await this.input.transcriptStore.appendEvent(taskCompleted);
      } catch (error) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: event.sessionId,
          taskId,
          message: error instanceof Error ? error.message : "Unknown runtime error"
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);
      }
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
          taskId: event.taskId
        });

        const completed = createToolExecutionCompletedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          toolName: event.payload.toolName,
          summary: result.summary,
          rawOutput: result.rawLogs?.stdout || result.rawLogs?.stderr
        });
        this.input.bus.emit(completed);
        await this.input.transcriptStore.appendEvent(completed);
      } catch (error) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: event.sessionId,
          taskId: event.taskId,
          message: error instanceof Error ? error.message : "Tool execution failed"
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);
      }
    });
  }
}
