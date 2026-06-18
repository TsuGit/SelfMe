import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { ZodError } from "zod";

import type { EventBus } from "../app/event-bus.js";
import type { ProviderClient } from "../providers/base.js";
import type { LogStore } from "../storage/logs.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import type { ToolRegistry } from "../tools/base.js";
import type { ApprovalRequest } from "../types/approval.js";
import type { SessionRecord } from "../types/session.js";
import type { ToolImplementation } from "../types/tool.js";
import { getIncompleteSlashCommandNotice, parseBuiltInCommand, parseToolCommand, renderHelpLines } from "./commands.js";
import { buildContextMessages, createInlinePreview, projectSessionTimeline } from "./context-compaction.js";
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
import { extractExpectedOutputFromTaskRequest } from "./task-intent.js";

const STANDARD_AGENT_TOOL_STEPS = 6;
const EXTENDED_AGENT_TOOL_STEPS = 10;
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const TOOL_CALL_DENIED_PROMPT = "The requested tool action was denied by the user. Continue without that action. If you can still help, answer directly. If another tool is needed, return exactly one tool call block.";

interface ParsedAssistantToolCall {
  tool: string;
  input: unknown;
}

type PreferredReplyLanguage = "zh" | "en";

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
  private readonly taskApprovalGrants = new Map<string, Set<string>>();
  private readonly taskOriginalRequests = new Map<string, string>();
  private readonly taskKnownPaths = new Map<string, Set<string>>();
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

    if (!persistUserMessage && builtInCommand === "help") {
      await this.processCommandOnlyInput({
        sessionId,
        content
      });
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
    const commandNotice = getIncompleteSlashCommandNotice(input.content);

    if (commandNotice) {
      const runtimeError = createRuntimeErrorRaisedEvent({
        sessionId: input.sessionId,
        message: commandNotice.message
      });
      this.input.bus.emit(runtimeError);
      return true;
    }

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

      let toolInput: unknown;

      try {
        toolInput = parseToolInput(tool, rawToolInput);
      } catch (error) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId: input.sessionId,
          message: formatDirectCommandInputError(toolName, error)
        });
        this.input.bus.emit(runtimeError);
        return true;
      }

      if (shouldRequestApproval(tool, toolInput)) {
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
    const historyEvents = await this.input.transcriptStore.readEventsBySession(sessionId);
    const responseTaskId = randomUUID();
    const originalRequest = resolveRunnableUserRequest(content, historyEvents);
    const maxToolSteps = getAgentToolStepBudget(originalRequest);
    const suppressMessageEmission = looksLikeNextStepProposalRequest(originalRequest);
    let nextPrompt = content;
    let hasAttemptedTool = false;
    let proposalNarrowingCount = 0;
    let repeatedToolResultCount = 0;
    let lastToolResult:
      | {
        toolName: string;
        summary: string;
        rawOutput?: string;
        errorMessage?: string;
      }
      | undefined;
    const activeRun = this.startActiveRun(sessionId, responseTaskId);
    this.taskOriginalRequests.set(responseTaskId, originalRequest);
    this.taskKnownPaths.set(responseTaskId, new Set(extractWritableTaskPaths(originalRequest)));
    const preferredLanguage = inferPreferredReplyLanguage(originalRequest, historyEvents);

    if (originalRequest !== content) {
      nextPrompt = originalRequest;
    }

    this.input.bus.emit(createTaskStateChangedEvent({
      sessionId,
      taskId: responseTaskId,
      state: "running",
      title: "Respond to user input"
    }));

    try {
      for (let step = 0; step <= maxToolSteps; step += 1) {
        const assistantPass = await this.runAssistantPass({
          sessionId,
          taskId: responseTaskId,
          content: nextPrompt,
          preferredLanguage,
          suppressMessageEmission,
          signal: activeRun.controller.signal
        });

        if (assistantPass.kind === "message") {
          if (
            proposalNarrowingCount === 0
            && shouldForceProposalNarrowing(originalRequest, assistantPass.messageText)
          ) {
            proposalNarrowingCount += 1;
            nextPrompt = buildProposalNarrowingPrompt(
              originalRequest,
              assistantPass.messageText,
              preferredLanguage
            );
            continue;
          }

          if (
            !hasAttemptedTool
            && shouldForceInitialTaskStart(originalRequest, assistantPass.messageText)
          ) {
            nextPrompt = buildPrematureTaskStartPrompt(
              originalRequest,
              assistantPass.messageText,
              preferredLanguage
            );
            continue;
          }

          if (
            lastToolResult
            && shouldForceTaskContinuation(originalRequest, assistantPass.messageText, lastToolResult)
          ) {
            nextPrompt = buildPrematureContinuationPrompt(
              originalRequest,
              assistantPass.messageText,
              lastToolResult,
              preferredLanguage
            );
            continue;
          }

          if (
            lastToolResult
            && shouldForceFailureRecovery(originalRequest, assistantPass.messageText, lastToolResult)
          ) {
            nextPrompt = buildFailureRecoveryPrompt(
              originalRequest,
              assistantPass.messageText,
              lastToolResult,
              preferredLanguage
            );
            continue;
          }

          if (
            lastToolResult
            && shouldForceExecutionConvergence(originalRequest, assistantPass.messageText, lastToolResult)
          ) {
            nextPrompt = buildExecutionConvergencePrompt(
              originalRequest,
              assistantPass.messageText,
              lastToolResult,
              preferredLanguage
            );
            continue;
          }

          if (
            lastToolResult
            && shouldForceCompletionTightening(originalRequest, assistantPass.messageText, lastToolResult)
          ) {
            nextPrompt = buildCompletionTighteningPrompt(
              originalRequest,
              assistantPass.messageText,
              lastToolResult,
              preferredLanguage
            );
            continue;
          }

          if (suppressMessageEmission && assistantPass.messageText.trim().length > 0) {
            const nextEvent = createAssistantDeltaEvent({
              sessionId,
              taskId: responseTaskId,
              delta: assistantPass.messageText
            });
            this.input.bus.emit(nextEvent);
            await this.input.transcriptStore.appendEvent(nextEvent);
          }

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

        if (step === maxToolSteps) {
          throw new Error(`Agent stopped after ${maxToolSteps} tool steps`);
        }

        const tool = this.input.tools.get(assistantPass.toolCall.tool);

        if (!tool) {
          throw new Error(`Unknown tool requested by model: ${assistantPass.toolCall.tool}`);
        }

        const toolInput = parseToolInput(tool, assistantPass.toolCall.input);
        hasAttemptedTool = true;
        const toolTaskResult = await this.requestToolFromAssistant({
          sessionId,
          rootTaskId: responseTaskId,
          tool,
          input: toolInput,
          signal: activeRun.controller.signal
        });

        if (toolTaskResult.kind === "denied") {
          nextPrompt = buildDeniedContinuationPrompt(originalRequest, preferredLanguage);
          continue;
        }

        if (toolTaskResult.kind === "failed") {
          repeatedToolResultCount = isSameToolResult(lastToolResult, toolTaskResult.result)
            ? repeatedToolResultCount + 1
            : 0;

          if (shouldAutoSummarizeToolFailure(originalRequest, toolTaskResult.result)) {
            const directAnswer = buildDirectToolFailureAnswer(toolTaskResult.result, preferredLanguage);

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

          lastToolResult = toolTaskResult.result;
          nextPrompt = shouldUseStalledContinuationPrompt(originalRequest, repeatedToolResultCount, toolTaskResult.result)
            ? buildStalledToolContinuationPrompt(originalRequest, toolTaskResult.result, repeatedToolResultCount, preferredLanguage)
            : buildToolFailureContinuationPrompt(originalRequest, toolTaskResult.result, preferredLanguage);
          continue;
        }

        const previousToolResult = lastToolResult;
        repeatedToolResultCount = isSameToolResult(lastToolResult, toolTaskResult.result)
          ? repeatedToolResultCount + 1
          : 0;
        lastToolResult = toolTaskResult.result;
        nextPrompt = shouldUseStalledContinuationPrompt(originalRequest, repeatedToolResultCount, toolTaskResult.result)
          ? buildStalledToolContinuationPrompt(originalRequest, toolTaskResult.result, repeatedToolResultCount, preferredLanguage)
          : previousToolResult && shouldCarryEditRangeFailureForward(previousToolResult, toolTaskResult.result)
            ? buildEditRangeRecoveryContinuationPrompt(originalRequest, previousToolResult, toolTaskResult.result, preferredLanguage)
            : buildToolContinuationPrompt(originalRequest, toolTaskResult.result, preferredLanguage);
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
    preferredLanguage: PreferredReplyLanguage;
    suppressMessageEmission: boolean;
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
        content: buildAgentSystemPrompt(this.input.tools.list(), input.preferredLanguage)
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
        if (input.suppressMessageEmission) {
          continue;
        }

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

        if (!input.suppressMessageEmission) {
          const nextEvent = createAssistantDeltaEvent({
            sessionId: input.sessionId,
            taskId: input.taskId,
            delta: pendingPrefix
          });
          this.input.bus.emit(nextEvent);
          await this.input.transcriptStore.appendEvent(nextEvent);
        }

        pendingPrefix = "";
      }
    }

    if (streamedVisible) {
      return {
        kind: "message" as const,
        messageText: buffer
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
        kind: "message" as const,
        messageText: buffer
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
    rootTaskId: string;
    tool: ToolImplementation;
    input: unknown;
    signal: AbortSignal;
  }) {
    const toolTaskId = randomUUID();

    if (shouldRequestApproval(input.tool, input.input) && !hasTaskApprovalGrant(this.taskApprovalGrants, this.taskKnownPaths, input.rootTaskId, input.tool, input.input)) {
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

      grantTaskApproval(this.taskApprovalGrants, this.taskKnownPaths, input.rootTaskId, input.tool, input.input);
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

    rememberTaskKnownPath(this.taskKnownPaths, input.rootTaskId, input.tool, input.input);

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
    this.taskApprovalGrants.delete(taskId);
    this.taskOriginalRequests.delete(taskId);
    this.taskKnownPaths.delete(taskId);
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

function shouldRequestApproval(tool: ToolImplementation, input: unknown) {
  if (tool.approvalPolicy === "never") {
    return false;
  }

  if (tool.approvalPolicy === "always") {
    return true;
  }

  const descriptor = tool.buildApproval?.(input);
  return descriptor ? descriptor.risk !== "low" : true;
}

function hasTaskApprovalGrant(
  grants: Map<string, Set<string>>,
  knownPaths: Map<string, Set<string>>,
  taskId: string,
  tool: ToolImplementation,
  input: unknown
) {
  const grantSet = grants.get(taskId);

  if (!grantSet) {
    return false;
  }

  const targetPath = getWorkspaceWritePath(tool, input);

  if (targetPath) {
    return grantSet.has("task-known-write")
      && (knownPaths.get(taskId)?.has(normalizeApprovalPath(targetPath)) ?? false);
  }

  return false;
}

function grantTaskApproval(
  grants: Map<string, Set<string>>,
  knownPaths: Map<string, Set<string>>,
  taskId: string,
  tool: ToolImplementation,
  input: unknown
) {
  const targetPath = getWorkspaceWritePath(tool, input);

  if (!targetPath) {
    return;
  }

  const grantSet = grants.get(taskId) ?? new Set<string>();
  grantSet.add("task-known-write");
  grants.set(taskId, grantSet);
  rememberKnownPathSet(knownPaths, taskId, targetPath);
}

function getWorkspaceWritePath(tool: ToolImplementation, input: unknown) {
  if ((tool.name !== "write" && tool.name !== "edit") || !input || typeof input !== "object") {
    return undefined;
  }

  return "path" in input && typeof input.path === "string"
    ? input.path
    : undefined;
}

function getWorkspaceToolPath(tool: ToolImplementation, input: unknown) {
  if ((tool.name !== "files" && tool.name !== "write" && tool.name !== "edit") || !input || typeof input !== "object") {
    return undefined;
  }

  return "path" in input && typeof input.path === "string"
    ? input.path
    : undefined;
}

function extractWritableTaskPaths(request: string) {
  const quoted = [...request.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const paths = [
    ...quoted.flatMap((value) => extractPathsFromSnippet(value)),
    ...extractPathsFromSnippet(request.replace(/`[^`]+`/g, " "))
  ];

  return dedupeNormalizedPaths(paths);
}

function extractPathsFromSnippet(content: string) {
  const commandPath = extractCommandPath(content);
  const directPaths = [...content.matchAll(/\b([A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv))\b/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  return [
    ...(commandPath ? [commandPath] : []),
    ...directPaths
  ];
}

function dedupeNormalizedPaths(paths: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of paths) {
    const normalized = normalizeApprovalPath(path);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function extractCommandPath(command: string) {
  const match = command.match(/\b(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\s+([^\s]+?\.(?:mjs|js|ts|tsx|json|txt|md|csv))\b/i);
  return match?.[1]?.trim();
}

function normalizeApprovalPath(path: string) {
  return pathPosix.normalize(path.replace(/\\/g, "/").trim());
}

function rememberTaskKnownPath(
  knownPaths: Map<string, Set<string>>,
  taskId: string,
  tool: ToolImplementation,
  input: unknown
) {
  const path = getWorkspaceToolPath(tool, input);

  if (!path) {
    return;
  }

  rememberKnownPathSet(knownPaths, taskId, path);
}

function rememberKnownPathSet(
  knownPaths: Map<string, Set<string>>,
  taskId: string,
  path: string
) {
  const normalized = normalizeApprovalPath(path);

  if (!normalized) {
    return;
  }

  const set = knownPaths.get(taskId) ?? new Set<string>();
  set.add(normalized);
  knownPaths.set(taskId, set);
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

function formatDirectCommandInputError(toolName: string, error: unknown) {
  if (error instanceof ZodError) {
    const issue = error.issues[0];

    if (!issue) {
      return `Invalid /${toolName} input.`;
    }

    const field = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `Invalid /${toolName} input: ${field} ${issue.message}`;
  }

  return error instanceof Error
    ? error.message
    : `Invalid /${toolName} input.`;
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
}, preferredLanguage: PreferredReplyLanguage) {
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
    "If system context includes Recent task state, treat its Target verification and Working files as the current task anchor.",
    "Do not rerun earlier auxiliary commands or warmups when a later target verification command is already established.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Tool: ${input.toolName}`,
    `Summary: ${input.summary}`
  ];

  const actionHint = buildToolContinuationActionHint(originalRequest, input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = buildToolContinuationClueLines(originalRequest, input);

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  } else {
    lines.push("Raw output: (none)");
  }

  return lines.join("\n");
}

function buildEditRangeRecoveryContinuationPrompt(originalRequest: string, failedEdit: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}, currentRead: {
  toolName: string;
  summary: string;
  rawOutput?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "Continue the same task after a failed edit range attempt.",
    "You now have a fresh read of the target file.",
    "Use the actual file length from that read to choose the smallest valid edit range.",
    "Do not reread broader context or restart from configuration files.",
    "Return exactly one tool call block unless the task is already complete.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous edit failure: ${failedEdit.summary}`,
    `Latest tool: ${currentRead.toolName}`,
    `Latest summary: ${currentRead.summary}`
  ];

  const targetPath = extractPathFromToolSummary(currentRead.summary);
  const requestedRange = extractEditRangeFromSummary(failedEdit.errorMessage ?? failedEdit.rawOutput ?? failedEdit.summary);
  const actualRange = extractFileRangeFromError(failedEdit.errorMessage ?? failedEdit.rawOutput);

  if (targetPath) {
    lines.push(`Likely target file: ${targetPath}`);
  }

  if (requestedRange) {
    lines.push(`Requested edit range: ${requestedRange}`);
  }

  if (actualRange) {
    lines.push(`Actual file range: ${actualRange}`);
  }

  if (currentRead.rawOutput && currentRead.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(currentRead.rawOutput);
  }

  return lines.join("\n");
}

function buildPrematureContinuationPrompt(originalRequest: string, assistantMessage: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "You are still inside the same multi-step task.",
    "Your previous assistant message was only a progress update, not a completed result.",
    "Do not stop until the original request is actually completed.",
    "If more work is needed, return exactly one tool call block.",
    "Only answer directly after the requested read/create/edit/verification work is truly finished.",
    "Do not apologize or restate the same status update.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`,
    `Latest tool: ${input.toolName}`,
    `Latest summary: ${input.summary}`
  ];

  const clueLines = buildToolContinuationClueLines(originalRequest, input);

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildStalledToolContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}, repeatedCount: number, preferredLanguage: PreferredReplyLanguage) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "The latest tool result repeated without progress.",
    `Repeated identical result count: ${repeatedCount + 1}`,
    "Do not repeat the same tool step again unless you just changed the exact source that should affect this result.",
    "Pick a different targeted action that can change the outcome.",
    "If another tool is needed, return exactly one tool call block.",
    "Only answer directly when the original request is truly complete.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Tool: ${input.toolName}`,
    `Summary: ${input.summary}`
  ];

  const actionHint = buildStalledActionHint(originalRequest, input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = input.toolName === "shell"
    ? buildToolFailureClueLines(originalRequest, input)
    : [];

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildPrematureTaskStartPrompt(
  originalRequest: string,
  assistantMessage: string,
  preferredLanguage: PreferredReplyLanguage
) {
  return [
    `Original user request: ${originalRequest}`,
    "",
    "You have not started the requested work yet.",
    "Your previous assistant message described intent or a plan, but did not actually perform the task.",
    "For actionable requests, do the work now instead of describing what you will do.",
    "If tools are needed, return exactly one tool call block.",
    "Only answer directly when the request truly needs no tool work.",
    "Do not ask for permission to begin unless the user explicitly asked for discussion first.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`
  ].join("\n");
}

function buildProposalNarrowingPrompt(
  originalRequest: string,
  assistantMessage: string,
  preferredLanguage: PreferredReplyLanguage
) {
  return [
    `Original user request: ${originalRequest}`,
    "",
    "The user asked for only the next step, not a broad plan.",
    "Rewrite your previous answer as exactly one concrete next step.",
    "Do not list multiple options.",
    "Do not start doing the work yet.",
    "Keep it short and directly executable after a simple user confirmation.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`
  ].join("\n");
}

function buildFailureRecoveryPrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "A single failed tool result does not complete this task.",
    "Your previous assistant message stopped after a failure instead of continuing the repair loop.",
    "Keep working from the failure you already have.",
    "If tools are needed, return exactly one tool call block.",
    "Only answer directly if the task is truly blocked on missing user input or a denied permission.",
    "Do not just restate the failure.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`,
    `Latest tool: ${input.toolName}`,
    `Latest summary: ${input.summary}`
  ];

  const actionHint = buildFailureActionHint(input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = buildToolFailureClueLines(originalRequest, input);

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildExecutionConvergencePrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    "You are already inside the execution phase of a concrete task.",
    "Your previous assistant message explained the situation but did not advance the task.",
    "Do not stop for explanation-only updates.",
    "Take the next concrete step that moves the task forward.",
    "If tools are needed, return exactly one tool call block.",
    "Only answer directly when the task is actually complete or truly blocked on user input.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`,
    `Latest tool: ${input.toolName}`,
    `Latest summary: ${input.summary}`
  ];

  const actionHint = input.toolName === "shell"
    ? buildToolContinuationActionHint(originalRequest, input) ?? buildFailureActionHint(input)
    : buildToolContinuationActionHint(originalRequest, input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = input.toolName === "shell"
    ? buildToolFailureClueLines(originalRequest, input)
    : [];

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildCompletionTighteningPrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const taskTerminal = isLatestToolResultTaskTerminal(originalRequest, input);
  const lines = [
    `Original user request: ${originalRequest}`,
    "",
    taskTerminal
      ? "The latest tool result appears to satisfy the task, but your previous reply did not close it clearly."
      : "The latest tool result does not satisfy the task yet, so your previous reply cannot end the task.",
    taskTerminal
      ? "Give a short direct completion answer instead of a vague explanation."
      : "Continue the task instead of ending on explanation alone.",
    taskTerminal
      ? "Do not call more tools unless the latest result still does not actually satisfy the request."
      : "If tools are needed, return exactly one tool call block.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Previous assistant message: ${assistantMessage.trim() || "(empty)"}`,
    `Latest tool: ${input.toolName}`,
    `Latest summary: ${input.summary}`
  ];

  const actionHint = taskTerminal
    ? "answer directly in one short sentence that clearly states the completed outcome"
    : buildToolContinuationActionHint(originalRequest, input) ?? buildFailureActionHint(input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = input.toolName === "shell"
    ? buildToolFailureClueLines(originalRequest, input)
    : [];

  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }

  if (input.rawOutput && input.rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(input.rawOutput);
  }

  return lines.join("\n");
}

function buildDeniedContinuationPrompt(originalRequest: string, preferredLanguage: PreferredReplyLanguage) {
  return [
    `Original user request: ${originalRequest}`,
    "",
    TOOL_CALL_DENIED_PROMPT,
    buildPreferredReplyLanguageInstruction(preferredLanguage)
  ].join("\n");
}

function buildToolFailureContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}, preferredLanguage: PreferredReplyLanguage) {
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
    "If system context includes Recent task state, continue from its Target verification and Working files instead of restarting broader exploration.",
    "Do not go back to earlier auxiliary commands when the current task already has a later target verification command.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "",
    `Tool: ${input.toolName}`,
    `Summary: ${input.summary}`
  ];

  const replyHint = buildFailureReplyHint(input, preferredLanguage);

  if (replyHint) {
    lines.push(`Preferred answer style: ${replyHint}`);
  }

  const actionHint = buildFailureActionHint(input);

  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }

  const clueLines = buildToolFailureClueLines(originalRequest, input);

  if (clueLines.length > 0) {
    lines.push(...clueLines);
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

function buildAgentSystemPrompt(tools: ToolImplementation[], preferredLanguage: PreferredReplyLanguage) {
  const lines = [
    "You are SelfMe, a terminal-first coding agent.",
    "Use tools when they materially help complete the user's request.",
    "For actionable requests such as read, create, edit, fix, inspect, run, or verify, start doing the work instead of replying with a plan or status update.",
    "When a tool is required, respond with exactly one tool call block and no prose before or after it.",
    `${TOOL_CALL_OPEN}`,
    '{"tool":"shell","input":{"command":"pwd"}}',
    `${TOOL_CALL_CLOSE}`,
    "Always place tool arguments inside the input object.",
    buildPreferredReplyLanguageInstruction(preferredLanguage),
    "If no tool is needed, answer normally.",
    "Prefer read before edit when you need to inspect a file.",
    "Use write to create or replace a whole file.",
    "Use edit to replace a specific line range or an entire existing file.",
    "When answering after a tool result, ground your answer strictly in the actual tool output.",
    "Do not invent files, directories, lines, commands, errors, or truncation that are not explicitly present in the latest tool result.",
    "If the latest tool result already fully answers the user, give a short direct answer instead of restating or embellishing the output.",
    "The terminal UI already shows raw tool output to the user, so do not repeat listings, file contents, stdout, or stderr line-by-line unless the user explicitly asked for that transformation.",
    "Prefer one concise conclusion sentence over echoing visible tool output.",
    "When system context messages include Recent task state or Recent repair thread, use them to resume the current coding task before rereading unrelated files.",
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
}, preferredLanguage: PreferredReplyLanguage) {
  if (input.toolName === "shell") {
    const exitCode = parseExitCode(input.summary) ?? parseExitCode(input.errorMessage);
    const languageHint = describePreferredReplyLanguage(preferredLanguage);

    if (typeof exitCode === "number") {
      return `say in one short sentence that the command failed and mention exit code ${exitCode}; do not say the command simply ran or completed; reply in ${languageHint}; if replying in Chinese, use wording very close to "命令执行失败，退出码为 ${exitCode}。"`; 
    }

    return `say in one short sentence that the command failed; do not say the command simply ran or completed; reply in ${languageHint}; if replying in Chinese, use wording very close to "命令执行失败。"`;
  }

  if (input.toolName === "files" && /ENOENT|no such file or directory/i.test(input.errorMessage ?? "")) {
    return `say in one sentence that the file does not exist; reply in ${describePreferredReplyLanguage(preferredLanguage)}; if replying in Chinese, prefer wording like "该文件不存在。"`;
  }

  return undefined;
}

function buildFailureActionHint(input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (input.toolName === "edit") {
    const editText = [input.summary, input.errorMessage, input.rawOutput].filter(Boolean).join("\n");

    if (/outside the file range|Cannot edit line .* in an empty file/i.test(editText)) {
      return "reread the same target file immediately, use its actual line count, then retry the smallest valid edit range instead of exploring other files";
    }
  }

  if (input.toolName !== "shell") {
    return undefined;
  }

  const shellText = [input.summary, input.errorMessage, input.rawOutput].filter(Boolean).join("\n");

  if (/ERR_MODULE_NOT_FOUND|does not provide an export named|SyntaxError/i.test(shellText)) {
    return "prefer a targeted read of the source file named in the stack trace or import error, then make the smallest import/export fix instead of exploring unrelated files";
  }

  if (/ENOENT|no such file or directory/i.test(shellText)) {
    return "prefer a targeted read of the file or command source that references the missing path, then fix that path before doing broader exploration";
  }

  if (/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt):\d+/i.test(shellText)) {
    return "prefer the specific source file and line mentioned in the shell output before reading anything broader";
  }

  return "prefer the smallest follow-up tool step that is directly justified by the shell error output";
}

function buildStalledActionHint(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (input.toolName === "shell") {
    if (looksLikeExactOutputRequest(originalRequest)) {
      return "do not rerun the same verification command immediately; read or edit the most likely source file that can change this exact output first";
    }

    return "do not rerun the same shell command immediately; inspect or change the source most directly connected to this repeated result first";
  }

  if (input.toolName === "files") {
    return "do not reread the same file again right away; use the information you already have to choose a targeted edit, write, or verification step";
  }

  return "choose a different targeted step that can produce a new result instead of repeating the same action";
}

function buildToolContinuationActionHint(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
}) {
  if (input.toolName === "files") {
    const targetPath = extractPathFromToolSummary(input.summary);

    if (!targetPath || !looksLikeExecutionTask(originalRequest)) {
      return undefined;
    }

    if (looksLikeConfigurationSourcePath(targetPath)) {
      return "use this source data to choose the next targeted write, edit, or verification step; do not stop at analysis and do not reread broader context first";
    }

    if (looksLikeEditableSourcePath(targetPath)) {
      if (looksLikeExactOutputRequest(originalRequest)) {
        return "if this file already reveals the mismatch, prefer the smallest edit here and then rerun the established verification command";
      }

      return "use this file content to choose the smallest targeted edit or verification step instead of rereading more files";
    }

    return "use the file content you already have to choose a targeted next step instead of stopping at explanation";
  }

  if (input.toolName !== "shell") {
    return undefined;
  }

  if (!looksLikeExactOutputRequest(originalRequest)) {
    return undefined;
  }

  const shellText = [input.summary, input.rawOutput].filter(Boolean).join("\n");

  if (!shellText.trim()) {
    return undefined;
  }

  return "if the command output is close but not exact, prefer the smallest edit to the most likely source file and then rerun the same verification command";
}

function extractPathFromToolSummary(summary: string) {
  const match = summary.match(/^([A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv))(?::\d+(?:-\d+)?)?/);
  return match?.[1]?.trim();
}

function looksLikeConfigurationSourcePath(path: string) {
  return /\.(?:json|txt|csv|md)$/i.test(path);
}

function looksLikeEditableSourcePath(path: string) {
  return /\.(?:mjs|js|ts|tsx)$/i.test(path);
}

function buildToolFailureClueLines(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (input.toolName === "edit") {
    const clues: string[] = [];
    const targetPath = extractPathFromToolSummary(input.summary);
    const requestedRange = extractEditRangeFromSummary(input.summary);
    const actualRange = extractFileRangeFromError(input.errorMessage ?? input.rawOutput);

    if (targetPath) {
      clues.push(`Likely target file: ${targetPath}`);
    }

    if (requestedRange) {
      clues.push(`Requested edit range: ${requestedRange}`);
    }

    if (actualRange) {
      clues.push(`Actual file range: ${actualRange}`);
    }

    return dedupePromptLines(clues);
  }

  if (input.toolName !== "shell") {
    return [];
  }

  const shellText = [input.summary, input.errorMessage, input.rawOutput].filter(Boolean).join("\n");
  const clues: string[] = [];
  const command = extractShellCommandFromSummary(input.summary);
  const targetFile = deriveLikelyTargetFileForShellFailure(input.summary, shellText);
  const referencedLocation = extractReferencedLocation(shellText);
  const missingPath = extractMissingPath(shellText);
  const missingExport = extractMissingExportName(shellText);
  const expectedOutput = looksLikeExactOutputRequest(originalRequest)
    ? extractExpectedExactOutput(originalRequest)
    : undefined;

  if (command) {
    clues.push(`Verification command: ${command}`);
  }

  if (expectedOutput) {
    clues.push(`Expected output: ${expectedOutput}`);
  }

  if (targetFile) {
    clues.push(`Likely target file: ${targetFile}`);
  }

  if (referencedLocation && referencedLocation !== targetFile) {
    clues.push(`Referenced location: ${referencedLocation}`);
  }

  if (missingPath) {
    clues.push(`Missing path: ${missingPath}`);
  }

  if (missingExport) {
    clues.push(`Missing export: ${missingExport}`);
  }

  return dedupePromptLines(clues);
}

function buildToolContinuationClueLines(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
}) {
  if (input.toolName !== "shell") {
    return [];
  }

  const clues: string[] = [];
  const command = extractShellCommandFromSummary(input.summary);
  const expectedOutput = looksLikeExactOutputRequest(originalRequest)
    ? extractExpectedExactOutput(originalRequest)
    : undefined;
  const observedOutput = extractObservedShellOutput(input.rawOutput);

  if (command) {
    clues.push(`Verification command: ${command}`);
  }

  if (expectedOutput) {
    clues.push(`Expected output: ${expectedOutput}`);
  }

  if (observedOutput && expectedOutput && observedOutput !== expectedOutput) {
    clues.push(`Observed output: ${observedOutput}`);
  }

  return dedupePromptLines(clues);
}

function extractShellCommandFromSummary(summary: string) {
  const match = summary.match(/^(.+?)\s+·\s+(?:completed|failed(?:\s*\(\d+\))?|timed out|cancelled|running)\b/i);
  return match?.[1]?.trim();
}

function extractExpectedExactOutput(content: string) {
  return extractExpectedOutputFromTaskRequest(content);
}

function extractObservedShellOutput(rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0 || lines.length > 3) {
    return undefined;
  }

  const joined = lines.join(" | ");
  return joined.length <= 160 ? joined : undefined;
}

function extractMissingPath(content: string) {
  const patterns = [
    /Cannot find module ['"]([^'"]+)['"]/i,
    /ENOENT:.*?['"`]([^'"`]+)['"`]/i,
    /no such file or directory.*?['"`]([^'"`]+)['"`]/i
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractEditRangeFromSummary(summary: string) {
  const match = summary.match(/:(\d+(?:-\d+)?)\s+·/);
  return match?.[1]?.trim();
}

function extractFileRangeFromError(content?: string) {
  if (!content) {
    return undefined;
  }

  const match = content.match(/outside the file range\s+(\d+-\d+)/i);
  return match?.[1]?.trim();
}

function extractMissingExportName(content: string) {
  const match = content.match(/does not provide an export named ['"]([^'"]+)['"]/i);
  return match?.[1]?.trim();
}

function deriveLikelyTargetFileForShellFailure(summary: string, content: string) {
  const referencedLocation = extractReferencedLocation(content);
  const referencedFile = referencedLocation ? stripLineLocationSuffix(referencedLocation) : undefined;
  const commandSourceFile = extractShellCommandSourceFile(summary);
  const requestedModulePath = extractRequestedModulePath(content);
  const missingExport = extractMissingExportName(content);
  const resolutionBase = commandSourceFile ?? referencedFile;

  if (resolutionBase && requestedModulePath && missingExport) {
    return resolveRelativeModulePath(resolutionBase, requestedModulePath) ?? requestedModulePath;
  }

  if (resolutionBase && requestedModulePath && /^\.{1,2}\//.test(requestedModulePath)) {
    return resolutionBase;
  }

  return extractLikelyTargetFile(content);
}

function extractShellCommandSourceFile(summary: string) {
  const command = extractShellCommandFromSummary(summary);

  if (!command) {
    return undefined;
  }

  const match = command.match(/\b(?:node|tsx|bun|deno)\s+([^\s]+?\.(?:mjs|js|ts|tsx))\b/i);
  return match?.[1] ? normalizePromptPath(match[1]) : undefined;
}

function extractRequestedModulePath(content: string) {
  const match = content.match(/requested module ['"]([^'"]+)['"]/i);
  return match?.[1]?.trim();
}

function extractLikelyTargetFile(content: string) {
  const candidates = [
    ...matchAllGroups(content, /\b((?:src|config|apps?|packages?|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv))(?::\d+(?::\d+)?)?/g),
    ...matchAllGroups(content, /\b([A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv))(?::\d+(?::\d+)?)?/g)
  ]
    .map(normalizePromptPath)
    .map(stripLineLocationSuffix)
    .filter((value) => !value.startsWith("node:"))
    .filter((value) => !value.includes("/node_modules/"))
    .filter((value) => !value.startsWith("file:///"));

  return dedupePromptLines(candidates)[0];
}

function extractReferencedLocation(content: string) {
  const match = content.match(/\b([A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv):\d+(?::\d+)?)\b/);
  return match?.[1] ? normalizePromptPath(match[1].trim()) : undefined;
}

function stripLineLocationSuffix(value: string) {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function normalizePromptPath(value: string) {
  const trimmed = value.trim();
  const relativeMatch = trimmed.match(/((?:src|config|apps?|packages?|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv)(?::\d+(?::\d+)?)?)/);

  if (relativeMatch?.[1]) {
    return relativeMatch[1];
  }

  if (trimmed.startsWith("file:///")) {
    return trimmed.slice("file:///".length);
  }

  return trimmed;
}

function resolveRelativeModulePath(fromFile: string, target: string) {
  if (!/^\.{1,2}\//.test(target)) {
    return undefined;
  }

  return pathPosix.normalize(pathPosix.join(pathPosix.dirname(fromFile), target));
}

function matchAllGroups(content: string, pattern: RegExp) {
  return [...content.matchAll(pattern)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function dedupePromptLines(lines: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = line.trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
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

function buildDirectToolFailureAnswer(input: {
  summary: string;
  errorMessage?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const exitCode = parseExitCode(input.summary) ?? parseExitCode(input.errorMessage);

  if (typeof exitCode !== "number") {
    return undefined;
  }

  if (preferredLanguage === "zh") {
    return `命令执行失败，退出码为 ${exitCode}。`;
  }

  return `The command failed with exit code ${exitCode}.`;
}

function inferPreferredReplyLanguage(
  originalRequest: string,
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
): PreferredReplyLanguage {
  const currentLanguage = detectExplicitLanguageCue(originalRequest);

  if (currentLanguage) {
    return currentLanguage;
  }

  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];

    if (event?.type !== "user.message.submitted") {
      continue;
    }

    const candidate = detectExplicitLanguageCue(event.payload.content);

    if (candidate) {
      return candidate;
    }
  }

  return "en";
}

function detectExplicitLanguageCue(content: string): PreferredReplyLanguage | undefined {
  const trimmed = content.trim();

  if (!trimmed || trimmed.startsWith("/")) {
    return undefined;
  }

  if (containsHanScript(trimmed)) {
    return "zh";
  }

  if (/^(run|read|write|edit|shell)\b/i.test(trimmed)) {
    return "en";
  }

  if (!isDirectShellExecutionRequest(trimmed) && /[A-Za-z]/.test(trimmed)) {
    return "en";
  }

  return undefined;
}

function buildPreferredReplyLanguageInstruction(preferredLanguage: PreferredReplyLanguage) {
  return preferredLanguage === "zh"
    ? "Reply in Simplified Chinese unless the user explicitly asked for another language."
    : "Reply in English unless the user explicitly asked for another language.";
}

function resolveRunnableUserRequest(
  content: string,
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  if (isResumeFollowUp(content)) {
    const previousUserTask = extractPreviousActionableUserRequest(historyEvents);

    if (previousUserTask) {
      return [
        `The user replied "${content.trim()}" and wants to continue the most recent unfinished task.`,
        "Resume that task now instead of treating this as a discussion question.",
        "Continue from the latest task state already in context.",
        `Original task: ${previousUserTask}`
      ].join("\n");
    }
  }

  if (!isAffirmativeFollowUp(content)) {
    return content;
  }

  const previousAssistantProposal = extractPreviousAssistantProposal(historyEvents);

  if (!previousAssistantProposal) {
    return content;
  }

  return [
    `The user replied "${content.trim()}" to approve the immediately previous proposal.`,
    "Carry out that approved proposal now instead of restating it.",
    `Approved proposal: ${previousAssistantProposal}`
  ].join("\n");
}

function isResumeFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 24) {
    return false;
  }

  return /^(还能继续吗|能继续吗|继续吗|还能接着做吗|能接着做吗|接着来|接着做|继续做|继续搞|继续弄|继续干)$/iu.test(normalized);
}

function isAffirmativeFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 24) {
    return false;
  }

  if (/^(可以|行|好|好的|好啊|继续|开始吧|来吧|弄吧|搞吧|干吧|没问题|行吧|可以了|继续吧|yes|ok|okay|sure|go ahead|please do)$/iu.test(normalized)) {
    return true;
  }

  return /^(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧)(?:[\s,，。!！?？/]+(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧))+$/iu.test(normalized);
}

function extractPreviousActionableUserRequest(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);
  let skippedLatestUser = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (
      entry?.kind === "user"
      && !isAffirmativeFollowUp(entry.text)
      && !isResumeFollowUp(entry.text)
      && looksLikeActionableTaskRequest(entry.text)
    ) {
      return entry.text;
    }
  }

  return undefined;
}

function extractPreviousAssistantProposal(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);
  let skippedLatestUser = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (entry?.kind === "assistant" && looksLikeAssistantProposal(entry.text)) {
      return entry.text;
    }
  }

  return undefined;
}

function looksLikeAssistantProposal(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  const hasOffer = /\b(if you want|if you'd like|i can|next step|if you want me to continue)\b/i.test(normalized)
    || /(如果你愿意|如果你要我继续|我下一步可以|我可以继续|下一步可以)/u.test(normalized);
  const hasAction = /\b(read|write|edit|fix|repair|create|update|change|modify|inspect|run)\b/i.test(normalized)
    || /(读取|写入|编辑|修复|创建|更新|修改|检查|运行|改)/u.test(normalized);

  return hasOffer && hasAction;
}

function shouldForceTaskContinuation(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeLongRunningTask(originalRequest)) {
    return false;
  }

  if (isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  return looksLikeProgressOnlyAssistantReply(assistantMessage);
}

function shouldForceFailureRecovery(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!isToolExecutionFailureSummary(latestToolResult.summary)) {
    return false;
  }

  if (!looksLikeLongRunningTask(originalRequest) || isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (looksLikeBlockingQuestion(assistantMessage)) {
    return false;
  }

  return !looksLikeCompletionReply(assistantMessage);
}

function shouldForceExecutionConvergence(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (isToolExecutionFailureSummary(latestToolResult.summary)) {
    return false;
  }

  if (!looksLikeExecutionTask(originalRequest) || isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  if (looksLikeBlockingQuestion(assistantMessage) || looksLikeProgressOnlyAssistantReply(assistantMessage)) {
    return false;
  }

  return !looksLikeCompletionReply(assistantMessage);
}

function shouldForceCompletionTightening(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (isDirectShellExecutionRequest(originalRequest) || looksLikeBlockingQuestion(assistantMessage)) {
    return false;
  }

  if (!looksLikeLongRunningTask(originalRequest) && !looksLikeExecutionTask(originalRequest)) {
    return false;
  }

  const taskTerminal = isLatestToolResultTaskTerminal(originalRequest, latestToolResult);

  if (!taskTerminal) {
    return !looksLikeProgressOnlyAssistantReply(assistantMessage);
  }

  return !looksLikeCompletionReply(assistantMessage);
}

function shouldForceInitialTaskStart(originalRequest: string, assistantMessage: string) {
  if (!looksLikeActionableTaskRequest(originalRequest)) {
    return false;
  }

  return looksLikeProgressOnlyAssistantReply(assistantMessage);
}

function shouldForceProposalNarrowing(originalRequest: string, assistantMessage: string) {
  if (!looksLikeNextStepProposalRequest(originalRequest)) {
    return false;
  }

  return looksLikeBroadProposalReply(assistantMessage);
}

function shouldUseStalledContinuationPrompt(originalRequest: string, repeatedToolResultCount: number, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (repeatedToolResultCount < 1) {
    return false;
  }

  if (!looksLikeActionableTaskRequest(originalRequest) || isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  return true;
}

function shouldCarryEditRangeFailureForward(
  previous:
    | {
      toolName: string;
      summary: string;
      rawOutput?: string;
      errorMessage?: string;
    }
    | undefined,
  current: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (!previous || previous.toolName !== "edit" || current.toolName !== "files") {
    return false;
  }

  const previousText = [previous.summary, previous.errorMessage, previous.rawOutput].filter(Boolean).join("\n");

  if (!/outside the file range|Cannot edit line .* in an empty file/i.test(previousText)) {
    return false;
  }

  const failedPath = extractPathFromToolSummary(previous.summary);
  const currentPath = extractPathFromToolSummary(current.summary);

  return Boolean(failedPath && currentPath && failedPath === currentPath);
}

function isSameToolResult(
  previous:
    | {
      toolName: string;
      summary: string;
      rawOutput?: string;
      errorMessage?: string;
    }
    | undefined,
  current: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (!previous) {
    return false;
  }

  return buildToolResultSignature(previous) === buildToolResultSignature(current);
}

function buildToolResultSignature(input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  return [
    input.toolName.trim(),
    input.summary.trim(),
    input.errorMessage?.trim() ?? "",
    input.rawOutput?.trim() ?? ""
  ].join("\n---\n");
}

function getAgentToolStepBudget(content: string) {
  return looksLikeExtendedCodingTask(content)
    ? EXTENDED_AGENT_TOOL_STEPS
    : STANDARD_AGENT_TOOL_STEPS;
}

function looksLikeExtendedCodingTask(content: string) {
  if (looksLikeDiscussionRequest(content)) {
    return false;
  }

  if (isDirectShellExecutionRequest(content)) {
    return false;
  }

  const hasMutationIntent = /\b(create|write|edit|fix|repair|update|change|modify)\b/i.test(content)
    || /(创建|写入|编辑|修复|更新|修改)/u.test(content);

  if (!hasMutationIntent) {
    return false;
  }

  return looksLikeVerificationRequest(content) || looksLikeExactOutputRequest(content);
}

function looksLikeExecutionTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || looksLikeNextStepProposalRequest(taskContent)) {
    return false;
  }

  const hasMutationIntent = /\b(create|write|edit|fix|repair|update|change|modify)\b/i.test(taskContent)
    || /(创建|写入|编辑|修复|更新|修改)/u.test(taskContent);

  if (!hasMutationIntent) {
    return false;
  }

  return looksLikeVerificationRequest(taskContent) || looksLikeExactOutputRequest(taskContent);
}

function looksLikeActionableTaskRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  if (isDirectShellExecutionRequest(taskContent)) {
    return true;
  }

  if (/\b(read|write|edit|fix|repair|create|inspect|run|verify|check|list|update|change|modify)\b/i.test(taskContent)) {
    return true;
  }

  if (/(读取|写入|编辑|修复|创建|检查|运行|验证|列出|修改|更新)/u.test(taskContent)) {
    return true;
  }

  return false;
}

function looksLikeNextStepProposalRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  return /\b(next step|what.*improve next|what.*do next)\b/i.test(taskContent)
    || /(下一步|接下来.*做什么|想.*改进什么)/u.test(taskContent);
}

function looksLikeLongRunningTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeExactOutputRequest(taskContent)) {
    return true;
  }

  if (/\b(verify|fix|repair|create|edit|update|change|inspect|keep working|keep verifying)\b/i.test(taskContent)) {
    return true;
  }

  if (/(验证|修复|创建|编辑|修改|更新|检查|继续|保持)/u.test(taskContent)) {
    return true;
  }

  return false;
}

function isLatestToolResultTaskTerminal(originalRequest: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (latestToolResult.toolName === "shell") {
    if (isToolExecutionFailureSummary(latestToolResult.summary)) {
      return false;
    }

    if (looksLikeExactOutputRequest(originalRequest)) {
      const expectedOutput = extractExpectedExactOutput(originalRequest);
      const observedOutput = extractObservedShellOutput(latestToolResult.rawOutput);
      return Boolean(expectedOutput && observedOutput && observedOutput === expectedOutput);
    }

    return /\bverify|run\b/i.test(originalRequest) || /(验证|运行)/u.test(originalRequest);
  }

  if ((latestToolResult.toolName === "write" || latestToolResult.toolName === "edit") && !looksLikeVerificationRequest(originalRequest)) {
    return true;
  }

  if (latestToolResult.toolName === "files") {
    return isFilesVerificationTerminal(originalRequest, latestToolResult.summary);
  }

  return false;
}

function isFilesVerificationTerminal(originalRequest: string, summary: string) {
  if (!looksLikeVerificationRequest(originalRequest)) {
    return false;
  }

  const path = extractPathFromToolSummary(summary);

  if (!path) {
    return false;
  }

  const requestedPaths = extractWritableTaskPaths(originalRequest);

  if (!requestedPaths.includes(normalizeApprovalPath(path))) {
    return false;
  }

  if (looksLikeEditableSourcePath(path)) {
    return false;
  }

  return true;
}

function looksLikeVerificationRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  return /\b(verify|run|test|check|keep working|keep verifying)\b/i.test(taskContent)
    || /(验证|运行|测试|检查|继续)/u.test(taskContent);
}

function looksLikeDiscussionRequest(content: string) {
  if (/\b(discuss|brainstorm|explain|why|architecture|tradeoff|plan|strategy)\b/i.test(content)) {
    return true;
  }

  return /(讨论|聊聊|为什么|架构|取舍|方案|计划|策略|先讨论)/u.test(content);
}

function extractEmbeddedTaskContent(content: string) {
  const approvedProposalMatch = content.match(/\bApproved proposal:\s*([\s\S]+)$/i);

  if (approvedProposalMatch?.[1]?.trim()) {
    return approvedProposalMatch[1].trim();
  }

  const originalTaskMatch = content.match(/\bOriginal task:\s*([\s\S]+)$/i);

  if (originalTaskMatch?.[1]?.trim()) {
    return originalTaskMatch[1].trim();
  }

  return content;
}

function looksLikeBlockingQuestion(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  return /\?\s*$/.test(normalized)
    || /\b(can you|could you|please provide|which|what path|what file)\b/i.test(normalized)
    || /(能否|可以提供|请提供|哪个|什么路径|什么文件|需要你提供)/u.test(normalized);
}

function looksLikeProgressOnlyAssistantReply(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  if (containsToolCallMarkup(normalized)) {
    return false;
  }

  if (/\b(done|completed|finished|verified|confirmed|exactly)\b/i.test(normalized)) {
    return false;
  }

  if (/(完成|已修复|已创建|已验证|已经|精确|确认)/u.test(normalized)) {
    return false;
  }

  return /\b(will|next|then|now|plan|going to|need to)\b/i.test(normalized)
    || /(接下来|下一步|然后|现在|将会|需要继续)/u.test(normalized)
    || normalized.length <= 220;
}

function containsToolCallMarkup(content: string) {
  return content.includes(TOOL_CALL_OPEN) || content.includes(TOOL_CALL_CLOSE);
}

function looksLikeCompletionReply(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  if (/\b(not finished|not complete|not done|still failing|still broken)\b/i.test(normalized)) {
    return false;
  }

  if (/(未完成|还没完成|尚未完成|任务未完成|仍然失败|还在失败|还没修好)/u.test(normalized)) {
    return false;
  }

  return /\b(done|completed|finished|verified|confirmed|exactly|updated|fixed|created)\b/i.test(normalized)
    || /(完成|已修复|已创建|已验证|已经|精确|确认|已更新)/u.test(normalized);
}

function looksLikeBroadProposalReply(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  const lineCount = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const multipleOptions = (normalized.match(/\b(i can|next step|also can)\b/ig)?.length ?? 0) >= 2
    || (normalized.match(/(我可以|下一步|也可以)/ug)?.length ?? 0) >= 2;
  const hasListMarkers = /(?:^|\n)\s*(?:[-*]|\d+\.)\s+/m.test(normalized);

  return hasListMarkers || multipleOptions || lineCount >= 3 || normalized.length > 220;
}

function describePreferredReplyLanguage(preferredLanguage: PreferredReplyLanguage) {
  return preferredLanguage === "zh" ? "Simplified Chinese" : "English";
}

function isDirectShellExecutionRequest(content: string) {
  const trimmed = content.trim();

  const prefixedMatch = trimmed.match(/^(运行|执行|run)\s+(.+)$/i);

  if (prefixedMatch) {
    return looksLikeStandaloneShellCommand(prefixedMatch[2] ?? "");
  }

  return looksLikeStandaloneShellCommand(trimmed);
}

function looksLikeStandaloneShellCommand(content: string) {
  const trimmed = content.trim();

  if (!trimmed) {
    return false;
  }

  if (/[，。！？、]/u.test(trimmed)) {
    return false;
  }

  if (/[,.!?]\s+[A-Za-z\u4e00-\u9fff`]/u.test(trimmed)) {
    return false;
  }

  if (/\b(and|then|after|before|fix|create|verify|repair|keep)\b/i.test(trimmed)) {
    return false;
  }

  if (/(然后|再|继续|修复|创建|验证|保持)/u.test(trimmed)) {
    return false;
  }

  return /^(?:`[^`]+`|\.{0,2}\/\S+|~\/\S+|[a-z0-9_][a-z0-9_.-]*)(?:\s+.+)?$/i.test(trimmed)
    && (/\s/.test(trimmed) || /^`[^`]+`$/i.test(trimmed) || /^\.{0,2}\//.test(trimmed) || /^~\//.test(trimmed));
}

function looksLikeExactOutputRequest(content: string) {
  return /\bexact(?:ly)?\b/i.test(content) || /(精确|严格).*(输出|打印)|(输出|打印).*(精确|严格)/u.test(content);
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
