import { randomUUID } from "node:crypto";

import type { EventBus } from "../app/event-bus.js";
import type { ProviderClient } from "../providers/base.js";
import type { LogStore } from "../storage/logs.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import type { ToolRegistry } from "../tools/base.js";
import type { ApprovalRequest } from "../types/approval.js";
import type { SessionRecord } from "../types/session.js";
import type { ToolImplementation } from "../types/tool.js";
import { parseBuiltInCommand, parseToolCommand, renderHelpLines } from "./commands.js";
import { buildContextMessages, createInlinePreview } from "./context-compaction.js";
import {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createAssistantCompletedEvent,
  createAssistantDeltaEvent,
  createAssistantStartedEvent,
  createRuntimeBusyStateChangedEvent,
  createRuntimeErrorRaisedEvent,
  createSystemMessageAppendedEvent,
  createTaskStateChangedEvent,
  createToolExecutionCompletedEvent,
  createToolExecutionRequestedEvent,
  createToolExecutionStartedEvent,
  createToolStdoutAppendedEvent
} from "./events.js";

const MAX_AGENT_TOOL_STEPS = 6;
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const TOOL_CALL_DENIED_PROMPT = "The requested tool action was denied by the user. Continue without that action. If you can still help, answer directly. If another tool is needed, return exactly one tool call block.";

interface ParsedAssistantToolCall {
  tool: string;
  input: unknown;
}

interface ActiveRunState {
  sessionId: string;
  taskId: string;
  controller: AbortController;
  phase: "assistant" | "tool" | "approval";
  pendingApprovalId?: string;
}

export class AgentRuntime {
  private readonly pendingApprovals = new Map<string, {
    request: ApprovalRequest;
    toolName: string;
    input: unknown;
    autoContinue?: boolean;
  }>();
  private activeRun?: ActiveRunState;
  private readonly pendingUserTurns = new Map<string, AbortController>();

  constructor(
    private readonly input: {
      bus: EventBus;
      provider: ProviderClient;
      tools: ToolRegistry;
      session: SessionRecord;
      transcriptStore: TranscriptStore;
      logStore: LogStore;
    }
  ) {}

  async start() {
    this.emitBusyState(this.input.session.sessionId, false, "idle");

    this.input.bus.on("user.message.submitted", async (event) => {
      if (this.isLockedForSession(event.sessionId)) {
        this.emitTransientStatus(event.sessionId, "Busy", "A task is still running. Press Esc, Ctrl+C, or /stop before sending a new message.");
        return;
      }

      const pendingController = new AbortController();
      this.pendingUserTurns.set(event.sessionId, pendingController);

      try {
        if (pendingController.signal.aborted) {
          this.emitTransientStatus(event.sessionId, "Stopped", "Current task stopped.");
          return;
        }

        await this.input.transcriptStore.appendEvent(event);
        await this.handleAssistantTurn(event.sessionId, event.payload.content);
      } finally {
        if (this.pendingUserTurns.get(event.sessionId) === pendingController) {
          this.pendingUserTurns.delete(event.sessionId);
        }
      }
    });

    this.input.bus.on("terminal.command.invoked", async (event) => {
      await this.handleCommandContent(event.sessionId, event.payload.content, false);
    });

    this.input.bus.on("runtime.interrupt.requested", async (event) => {
      await this.stopActiveRun(event.sessionId, event.payload.reason);
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
        const validatedInput = parseToolInput(tool, event.payload.input);
        const result = await tool.invoke(validatedInput, {
          cwd: this.input.session.cwd ?? process.cwd(),
          sessionId: event.sessionId,
          taskId: event.taskId,
          signal: this.getActiveSignal(event.sessionId, event.taskId),
          onStdoutChunk: async (chunk) => {
            const stdoutEvent = createToolStdoutAppendedEvent({
              sessionId: event.sessionId,
              taskId: event.taskId,
              toolName: event.payload.toolName,
              chunk
            });
            this.input.bus.emit(stdoutEvent);
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
          rawOutput: combineToolRawOutput(result.rawLogs?.stdout, result.rawLogs?.stderr)
        });
        this.input.bus.emit(completed);
        await this.input.transcriptStore.appendEvent(completed);

        if (event.taskId) {
          const taskCompleted = createTaskStateChangedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            state: isCancellationResult(result) ? "cancelled" : result.ok ? "completed" : "failed",
            title: `Run ${event.payload.toolName}`
          });
          this.input.bus.emit(taskCompleted);
          await this.input.transcriptStore.appendEvent(taskCompleted);
        }
      } catch (error) {
        if (isAbortError(error)) {
          const completed = createToolExecutionCompletedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            summary: "cancelled"
          });
          this.input.bus.emit(completed);
          await this.input.transcriptStore.appendEvent(completed);

          if (event.taskId) {
            const taskCancelled = createTaskStateChangedEvent({
              sessionId: event.sessionId,
              taskId: event.taskId,
              state: "cancelled",
              title: `Run ${event.payload.toolName}`
            });
            this.input.bus.emit(taskCancelled);
            await this.input.transcriptStore.appendEvent(taskCancelled);
          }

          return;
        }

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
    const builtInCommand = parseBuiltInCommand(content);

    if (builtInCommand === "stop") {
      await this.stopActiveRun(sessionId, "command");
      return true;
    }

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
      this.setActivePendingApproval(pending.request.taskId ?? "", undefined);

      if (action === "approve" && !pending.autoContinue) {
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

    if (this.isLockedForSession(sessionId)) {
      this.emitTransientStatus(sessionId, "Busy", "A task is still running. Press Esc, Ctrl+C, or /stop before starting another action.");
      return true;
    }

    if (!persistUserMessage) {
      if (content.trim().startsWith("/")) {
        await this.processCommandOnlyInput({
          sessionId,
          content
        });
        return true;
      }
    }

    return false;
  }

  private async processCommandOnlyInput(input: {
    sessionId: string;
    content: string;
  }) {
    const builtInCommand = parseBuiltInCommand(input.content);
    const parsedToolCommand = parseToolCommand(input.content);

    if (parsedToolCommand) {
      const taskId = randomUUID();
      const { toolName, input: rawToolInput } = parsedToolCommand;
      const tool = this.input.tools.get(toolName);

      if (!tool) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: input.sessionId,
          taskId,
          message: `Unknown tool: ${toolName}`
        });
        this.input.bus.emit(runtimeError);
        await this.input.transcriptStore.appendEvent(runtimeError);
        return true;
      }

      const toolInput = parseToolInput(tool, rawToolInput);

      if (tool.approvalPolicy !== "never") {
        const approvalDescriptor = tool.buildApproval?.(toolInput) ?? buildDefaultApprovalDescriptor(tool, toolInput);
        const waitingApprovalTask = createTaskStateChangedEvent({
          sessionId: input.sessionId,
          taskId,
          state: "waiting_approval",
          title: approvalDescriptor.title
        });
        const approval = createApprovalRequestedEvent({
          sessionId: input.sessionId,
          taskId,
          toolName,
          input: toolInput,
          reason: approvalDescriptor.reason,
          risk: approvalDescriptor.risk
        });

        this.pendingApprovals.set(approval.payload.approvalId, {
          request: approval.payload,
          toolName,
          input: toolInput,
          autoContinue: false
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

    if (builtInCommand === "help") {
      const helpEvent = createSystemMessageAppendedEvent({
        sessionId: input.sessionId,
        title: "Help",
        content: renderHelpLines().join("\n")
      });
      this.input.bus.emit(helpEvent);
      return true;
    }

    const runtimeError = createRuntimeErrorRaisedEvent({
      sessionId: input.sessionId,
      message: `Unknown command: ${input.content.trim()}`
    });
    this.input.bus.emit(runtimeError);
    return true;
  }

  private async handleAssistantTurn(sessionId: string, content: string) {
    const responseTaskId = randomUUID();
    const originalRequest = content;
    let nextPrompt = content;
    const activeRun = this.startActiveRun(sessionId, responseTaskId);

    this.input.bus.emit(createTaskStateChangedEvent({
      sessionId,
      taskId: responseTaskId,
      state: "running",
      title: "Respond to user input"
    }));

    try {
      for (let step = 0; step <= MAX_AGENT_TOOL_STEPS; step += 1) {
        const assistantPass = await this.runAssistantPass({
          sessionId,
          taskId: responseTaskId,
          content: nextPrompt,
          signal: activeRun.controller.signal
        });

        if (assistantPass.kind === "message") {
          const completedEvent = createAssistantCompletedEvent({
            sessionId,
            taskId: responseTaskId,
            model: this.input.session.model
          });
          this.input.bus.emit(completedEvent);
          await this.input.transcriptStore.appendEvent(completedEvent);

          const taskCompleted = createTaskStateChangedEvent({
            sessionId,
            taskId: responseTaskId,
            state: "completed",
            title: "Respond to user input"
          });
          this.input.bus.emit(taskCompleted);
          await this.input.transcriptStore.appendEvent(taskCompleted);
          return;
        }

        if (step === MAX_AGENT_TOOL_STEPS) {
          throw new Error(`Agent stopped after ${MAX_AGENT_TOOL_STEPS} tool steps`);
        }

        const tool = this.input.tools.get(assistantPass.toolCall.tool);

        if (!tool) {
          throw new Error(`Unknown tool requested by model: ${assistantPass.toolCall.tool}`);
        }

        const toolInput = parseToolInput(tool, assistantPass.toolCall.input);
        const toolTaskResult = await this.requestToolFromAssistant({
          sessionId,
          tool,
          input: toolInput,
          signal: activeRun.controller.signal
        });

        if (toolTaskResult.kind === "denied") {
          nextPrompt = buildDeniedContinuationPrompt(originalRequest);
          continue;
        }

        if (toolTaskResult.kind === "failed") {
          if (shouldAutoSummarizeToolFailure(originalRequest, toolTaskResult.result)) {
            const directAnswer = buildDirectToolFailureAnswer(originalRequest, toolTaskResult.result);

            if (directAnswer) {
              const nextEvent = createAssistantDeltaEvent({
                sessionId,
                taskId: responseTaskId,
                delta: directAnswer
              });
              this.input.bus.emit(nextEvent);
              await this.input.transcriptStore.appendEvent(nextEvent);

              const completedEvent = createAssistantCompletedEvent({
                sessionId,
                taskId: responseTaskId,
                model: this.input.session.model
              });
              this.input.bus.emit(completedEvent);
              await this.input.transcriptStore.appendEvent(completedEvent);

              const taskCompleted = createTaskStateChangedEvent({
                sessionId,
                taskId: responseTaskId,
                state: "completed",
                title: "Respond to user input"
              });
              this.input.bus.emit(taskCompleted);
              await this.input.transcriptStore.appendEvent(taskCompleted);
              return;
            }
          }

          nextPrompt = buildToolFailureContinuationPrompt(originalRequest, toolTaskResult.result);
          continue;
        }

        nextPrompt = buildToolContinuationPrompt(originalRequest, toolTaskResult.result);
      }
    } catch (error) {
      if (isAbortError(error)) {
        const completedEvent = createAssistantCompletedEvent({
          sessionId,
          taskId: responseTaskId,
          model: this.input.session.model
        });
        this.input.bus.emit(completedEvent);
        await this.input.transcriptStore.appendEvent(completedEvent);

        const taskCancelled = createTaskStateChangedEvent({
          sessionId,
          taskId: responseTaskId,
          state: "cancelled",
          title: "Respond to user input"
        });
        this.input.bus.emit(taskCancelled);
        await this.input.transcriptStore.appendEvent(taskCancelled);

        this.emitTransientStatus(sessionId, "Stopped", "Current task stopped.");
        return;
      }

      const completedEvent = createAssistantCompletedEvent({
        sessionId,
        taskId: responseTaskId,
        model: this.input.session.model
      });
      this.input.bus.emit(completedEvent);
      await this.input.transcriptStore.appendEvent(completedEvent);

      const runtimeError = createRuntimeErrorRaisedEvent({
        sessionId,
        taskId: responseTaskId,
        message: error instanceof Error ? error.message : "Unknown runtime error"
      });
      this.input.bus.emit(runtimeError);
      await this.input.transcriptStore.appendEvent(runtimeError);

      const taskFailed = createTaskStateChangedEvent({
        sessionId,
        taskId: responseTaskId,
        state: "failed",
        title: "Respond to user input"
      });
      this.input.bus.emit(taskFailed);
      await this.input.transcriptStore.appendEvent(taskFailed);
    } finally {
      this.clearActiveRun(responseTaskId);
    }
  }

  private async runAssistantPass(input: {
    sessionId: string;
    taskId: string;
    content: string;
    signal: AbortSignal;
  }) {
    this.setActivePhase(input.taskId, "assistant");
    const startedEvent = createAssistantStartedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId
    });
    this.input.bus.emit(startedEvent);

    const historyEvents = await this.input.transcriptStore.readEventsBySession(input.sessionId);
    const contextMessages = [
      {
        role: "system" as const,
        content: buildAgentSystemPrompt(this.input.tools.list())
      },
      ...buildContextMessages(historyEvents)
    ];

    let buffer = "";
    let streamedVisible = false;
    let pendingPrefix = "";

    for await (const chunk of this.input.provider.streamResponse({
      content: input.content,
      contextMessages,
      signal: input.signal
    })) {
      buffer += chunk.delta;

      if (streamedVisible) {
        const nextEvent = createAssistantDeltaEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          delta: chunk.delta
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
        continue;
      }

      pendingPrefix += chunk.delta;
      const mode = classifyAssistantBuffer(pendingPrefix);

      if (mode === "tool") {
        continue;
      }

      if (mode === "message") {
        streamedVisible = true;
        const nextEvent = createAssistantDeltaEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          delta: pendingPrefix
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
        pendingPrefix = "";
      }
    }

    if (streamedVisible) {
      return {
        kind: "message" as const
      };
    }

    const parsedToolCall = parseAssistantToolCall(buffer);

    if (!parsedToolCall) {
      if (looksLikeToolCallBuffer(buffer)) {
        throw new Error(`Model emitted a malformed tool call: ${createMalformedToolCallPreview(buffer)}`);
      }

      if (buffer.trim().length > 0) {
        const nextEvent = createAssistantDeltaEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          delta: buffer
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
      }

      return {
        kind: "message" as const
      };
    }

    const completedEvent = createAssistantCompletedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      model: this.input.session.model
    });
    this.input.bus.emit(completedEvent);
    await this.input.transcriptStore.appendEvent(completedEvent);

    return {
      kind: "tool_call" as const,
      toolCall: parsedToolCall
    };
  }

  private async requestToolFromAssistant(input: {
    sessionId: string;
    tool: ToolImplementation;
    input: unknown;
    signal: AbortSignal;
  }) {
    const toolTaskId = randomUUID();

    if (input.tool.approvalPolicy !== "never") {
      const decision = await this.requestApproval({
        sessionId: input.sessionId,
        taskId: toolTaskId,
        tool: input.tool,
        input: input.input,
        signal: input.signal
      });

      if (!decision.approved) {
        return {
          kind: "denied" as const
        };
      }
    }

    const result = await this.executeToolAndWait({
      sessionId: input.sessionId,
      taskId: toolTaskId,
      toolName: input.tool.name,
      input: input.input,
      signal: input.signal
    });

    if (!result.ok) {
      return {
        kind: "failed" as const,
        result
      };
    }

    return {
      kind: "completed" as const,
      result
    };
  }

  private async requestApproval(input: {
    sessionId: string;
    taskId: string;
    tool: ToolImplementation;
    input: unknown;
    signal: AbortSignal;
  }) {
    this.setActivePhase(input.taskId, "approval");
    const approvalDescriptor = input.tool.buildApproval?.(input.input) ?? buildDefaultApprovalDescriptor(input.tool, input.input);
    const waitingApprovalTask = createTaskStateChangedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      state: "waiting_approval",
      title: approvalDescriptor.title
    });
    const approval = createApprovalRequestedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolName: input.tool.name,
      input: input.input,
      reason: approvalDescriptor.reason,
      risk: approvalDescriptor.risk
    });

    this.pendingApprovals.set(approval.payload.approvalId, {
      request: approval.payload,
      toolName: input.tool.name,
      input: input.input,
      autoContinue: true
    });
    this.setActivePendingApproval(input.taskId, approval.payload.approvalId);

    const decisionPromise = this.waitForApprovalResolution(approval.payload.approvalId, input.signal);

    this.input.bus.emit(waitingApprovalTask);
    this.input.bus.emit(approval);
    await this.input.transcriptStore.appendEvent(waitingApprovalTask);
    await this.input.transcriptStore.appendEvent(approval);

    return await decisionPromise;
  }

  private async waitForApprovalResolution(approvalId: string, signal: AbortSignal) {
    return await new Promise<{ approved: boolean }>((resolve, reject) => {
      const abortListener = () => {
        unsubscribe();
        reject(createAbortError());
      };
      const unsubscribe = this.input.bus.on("approval.resolved", (event) => {
        if (event.payload.approvalId !== approvalId) {
          return;
        }

        unsubscribe();
        signal.removeEventListener("abort", abortListener);
        resolve({
          approved: event.payload.approved
        });
      });
      signal.addEventListener("abort", abortListener, { once: true });
    });
  }

  private async executeToolAndWait(input: {
    sessionId: string;
    taskId: string;
    toolName: string;
    input: unknown;
    signal: AbortSignal;
  }) {
    this.setActivePhase(input.taskId, "tool");
    const resultPromise = new Promise<{
      ok: boolean;
      toolName: string;
      summary: string;
      rawOutput?: string;
      errorMessage?: string;
    }>((resolve) => {
      const offCompleted = this.input.bus.on("tool.execution.completed", (event) => {
        if (event.taskId !== input.taskId) {
          return;
        }

        offCompleted();
        offError();
        const summary = event.payload.summary;
        const ok = !isToolExecutionFailureSummary(summary);
        resolve({
          ok,
          toolName: event.payload.toolName,
          summary,
          rawOutput: event.payload.rawOutput,
          errorMessage: ok ? undefined : summary
        });
      });

      const offError = this.input.bus.on("runtime.error.raised", (event) => {
        if (event.taskId !== input.taskId) {
          return;
        }

        offCompleted();
        offError();
        resolve({
          ok: false,
          toolName: input.toolName,
          summary: `${input.toolName} · failed`,
          rawOutput: event.payload.message,
          errorMessage: event.payload.message
        });
      });
    });

    const toolEvent = createToolExecutionRequestedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolName: input.toolName,
      input: input.input
    });
    this.input.bus.emit(toolEvent);
    await this.input.transcriptStore.appendEvent(toolEvent);

    return await resultPromise;
  }

  private isBusyForSession(sessionId: string) {
    return this.activeRun?.sessionId === sessionId;
  }

  private isLockedForSession(sessionId: string) {
    return this.pendingUserTurns.has(sessionId) || this.isBusyForSession(sessionId);
  }

  private startActiveRun(sessionId: string, taskId: string) {
    this.pendingUserTurns.delete(sessionId);
    const controller = new AbortController();
    this.activeRun = {
      sessionId,
      taskId,
      controller,
      phase: "assistant"
    };
    this.emitBusyState(sessionId, true, "assistant");
    return this.activeRun;
  }

  private clearActiveRun(taskId: string) {
    if (!this.activeRun || this.activeRun.taskId !== taskId) {
      return;
    }

    const sessionId = this.activeRun.sessionId;
    this.activeRun = undefined;
    this.emitBusyState(sessionId, false, "idle");
  }

  private setActivePhase(taskId: string, phase: "assistant" | "tool" | "approval") {
    if (!this.activeRun || this.activeRun.taskId !== taskId) {
      return;
    }

    this.activeRun.phase = phase;
    this.emitBusyState(this.activeRun.sessionId, true, phase);
  }

  private setActivePendingApproval(taskId: string, approvalId?: string) {
    if (!this.activeRun || this.activeRun.taskId !== taskId) {
      return;
    }

    this.activeRun.pendingApprovalId = approvalId;
  }

  private getActiveSignal(sessionId: string, taskId?: string) {
    if (!this.activeRun || this.activeRun.sessionId !== sessionId || !taskId || this.activeRun.taskId !== taskId) {
      return undefined;
    }

    return this.activeRun.controller.signal;
  }

  private emitBusyState(sessionId: string, active: boolean, phase: "idle" | "assistant" | "tool" | "approval") {
    this.input.bus.emit(createRuntimeBusyStateChangedEvent({
      sessionId,
      active,
      phase
    }));
  }

  private emitTransientStatus(sessionId: string, title: string, content: string) {
    this.input.bus.emit(createSystemMessageAppendedEvent({
      sessionId,
      title,
      content
    }));
  }

  private async stopActiveRun(sessionId: string, reason: "cancel" | "quit" | "command") {
    if (!this.activeRun || this.activeRun.sessionId !== sessionId) {
      const pendingTurn = this.pendingUserTurns.get(sessionId);

      if (pendingTurn) {
        pendingTurn.abort();
        this.pendingUserTurns.delete(sessionId);
        this.emitTransientStatus(sessionId, "Stopped", "Current task stopped.");
        return true;
      }

      if (reason !== "quit") {
        this.emitTransientStatus(sessionId, "Stopped", "No active task to stop.");
      }
      return false;
    }

    const current = this.activeRun;

    if (current.pendingApprovalId) {
      const pending = this.pendingApprovals.get(current.pendingApprovalId);

      if (pending) {
        const resolved = createApprovalResolvedEvent({
          sessionId,
          taskId: pending.request.taskId,
          approvalId: current.pendingApprovalId,
          approved: false
        });
        this.input.bus.emit(resolved);
        await this.input.transcriptStore.appendEvent(resolved);
        this.pendingApprovals.delete(current.pendingApprovalId);
      }
    }

    current.controller.abort();
    return true;
  }
}

function buildDefaultApprovalDescriptor(tool: ToolImplementation, input: unknown) {
  const target = renderApprovalTarget(tool.name, input);

  return {
    title: target ? `Run ${tool.name} · ${target}` : `Run ${tool.name}`,
    reason: target ? `Run ${tool.name}: ${target}` : `Run ${tool.name}`,
    risk: tool.approvalPolicy === "always" ? "high" : "medium"
  } as const;
}

function renderApprovalTarget(toolName: string, input: unknown) {
  if (toolName === "shell" && input && typeof input === "object" && "command" in input && typeof input.command === "string") {
    return createInlinePreview(input.command, 96);
  }

  if (
    (toolName === "files" || toolName === "write" || toolName === "edit") &&
    input &&
    typeof input === "object" &&
    "path" in input &&
    typeof input.path === "string"
  ) {
    if ("startLine" in input && typeof input.startLine === "number") {
      const endLine = "endLine" in input && typeof input.endLine === "number"
        ? input.endLine
        : input.startLine;
      return `${input.path}:${input.startLine}-${endLine}`;
    }

    return input.path;
  }

  return "";
}

function parseToolInput(tool: ToolImplementation, input: unknown) {
  const schema = tool.inputSchema;

  if (schema && typeof schema === "object" && "parse" in schema && typeof schema.parse === "function") {
    return schema.parse(input);
  }

  return input;
}

function combineToolRawOutput(stdout?: string, stderr?: string) {
  const hasStdout = typeof stdout === "string" && stdout.length > 0;
  const hasStderr = typeof stderr === "string" && stderr.length > 0;

  if (hasStdout && hasStderr) {
    return [
      "stdout:",
      stdout,
      "",
      "stderr:",
      stderr
    ].join("\n");
  }

  if (hasStdout) {
    return stdout;
  }

  return hasStderr ? stderr : "";
}

function createAbortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isCancellationResult(result: {
  ok: boolean;
  errorMessage?: string;
  summary: string;
}) {
  return !result.ok && (
    result.errorMessage === "Shell command cancelled" ||
    result.summary.includes("cancelled")
  );
}

function isToolExecutionFailureSummary(summary: string) {
  return /\bfailed\b/i.test(summary) || /\btimed out\b/i.test(summary) || /\bcancelled\b/i.test(summary);
}

function buildToolContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
}) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "Continue from the latest tool result only.",
    "Do not infer anything that is not explicitly present in the result below.",
    "If another tool is required, return exactly one tool call block.",
    "If the original request is not yet completed, keep working instead of stopping at a status update.",
    "Otherwise answer the user briefly and directly.",
    "The terminal already shows the raw tool output to the user.",
    "Do not restate raw output line-by-line or quote it verbatim unless the user explicitly asked for a transformation or summary.",
    "For listings, reads, and command output, prefer a one-sentence conclusion over repeating the visible lines.",
    "",
    `Tool: ${input.toolName}`,
    `Summary: ${input.summary}`
  ];

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  } else {
    lines.push("Raw output: (none)");
  }

  return lines.join("\n");
}

function buildDeniedContinuationPrompt(originalRequest: string) {
  return [
    `Original user request: ${originalRequest}`,
    "",
    TOOL_CALL_DENIED_PROMPT
  ].join("\n");
}

function buildToolFailureContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "The latest tool attempt failed.",
    "Do not repeat the raw failure twice.",
    "Explain the failure briefly and accurately.",
    "If another tool can help, return exactly one tool call block.",
    "Otherwise answer directly.",
    "The terminal already shows the raw tool output to the user.",
    "Do not restate stdout or stderr line-by-line unless one exact line is necessary to explain the next action.",
    "Prefer a short conclusion such as the key error, missing file, or exit code.",
    "",
    `Tool: ${input.toolName}`,
    `Summary: ${input.summary}`
  ];

  const replyHint = buildFailureReplyHint(input);

  if (replyHint) {
    lines.push(`Preferred answer style: ${replyHint}`);
  }

  if (input.errorMessage) {
    lines.push(`Error: ${input.errorMessage}`);
  }

  if (input.rawOutput && input.rawOutput !== input.errorMessage) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildAgentSystemPrompt(tools: ToolImplementation[]) {
  const lines = [
    "You are SelfMe, a terminal-first coding agent.",
    "Use tools when they materially help complete the user's request.",
    "When a tool is required, respond with exactly one tool call block and no prose before or after it.",
    `${TOOL_CALL_OPEN}`,
    '{"tool":"shell","input":{"command":"pwd"}}',
    `${TOOL_CALL_CLOSE}`,
    "Always place tool arguments inside the input object.",
    "Reply in the same language as the user's latest request unless the user explicitly asked for another language.",
    "If no tool is needed, answer normally.",
    "Prefer read before edit when you need to inspect a file.",
    "Use write to create or replace a whole file.",
    "Use edit to replace a specific line range or an entire existing file.",
    "When answering after a tool result, ground your answer strictly in the actual tool output.",
    "Do not invent files, directories, lines, commands, errors, or truncation that are not explicitly present in the latest tool result.",
    "If the latest tool result already fully answers the user, give a short direct answer instead of restating or embellishing the output.",
    "The terminal UI already shows raw tool output to the user, so do not repeat listings, file contents, stdout, or stderr line-by-line unless the user explicitly asked for that transformation.",
    "Prefer one concise conclusion sentence over echoing visible tool output.",
    "For directory listings, only mention entries that actually appear in the listing.",
    "Never invent tool names or input fields.",
    "Available tools:"
  ];

  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }

  lines.push('Example for reading a file: {"tool":"files","input":{"path":"note.txt","startLine":1,"endLine":20}}');
  lines.push('Example for editing a file: {"tool":"edit","input":{"path":"note.txt","startLine":2,"endLine":2,"replacement":"SELFME"}}');

  return lines.join("\n");
}

function buildFailureReplyHint(input: {
  toolName: string;
  summary: string;
  errorMessage?: string;
}) {
  if (input.toolName === "shell") {
    const exitCode = parseExitCode(input.summary) ?? parseExitCode(input.errorMessage);

    if (typeof exitCode === "number") {
      return `say in one short sentence that the command failed and mention exit code ${exitCode}; do not say the command simply ran or completed; reply in the same language as the user's latest request; if replying in Chinese, use wording very close to "命令执行失败，退出码为 ${exitCode}。"`; 
    }

    return "say in one short sentence that the command failed; do not say the command simply ran or completed; reply in the same language as the user's latest request; if replying in Chinese, use wording very close to \"命令执行失败。\"";
  }

  if (input.toolName === "files" && /ENOENT|no such file or directory/i.test(input.errorMessage ?? "")) {
    return "say in one sentence that the file does not exist; reply in the same language as the user's latest request; if replying in Chinese, prefer wording like \"该文件不存在。\"";
  }

  return undefined;
}

function parseExitCode(text?: string) {
  if (!text) {
    return undefined;
  }

  const match = text.match(/(?:failed\s*\((\d+)\)|exit code\s+(\d+))/i);
  const value = match?.[1] ?? match?.[2];

  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldAutoSummarizeToolFailure(originalRequest: string, input: {
  toolName: string;
  summary: string;
  errorMessage?: string;
}) {
  if (input.toolName !== "shell") {
    return false;
  }

  return isDirectShellExecutionRequest(originalRequest) && typeof parseExitCode(input.summary) === "number";
}

function buildDirectToolFailureAnswer(originalRequest: string, input: {
  summary: string;
  errorMessage?: string;
}) {
  const exitCode = parseExitCode(input.summary) ?? parseExitCode(input.errorMessage);

  if (typeof exitCode !== "number") {
    return undefined;
  }

  if (containsHanScript(originalRequest)) {
    return `命令执行失败，退出码为 ${exitCode}。`;
  }

  return `The command failed with exit code ${exitCode}.`;
}

function isDirectShellExecutionRequest(content: string) {
  const trimmed = content.trim();

  if (/^(运行|执行|run)\s+/i.test(trimmed)) {
    return true;
  }

  return /^(?:\.{0,2}\/\S+|~\/\S+|[a-z0-9_][a-z0-9_.-]*)(?:\s+.+)?$/.test(trimmed)
    && (/\s/.test(trimmed) || /^\.{0,2}\//.test(trimmed) || /^~\//.test(trimmed));
}

function containsHanScript(content: string) {
  return /[\p{Script=Han}]/u.test(content);
}

function classifyAssistantBuffer(content: string) {
  const trimmedStart = normalizeToolCallBufferPrefix(content);

  if (trimmedStart.length === 0) {
    return "pending" as const;
  }

  if (trimmedStart.includes(TOOL_CALL_OPEN)) {
    return "tool" as const;
  }

  if (hasTrailingToolCallPrefix(trimmedStart)) {
    return "pending" as const;
  }

  return "message" as const;
}

function hasTrailingToolCallPrefix(content: string) {
  const maxLength = Math.min(content.length, TOOL_CALL_OPEN.length - 1);

  for (let length = maxLength; length >= 1; length -= 1) {
    if (TOOL_CALL_OPEN.startsWith(content.slice(-length))) {
      return true;
    }
  }

  return false;
}

function parseAssistantToolCall(content: string): ParsedAssistantToolCall | undefined {
  const normalized = normalizeToolCallBufferPrefix(content).trim();
  const openIndex = normalized.indexOf(TOOL_CALL_OPEN);

  if (openIndex < 0) {
    return undefined;
  }

  const closeIndex = normalized.indexOf(TOOL_CALL_CLOSE, openIndex + TOOL_CALL_OPEN.length);
  const rawPayload = closeIndex >= 0
    ? normalized.slice(openIndex + TOOL_CALL_OPEN.length, closeIndex).trim()
    : normalized.slice(openIndex + TOOL_CALL_OPEN.length).trim();
  const jsonText = extractToolCallJsonCandidate(normalizeToolCallPayload(rawPayload));

  if (!jsonText) {
    return undefined;
  }

  let parsed: {
    tool?: unknown;
    input?: unknown;
    [key: string]: unknown;
  };

  try {
    parsed = JSON.parse(jsonText) as {
      tool?: unknown;
      input?: unknown;
    };
  } catch {
    const repaired = repairToolCallJson(jsonText);

    if (repaired) {
      try {
        parsed = JSON.parse(repaired) as {
          tool?: unknown;
          input?: unknown;
        };
      } catch {
        const loose = parseLooseAssistantToolCall(jsonText);

        if (!loose) {
          return undefined;
        }

        return loose;
      }
    } else {
      const loose = parseLooseAssistantToolCall(jsonText);

      if (!loose) {
        return undefined;
      }

      return loose;
    }
  }

  if (typeof parsed.tool !== "string" || parsed.tool.trim().length === 0) {
    return undefined;
  }

  const derivedInput = parsed.input ?? Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "tool")
  );

  return {
    tool: parsed.tool.trim(),
    input: derivedInput
  };
}

function looksLikeToolCallBuffer(content: string) {
  return normalizeToolCallBufferPrefix(content).includes(TOOL_CALL_OPEN);
}

function normalizeToolCallBufferPrefix(content: string) {
  let normalized = content.trimStart();

  if (!normalized.startsWith("```")) {
    return normalized;
  }

  const firstNewlineIndex = normalized.indexOf("\n");

  if (firstNewlineIndex < 0) {
    return "";
  }

  normalized = normalized.slice(firstNewlineIndex + 1).trimStart();

  if (normalized.endsWith("```")) {
    normalized = normalized.slice(0, -3).trimEnd();
  }

  return normalized;
}

function normalizeToolCallPayload(content: string) {
  let normalized = content.trim();

  if (normalized.startsWith("```")) {
    const firstNewlineIndex = normalized.indexOf("\n");

    if (firstNewlineIndex >= 0) {
      normalized = normalized.slice(firstNewlineIndex + 1).trimStart();
    }

    if (normalized.endsWith("```")) {
      normalized = normalized.slice(0, -3).trimEnd();
    }
  }

  if (normalized.startsWith("json\n")) {
    normalized = normalized.slice("json\n".length).trimStart();
  }

  return normalized.trim().replace(/;$/, "").trim();
}

function repairToolCallJson(content: string) {
  const normalized = content
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");

  return normalized === content ? undefined : normalized;
}

function extractToolCallJsonCandidate(content: string) {
  const trimmed = content.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const startIndex = trimmed.indexOf("{");

  if (startIndex < 0) {
    return trimmed;
  }

  const balanced = extractBalancedJsonObject(trimmed.slice(startIndex));
  return balanced ?? trimmed.slice(startIndex).trim();
}

function extractBalancedJsonObject(content: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return content.slice(0, index + 1);
      }
    }
  }

  return undefined;
}

function parseLooseAssistantToolCall(content: string): ParsedAssistantToolCall | undefined {
  const toolMatch = content.match(/"tool"\s*:\s*"([^"]+)"/i);
  const toolName = toolMatch?.[1]?.trim();

  if (!toolName) {
    return undefined;
  }

  if (toolName === "shell") {
    const command = extractLooseQuotedField(content, "command");

    if (!command) {
      return undefined;
    }

    return {
      tool: "shell",
      input: {
        command
      }
    };
  }

  return undefined;
}

function extractLooseQuotedField(content: string, fieldName: string) {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`"${escapedField}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|[}\\]])`, "i");
  const match = content.match(pattern);

  if (!match?.[1]) {
    return undefined;
  }

  return match[1].trim();
}

function createMalformedToolCallPreview(content: string, maxLength = 220) {
  const normalized = normalizeToolCallBufferPrefix(content)
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
