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
  createAssistantCheckpointRecordedEvent,
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

const STANDARD_AGENT_TOOL_STEPS = 8;
const EXTENDED_AGENT_TOOL_STEPS = 16;
const VERIFICATION_AGENT_TOOL_STEPS = 24;
const PROJECT_AGENT_TOOL_STEPS = 32;
const ASSISTANT_PASS_MULTIPLIER = 4;
const MAX_AUTO_STEP_LIMIT_CONTINUATIONS = 2;
const MAX_AUTO_ASSISTANT_PASS_LIMIT_CONTINUATIONS = 1;
const MAX_AUTO_TOOL_RECOVERY_CONTINUATIONS = 1;
const MAX_AUTO_REPEATED_STALL_CONTINUATIONS = 1;
const MAX_REPEATED_IDENTICAL_TOOL_RESULTS = 2;
const MAX_REPEATED_IDENTICAL_ASSISTANT_MESSAGES = 2;
const MAX_MALFORMED_TOOL_CALL_RETRIES = 1;
const MAX_UNKNOWN_TOOL_RETRIES = 1;
const MAX_INVALID_TOOL_INPUT_RETRIES = 1;
const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const TOOL_CALL_DENIED_PROMPT = "The requested tool action was denied by the user. Continue without that action. If you can still help, answer directly. If another tool is needed, return exactly one tool call block.";
const SCRIPT_ENTRY_DIR_HINTS = new Set([
  "src",
  "app",
  "apps",
  "packages",
  "docs",
  "scripts",
  "bin",
  "cli",
  "server",
  "services",
  "workers",
  "examples",
  "example",
  "demo",
  "demos",
  "lib"
]);

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

interface RuntimeToolResult {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}

interface AnchoredRuntimeToolResult extends RuntimeToolResult {
  workingFileAnchor?: string;
}

type AssistantMessageStepResult =
  | {
    kind: "continue";
    nextPrompt: string;
    proposalNarrowingCount: number;
    lastDeferredAssistantStageSignature?: string;
  }
  | {
    kind: "completed";
    directAnswer?: string;
    proposalNarrowingCount: number;
    lastDeferredAssistantStageSignature?: string;
  };

type AssistantToolStepResult =
  | {
    kind: "continue";
    nextPrompt: string;
    repeatedToolResultCount: number;
    lastToolResult?: RuntimeToolResult;
  }
  | {
    kind: "completed";
    directAnswer?: string;
    repeatedToolResultCount: number;
    lastToolResult?: RuntimeToolResult;
  };

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
  private readonly taskLatestEditablePaths = new Map<string, string>();
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
      if (await this.tryResolveNaturalApprovalShortcut(event.sessionId, event.payload.content)) {
        return;
      }

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

      let validatedInput: unknown;

      try {
        validatedInput = parseToolInput(tool, event.payload.input);
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

        const errorMessage = error instanceof Error ? error.message : "Tool execution failed";

        if (validatedInput !== undefined) {
          const summary = buildThrownToolFailureSummary(event.payload.toolName, validatedInput);

          await this.input.logStore.append({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            kind: "summary",
            content: summary
          });
          await this.input.logStore.append({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            kind: "stderr",
            content: errorMessage
          });

          const completed = createToolExecutionCompletedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            toolName: event.payload.toolName,
            summary,
            rawOutput: errorMessage
          });
          this.input.bus.emit(completed);
          await this.input.transcriptStore.appendEvent(completed);
        } else {
          const runtimeError = createRuntimeErrorRaisedEvent({
            sessionId: event.sessionId,
            taskId: event.taskId,
            message: errorMessage
          });
          this.input.bus.emit(runtimeError);
          await this.input.transcriptStore.appendEvent(runtimeError);
        }

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
      if (!this.pendingApprovals.has(approvalId)) {
        const runtimeError = createRuntimeErrorRaisedEvent({
          sessionId,
          message: `Unknown approval id: ${approvalId}`
        });
        this.input.bus.emit(runtimeError);
        return true;
      }

      await this.resolvePendingApprovalDecision(sessionId, approvalId, action === "approve");
      return true;
    }

    if (await this.tryResolveNaturalApprovalShortcut(sessionId, content)) {
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

  private async tryResolveNaturalApprovalShortcut(sessionId: string, content: string) {
    const decision = detectNaturalApprovalDecision(content);

    if (!decision) {
      return false;
    }

    const pendingApprovals = this.listPendingApprovalsForSession(sessionId);

    if (pendingApprovals.length === 0) {
      return false;
    }

    if (pendingApprovals.length > 1) {
      const runtimeError = createRuntimeErrorRaisedEvent({
        sessionId,
        message: "Multiple approvals are pending. Use /approve <approval-id> or /deny <approval-id>."
      });
      this.input.bus.emit(runtimeError);
      return true;
    }

    await this.resolvePendingApprovalDecision(
      sessionId,
      pendingApprovals[0].request.approvalId,
      decision === "approve"
    );
    return true;
  }

  private listPendingApprovalsForSession(sessionId: string) {
    return [...this.pendingApprovals.values()].filter((pending) => pending.request.sessionId === sessionId);
  }

  private async resolvePendingApprovalDecision(sessionId: string, approvalId: string, approved: boolean) {
    const pending = this.pendingApprovals.get(approvalId);

    if (!pending) {
      return;
    }

    const resolved = createApprovalResolvedEvent({
      sessionId,
      taskId: pending.request.taskId,
      approvalId,
      approved
    });
    this.input.bus.emit(resolved);
    await this.input.transcriptStore.appendEvent(resolved);

    this.pendingApprovals.delete(approvalId);

    if (pending.request.taskId) {
      this.setActivePendingApproval(pending.request.taskId, undefined);
    }

    if (approved && !pending.autoContinue) {
      const toolEvent = createToolExecutionRequestedEvent({
        sessionId,
        taskId: pending.request.taskId,
        toolName: pending.toolName,
        input: pending.input
      });
      this.input.bus.emit(toolEvent);
      await this.input.transcriptStore.appendEvent(toolEvent);
    }
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
    const suppressMessageEmission = looksLikeNextStepProposalRequest(originalRequest)
      || shouldDeferAssistantMessageEmission(originalRequest);
    let nextPrompt = content;
    let hasAttemptedTool = false;
    let proposalNarrowingCount = 0;
    let repeatedToolResultCount = 0;
    let lastDeferredAssistantStageSignature: string | undefined;
    let lastToolResult: RuntimeToolResult | undefined;
    let lastAssistantMessageSignature: string | undefined;
    let repeatedAssistantMessageCount = 0;
    let lastAssistantLoopSignature: string | undefined;
    let repeatedAssistantLoopCount = 0;
    let malformedToolCallRetryCount = 0;
    let unknownToolRetryCount = 0;
    let invalidToolInputRetryCount = 0;
    let autoStepLimitContinuationCount = 0;
    let autoAssistantPassContinuationCount = 0;
    let autoToolRecoveryContinuationCount = 0;
    let autoRepeatedToolStallContinuationCount = 0;
    let autoRepeatedAssistantStallContinuationCount = 0;
    const activeRun = this.startActiveRun(sessionId, responseTaskId);
    this.taskOriginalRequests.set(responseTaskId, originalRequest);
    this.taskKnownPaths.set(responseTaskId, new Set(extractWritableTaskPaths(originalRequest)));
    this.taskLatestEditablePaths.delete(responseTaskId);
    const preferredLanguage = inferPreferredReplyLanguage(originalRequest, historyEvents);

    if (originalRequest !== content) {
      nextPrompt = originalRequest;
    }

    this.startRuntimeTask(sessionId, responseTaskId);

    try {
      const maxAssistantPasses = maxToolSteps * ASSISTANT_PASS_MULTIPLIER;
      let assistantPassCount = 0;
      let toolStepCount = 0;

      while (true) {
        if (assistantPassCount === maxAssistantPasses) {
          const pendingTargetPath = extractPendingTargetPathFromContinuationPrompt(nextPrompt)
            ?? derivePendingTargetPathFromContinuationContext({
              originalRequest,
              previousToolResult: lastToolResult
            });

          await this.recordContinuationPendingCheckpoint({
            sessionId,
            taskId: responseTaskId,
            originalRequest,
            nextPrompt,
            previousToolResult: lastToolResult
          });

          if (
            pendingTargetPath
            && autoAssistantPassContinuationCount < MAX_AUTO_ASSISTANT_PASS_LIMIT_CONTINUATIONS
            && shouldAutoContinueAfterStepLimit(originalRequest, pendingTargetPath)
          ) {
            autoAssistantPassContinuationCount += 1;
            nextPrompt = buildAssistantPassLimitAutoContinuationPrompt({
              originalRequest,
              targetPath: pendingTargetPath,
              previousToolResult: lastToolResult
            });
            assistantPassCount = 0;
            malformedToolCallRetryCount = 0;
            unknownToolRetryCount = 0;
            invalidToolInputRetryCount = 0;
            continue;
          }

          throw new Error(`Agent stopped after ${maxAssistantPasses} assistant passes`);
        }

        assistantPassCount += 1;
        const workingFileAnchor = this.taskLatestEditablePaths.get(responseTaskId);
        const assistantPass = await this.runAssistantPass({
          sessionId,
          taskId: responseTaskId,
          content: nextPrompt,
          preferredLanguage,
          suppressMessageEmission,
          signal: activeRun.controller.signal
        });

        if (assistantPass.kind === "malformed_tool_call") {
          malformedToolCallRetryCount += 1;

          if (malformedToolCallRetryCount > MAX_MALFORMED_TOOL_CALL_RETRIES) {
            await this.recordContinuationPendingCheckpoint({
              sessionId,
              taskId: responseTaskId,
              originalRequest,
              nextPrompt,
              previousToolResult: lastToolResult
            });

            if (
              autoToolRecoveryContinuationCount < MAX_AUTO_TOOL_RECOVERY_CONTINUATIONS
              && shouldAutoContinueAfterToolRecovery(originalRequest, nextPrompt, lastToolResult)
            ) {
              autoToolRecoveryContinuationCount += 1;
              nextPrompt = buildToolRecoveryAutoContinuationPrompt({
                originalRequest,
                nextPrompt,
                previousToolResult: lastToolResult,
                recoveryKind: "malformed tool call"
              });
              malformedToolCallRetryCount = 0;
              unknownToolRetryCount = 0;
              invalidToolInputRetryCount = 0;
              continue;
            }

            throw new Error(`Model emitted a malformed tool call: ${createMalformedToolCallPreview(assistantPass.rawBuffer)}`);
          }

          nextPrompt = buildMalformedToolCallRepairPrompt(
            originalRequest,
            assistantPass.rawBuffer,
            preferredLanguage
          );
          continue;
        }

        malformedToolCallRetryCount = 0;

        if (assistantPass.kind === "message") {
          unknownToolRetryCount = 0;
          invalidToolInputRetryCount = 0;
          if (
            !assistantPass.messageText.trim()
            && lastToolResult
            && isLatestToolResultTaskTerminal(originalRequest, lastToolResult)
          ) {
            await this.finishRuntimeTask({
              sessionId,
              taskId: responseTaskId,
              state: "completed",
              directAnswer: buildDirectTerminalCompletionAnswer(
                originalRequest,
                lastToolResult,
                preferredLanguage
              )
            });
            return;
          }

          const assistantMessageSignature = createAssistantStageSignature(assistantPass.messageText) ?? "__empty__";
          repeatedAssistantMessageCount = assistantMessageSignature === lastAssistantMessageSignature
            ? repeatedAssistantMessageCount + 1
            : 0;
          lastAssistantMessageSignature = assistantMessageSignature;
          const assistantLoopSignature = createAssistantLoopSignature(assistantPass.messageText) ?? "__empty__";
          repeatedAssistantLoopCount = assistantLoopSignature === lastAssistantLoopSignature
            ? repeatedAssistantLoopCount + 1
            : 0;
          lastAssistantLoopSignature = assistantLoopSignature;

          const messageStep = await this.processAssistantMessagePass({
            sessionId,
            taskId: responseTaskId,
            originalRequest,
            preferredLanguage,
            assistantPass,
            hasAttemptedTool,
            proposalNarrowingCount,
            lastToolResult,
            workingFileAnchor,
            lastDeferredAssistantStageSignature,
            repeatedAssistantMessageCount
          });

          proposalNarrowingCount = messageStep.proposalNarrowingCount;
          lastDeferredAssistantStageSignature = messageStep.lastDeferredAssistantStageSignature;

          if (messageStep.kind === "completed") {
            await this.finishRuntimeTask({
              sessionId,
              taskId: responseTaskId,
              state: "completed",
              directAnswer: messageStep.directAnswer
            });
            return;
          }

          if (
            shouldAbortForRepeatedAssistantStall({
              originalRequest,
              repeatedAssistantMessageCount: repeatedAssistantLoopCount,
              assistantMessage: assistantPass.messageText,
              latestToolResult: lastToolResult
            })
          ) {
            await this.recordContinuationPendingCheckpoint({
              sessionId,
              taskId: responseTaskId,
              originalRequest,
              nextPrompt: messageStep.nextPrompt,
              previousToolResult: lastToolResult
            });

            if (
              autoRepeatedAssistantStallContinuationCount < MAX_AUTO_REPEATED_STALL_CONTINUATIONS
              && shouldAutoContinueAfterRepeatedStall(originalRequest, messageStep.nextPrompt, lastToolResult)
            ) {
              autoRepeatedAssistantStallContinuationCount += 1;
              nextPrompt = buildRepeatedStallAutoContinuationPrompt({
                originalRequest,
                nextPrompt: messageStep.nextPrompt,
                previousToolResult: lastToolResult,
                stallKind: "repeated identical assistant replies"
              });
              repeatedAssistantMessageCount = 0;
              repeatedAssistantLoopCount = 0;
              lastAssistantMessageSignature = undefined;
              lastAssistantLoopSignature = undefined;
              malformedToolCallRetryCount = 0;
              unknownToolRetryCount = 0;
              invalidToolInputRetryCount = 0;
              continue;
            }

            throw new Error(buildRepeatedAssistantStallError(assistantPass.messageText));
          }

          nextPrompt = messageStep.nextPrompt;
          continue;
        }

        const requestedTool = this.input.tools.get(assistantPass.toolCall.tool);

        if (!requestedTool) {
          unknownToolRetryCount += 1;

          if (unknownToolRetryCount > MAX_UNKNOWN_TOOL_RETRIES) {
            await this.recordContinuationPendingCheckpoint({
              sessionId,
              taskId: responseTaskId,
              originalRequest,
              nextPrompt,
              previousToolResult: lastToolResult
            });

            if (
              autoToolRecoveryContinuationCount < MAX_AUTO_TOOL_RECOVERY_CONTINUATIONS
              && shouldAutoContinueAfterToolRecovery(originalRequest, nextPrompt, lastToolResult)
            ) {
              autoToolRecoveryContinuationCount += 1;
              nextPrompt = buildToolRecoveryAutoContinuationPrompt({
                originalRequest,
                nextPrompt,
                previousToolResult: lastToolResult,
                recoveryKind: `unknown tool ${assistantPass.toolCall.tool}`
              });
              malformedToolCallRetryCount = 0;
              unknownToolRetryCount = 0;
              invalidToolInputRetryCount = 0;
              continue;
            }

            throw new Error(`Unknown tool requested by model: ${assistantPass.toolCall.tool}`);
          }

          nextPrompt = buildUnknownToolRepairPrompt(
            originalRequest,
            assistantPass.toolCall.tool,
            this.input.tools.list().map((tool) => tool.name),
            preferredLanguage
          );
          continue;
        }

        unknownToolRetryCount = 0;
        let validatedToolInput: unknown;

        try {
          validatedToolInput = parseToolInput(requestedTool, assistantPass.toolCall.input);
          invalidToolInputRetryCount = 0;
        } catch (error) {
          invalidToolInputRetryCount += 1;

          if (invalidToolInputRetryCount > MAX_INVALID_TOOL_INPUT_RETRIES) {
            await this.recordContinuationPendingCheckpoint({
              sessionId,
              taskId: responseTaskId,
              originalRequest,
              nextPrompt,
              previousToolResult: lastToolResult
            });

            if (
              autoToolRecoveryContinuationCount < MAX_AUTO_TOOL_RECOVERY_CONTINUATIONS
              && shouldAutoContinueAfterToolRecovery(originalRequest, nextPrompt, lastToolResult)
            ) {
              autoToolRecoveryContinuationCount += 1;
              nextPrompt = buildToolRecoveryAutoContinuationPrompt({
                originalRequest,
                nextPrompt,
                previousToolResult: lastToolResult,
                recoveryKind: `invalid ${requestedTool.name} input`
              });
              malformedToolCallRetryCount = 0;
              unknownToolRetryCount = 0;
              invalidToolInputRetryCount = 0;
              continue;
            }

            throw error;
          }

          nextPrompt = buildInvalidToolInputRepairPrompt(
            originalRequest,
            requestedTool.name,
            error,
            preferredLanguage
          );
          continue;
        }

        if (toolStepCount === maxToolSteps) {
          const pendingTargetPath = extractPendingTargetPathFromToolRequest(
            requestedTool.name,
            validatedToolInput
          );

          await this.recordStepLimitPendingCheckpoint({
            sessionId,
            taskId: responseTaskId,
            originalRequest,
            toolName: requestedTool.name,
            toolInput: validatedToolInput,
            previousToolResult: lastToolResult
          });

          if (
            pendingTargetPath
            && autoStepLimitContinuationCount < MAX_AUTO_STEP_LIMIT_CONTINUATIONS
            && shouldAutoContinueAfterStepLimit(originalRequest, pendingTargetPath)
          ) {
            autoStepLimitContinuationCount += 1;
            nextPrompt = buildStepLimitAutoContinuationPrompt({
              originalRequest,
              targetPath: pendingTargetPath,
              previousToolResult: lastToolResult
            });
            toolStepCount = 0;
            assistantPassCount = 0;
            malformedToolCallRetryCount = 0;
            unknownToolRetryCount = 0;
            invalidToolInputRetryCount = 0;
            continue;
          }

          throw new Error(`Agent stopped after ${maxToolSteps} tool steps`);
        }

        toolStepCount += 1;
        hasAttemptedTool = true;
        const toolStep = await this.processAssistantToolCall({
          sessionId,
          taskId: responseTaskId,
          originalRequest,
          preferredLanguage,
          tool: requestedTool,
          toolCall: assistantPass.toolCall,
          toolInput: validatedToolInput,
          previousToolResult: lastToolResult,
          previousRepeatedToolResultCount: repeatedToolResultCount,
          signal: activeRun.controller.signal
        });

        repeatedToolResultCount = toolStep.repeatedToolResultCount;
        lastToolResult = toolStep.lastToolResult;

        if (toolStep.kind === "completed") {
          await this.finishRuntimeTask({
            sessionId,
            taskId: responseTaskId,
            state: "completed",
            directAnswer: toolStep.directAnswer
          });
          return;
        }

        if (
          lastToolResult
          && shouldAbortForRepeatedToolStall({
            originalRequest,
            repeatedToolResultCount,
            latestToolResult: lastToolResult
          })
        ) {
          await this.recordContinuationPendingCheckpoint({
            sessionId,
            taskId: responseTaskId,
            originalRequest,
            nextPrompt: toolStep.nextPrompt,
            previousToolResult: lastToolResult
          });

          if (
            autoRepeatedToolStallContinuationCount < MAX_AUTO_REPEATED_STALL_CONTINUATIONS
            && shouldAutoContinueAfterRepeatedStall(originalRequest, toolStep.nextPrompt, lastToolResult)
          ) {
            autoRepeatedToolStallContinuationCount += 1;
            nextPrompt = buildRepeatedStallAutoContinuationPrompt({
              originalRequest,
              nextPrompt: toolStep.nextPrompt,
              previousToolResult: lastToolResult,
              stallKind: `repeated identical ${lastToolResult.toolName} results`
            });
            repeatedToolResultCount = 0;
            malformedToolCallRetryCount = 0;
            unknownToolRetryCount = 0;
            invalidToolInputRetryCount = 0;
            continue;
          }

          throw new Error(buildRepeatedToolStallError(lastToolResult));
        }

        nextPrompt = toolStep.nextPrompt;
      }

    } catch (error) {
      if (isAbortError(error)) {
        await this.finishRuntimeTask({
          sessionId,
          taskId: responseTaskId,
          state: "cancelled",
          ensureAssistantCompleted: true
        });
        this.emitTransientStatus(sessionId, "Stopped", "Current task stopped.");
        return;
      }

      await this.failRuntimeTask(
        sessionId,
        responseTaskId,
        error instanceof Error ? error.message : "Unknown runtime error"
      );
    } finally {
      this.clearActiveRun(responseTaskId);
    }
  }

  private async finishRuntimeTask(input: {
    sessionId: string;
    taskId: string;
    state: "completed" | "cancelled" | "failed";
    directAnswer?: string;
    ensureAssistantCompleted?: boolean;
  }) {
    if (input.directAnswer) {
      await this.emitAssistantFinalAnswer(input.sessionId, input.taskId, input.directAnswer);
    } else if (input.ensureAssistantCompleted) {
      await this.emitAssistantCompletion(input.sessionId, input.taskId);
    }

    await this.completeRuntimeTask(input.sessionId, input.taskId, input.state);
  }

  private startRuntimeTask(sessionId: string, taskId: string) {
    this.input.bus.emit(createTaskStateChangedEvent({
      sessionId,
      taskId,
      state: "running",
      title: "Respond to user input"
    }));
  }

  private async failRuntimeTask(sessionId: string, taskId: string, message: string) {
    await this.emitAssistantCompletion(sessionId, taskId);

    const runtimeError = createRuntimeErrorRaisedEvent({
      sessionId,
      taskId,
      message
    });
    this.input.bus.emit(runtimeError);
    await this.input.transcriptStore.appendEvent(runtimeError);

    await this.completeRuntimeTask(sessionId, taskId, "failed");
  }

  private async recordStepLimitPendingCheckpoint(input: {
    sessionId: string;
    taskId: string;
    originalRequest: string;
    toolName: string;
    toolInput: unknown;
    previousToolResult?: RuntimeToolResult;
  }) {
    const targetPath = extractPendingTargetPathFromToolRequest(input.toolName, input.toolInput);

    if (!targetPath) {
      return;
    }

    const checkpointContent = buildStepLimitPendingCheckpointContent({
      originalRequest: input.originalRequest,
      targetPath,
      previousToolResult: input.previousToolResult
    });
    const checkpointEvent = createAssistantCheckpointRecordedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      kind: "pending_next_step",
      content: checkpointContent,
      targetPath
    });
    this.input.bus.emit(checkpointEvent);
    await this.input.transcriptStore.appendEvent(checkpointEvent);
  }

  private async recordContinuationPendingCheckpoint(input: {
    sessionId: string;
    taskId: string;
    originalRequest: string;
    nextPrompt: string;
    previousToolResult?: RuntimeToolResult;
  }) {
    const targetPath = extractPendingTargetPathFromContinuationPrompt(input.nextPrompt)
      ?? derivePendingTargetPathFromContinuationContext({
        originalRequest: input.originalRequest,
        previousToolResult: input.previousToolResult
      });

    if (!targetPath) {
      return;
    }

    const checkpointContent = buildStepLimitPendingCheckpointContent({
      originalRequest: input.originalRequest,
      targetPath,
      previousToolResult: input.previousToolResult
    });
    const checkpointEvent = createAssistantCheckpointRecordedEvent({
      sessionId: input.sessionId,
      taskId: input.taskId,
      kind: "pending_next_step",
      content: checkpointContent,
      targetPath
    });
    this.input.bus.emit(checkpointEvent);
    await this.input.transcriptStore.appendEvent(checkpointEvent);
  }

  private async emitAssistantFinalAnswer(sessionId: string, taskId: string, delta: string) {
    const nextEvent = createAssistantDeltaEvent({
      sessionId,
      taskId,
      delta
    });
    this.input.bus.emit(nextEvent);
    await this.input.transcriptStore.appendEvent(nextEvent);
    await this.emitAssistantCompletion(sessionId, taskId);
  }

  private async emitAssistantCompletion(sessionId: string, taskId: string) {
    const completedEvent = createAssistantCompletedEvent({
      sessionId,
      taskId,
      model: this.input.session.model
    });
    this.input.bus.emit(completedEvent);
    await this.input.transcriptStore.appendEvent(completedEvent);
  }

  private async completeRuntimeTask(
    sessionId: string,
    taskId: string,
    state: "completed" | "cancelled" | "failed"
  ) {
    const taskEvent = createTaskStateChangedEvent({
      sessionId,
      taskId,
      state,
      title: "Respond to user input"
    });
    this.input.bus.emit(taskEvent);
    await this.input.transcriptStore.appendEvent(taskEvent);
  }

  private async processAssistantMessagePass(input: {
    sessionId: string;
    taskId: string;
    originalRequest: string;
    preferredLanguage: PreferredReplyLanguage;
    assistantPass: {
      kind: "message";
      messageText: string;
      messageWasEmitted: boolean;
    };
    hasAttemptedTool: boolean;
    proposalNarrowingCount: number;
    lastToolResult?: RuntimeToolResult;
    workingFileAnchor?: string;
    lastDeferredAssistantStageSignature?: string;
    repeatedAssistantMessageCount: number;
  }): Promise<AssistantMessageStepResult> {
    if (shouldAutoFinalizeRepeatedTerminalAssistantReply({
      originalRequest: input.originalRequest,
      assistantMessage: input.assistantPass.messageText,
      latestToolResult: input.lastToolResult,
      repeatedAssistantMessageCount: input.repeatedAssistantMessageCount
    })) {
      const stageCommit = await this.commitAssistantStage({
        sessionId: input.sessionId,
        taskId: input.taskId,
        originalRequest: input.originalRequest,
        messageText: input.assistantPass.messageText,
        messageWasEmitted: input.assistantPass.messageWasEmitted,
        lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature,
        forceDeferredEmission: true,
        alreadyCommitted: false,
        latestToolResult: input.lastToolResult
      });

      return {
        kind: "completed",
        directAnswer: buildDirectTerminalCompletionAnswer(
          input.originalRequest,
          input.lastToolResult!,
          input.preferredLanguage
        ),
        proposalNarrowingCount: input.proposalNarrowingCount,
        lastDeferredAssistantStageSignature: stageCommit.lastDeferredAssistantStageSignature
      };
    }

    const continuationDecision = resolveAssistantMessageContinuation({
      originalRequest: input.originalRequest,
      assistantMessage: input.assistantPass.messageText,
      preferredLanguage: input.preferredLanguage,
      hasAttemptedTool: input.hasAttemptedTool,
      proposalNarrowingCount: input.proposalNarrowingCount,
      lastToolResult: input.lastToolResult,
      workingFileAnchor: input.workingFileAnchor
    });

    if (continuationDecision) {
      const stageCommit = await this.commitAssistantStage({
        sessionId: input.sessionId,
        taskId: input.taskId,
        originalRequest: input.originalRequest,
        messageText: input.assistantPass.messageText,
        messageWasEmitted: input.assistantPass.messageWasEmitted,
        lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature,
        forceDeferredEmission: false,
        alreadyCommitted: false,
        latestToolResult: input.lastToolResult
      });

      return {
        kind: "continue",
        nextPrompt: continuationDecision.nextPrompt,
        proposalNarrowingCount: continuationDecision.consumeProposalNarrowingCount
          ? input.proposalNarrowingCount + 1
          : input.proposalNarrowingCount,
        lastDeferredAssistantStageSignature: stageCommit.lastDeferredAssistantStageSignature
      };
    }

    const stageCommit = await this.commitAssistantStage({
      sessionId: input.sessionId,
      taskId: input.taskId,
      originalRequest: input.originalRequest,
      messageText: input.assistantPass.messageText,
      messageWasEmitted: input.assistantPass.messageWasEmitted,
      lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature,
      forceDeferredEmission: true,
      alreadyCommitted: false,
      latestToolResult: input.lastToolResult
    });

    return {
      kind: "completed",
      proposalNarrowingCount: input.proposalNarrowingCount,
      lastDeferredAssistantStageSignature: stageCommit.lastDeferredAssistantStageSignature
    };
  }

  private async commitAssistantStage(input: {
    sessionId: string;
    taskId: string;
    originalRequest?: string;
    messageText: string;
    messageWasEmitted: boolean;
    lastDeferredAssistantStageSignature?: string;
    forceDeferredEmission: boolean;
    alreadyCommitted: boolean;
    latestToolResult?: RuntimeToolResult;
  }) {
    if (input.alreadyCommitted) {
      return {
        committed: true,
        lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature
      };
    }

    const isDeferredStage = !input.forceDeferredEmission
      && !input.messageWasEmitted
      && shouldPreserveDeferredAssistantStage(input.messageText);

    if (
      !input.messageWasEmitted
      && !input.forceDeferredEmission
      && !isDeferredStage
    ) {
      return {
        committed: false,
        lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature
      };
    }

    let nextDeferredAssistantStageSignature = input.lastDeferredAssistantStageSignature;

    if (isDeferredStage) {
      const signature = createAssistantStageSignature(input.messageText);
      const pendingCheckpoint = extractPendingAssistantCheckpoint(
        input.messageText,
        input.originalRequest,
        input.latestToolResult
          ? {
            toolName: input.latestToolResult.toolName,
            toolSummary: input.latestToolResult.summary,
            toolRawOutput: input.latestToolResult.rawOutput
          }
          : undefined
      );

      if (signature && signature === input.lastDeferredAssistantStageSignature) {
        return {
          committed: true,
          lastDeferredAssistantStageSignature: input.lastDeferredAssistantStageSignature
        };
      }

      if (pendingCheckpoint) {
        const checkpointEvent = createAssistantCheckpointRecordedEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          kind: "pending_next_step",
          content: input.messageText,
          targetPath: pendingCheckpoint.targetPath
        });
        this.input.bus.emit(checkpointEvent);
        await this.input.transcriptStore.appendEvent(checkpointEvent);
      }

      nextDeferredAssistantStageSignature = signature;
    }

    const shouldEmitDeferredDelta = !isDeferredStage;

    if (!input.messageWasEmitted && shouldEmitDeferredDelta && input.messageText.trim().length > 0) {
      const nextEvent = createAssistantDeltaEvent({
        sessionId: input.sessionId,
        taskId: input.taskId,
        delta: input.messageText
      });
      this.input.bus.emit(nextEvent);
      await this.input.transcriptStore.appendEvent(nextEvent);
    }

    if (isDeferredStage) {
      return {
        committed: true,
        lastDeferredAssistantStageSignature: nextDeferredAssistantStageSignature
      };
    }

    await this.emitAssistantCompletion(input.sessionId, input.taskId);

    return {
      committed: true,
      lastDeferredAssistantStageSignature: nextDeferredAssistantStageSignature
    };
  }

  private async processAssistantToolCall(input: {
    sessionId: string;
    taskId: string;
    originalRequest: string;
    preferredLanguage: PreferredReplyLanguage;
    tool: ToolImplementation;
    toolCall: ParsedAssistantToolCall;
    toolInput: unknown;
    previousToolResult?: RuntimeToolResult;
    previousRepeatedToolResultCount: number;
    signal: AbortSignal;
  }): Promise<AssistantToolStepResult> {
    const workingFileAnchor = this.taskLatestEditablePaths.get(input.taskId);

    if (
      input.previousToolResult
      && shouldTightenTerminalCompletionInsteadOfExtraTool(input.originalRequest, input.previousToolResult)
    ) {
      return {
        kind: "continue",
        nextPrompt: buildCompletionTighteningPrompt(
          input.originalRequest,
          renderAssistantToolCallForPrompt(input.toolCall),
          withWorkingFileAnchor(input.previousToolResult, workingFileAnchor),
          input.preferredLanguage
        ),
        repeatedToolResultCount: input.previousRepeatedToolResultCount,
        lastToolResult: input.previousToolResult
      };
    }

    const toolTaskResult = await this.requestToolFromAssistant({
      sessionId: input.sessionId,
      rootTaskId: input.taskId,
      tool: input.tool,
      input: input.toolInput,
      signal: input.signal
    });

    if (toolTaskResult.kind === "denied") {
      return {
        kind: "continue",
        nextPrompt: buildDeniedContinuationPrompt(input.originalRequest, input.preferredLanguage),
        repeatedToolResultCount: input.previousRepeatedToolResultCount,
        lastToolResult: input.previousToolResult
      };
    }

    if (toolTaskResult.kind === "failed") {
      const failureDecision = resolveFailedToolResultContinuation({
        originalRequest: input.originalRequest,
        preferredLanguage: input.preferredLanguage,
        previousToolResult: input.previousToolResult,
        previousRepeatedToolResultCount: input.previousRepeatedToolResultCount,
        result: toolTaskResult.result,
        workingFileAnchor
      });

      if (failureDecision.kind === "direct_answer") {
        return {
          kind: "completed",
          directAnswer: failureDecision.directAnswer,
          repeatedToolResultCount: failureDecision.repeatedToolResultCount,
          lastToolResult: toolTaskResult.result
        };
      }

      return {
        kind: "continue",
        nextPrompt: failureDecision.nextPrompt,
        repeatedToolResultCount: failureDecision.repeatedToolResultCount,
        lastToolResult: toolTaskResult.result
      };
    }

    const successDecision = resolveSuccessfulToolResultContinuation({
      originalRequest: input.originalRequest,
      preferredLanguage: input.preferredLanguage,
      previousToolResult: input.previousToolResult,
      previousRepeatedToolResultCount: input.previousRepeatedToolResultCount,
      result: toolTaskResult.result,
      workingFileAnchor
    });

    if ("directAnswer" in successDecision) {
      return {
        kind: "completed",
        directAnswer: successDecision.directAnswer,
        repeatedToolResultCount: successDecision.repeatedToolResultCount,
        lastToolResult: toolTaskResult.result
      };
    }

    return {
      kind: "continue",
      nextPrompt: successDecision.nextPrompt,
      repeatedToolResultCount: successDecision.repeatedToolResultCount,
      lastToolResult: toolTaskResult.result
    };
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
    let visibleMessageEmitted = false;
    let pendingPrefix = "";
    const deferVisibleEmission = input.content.startsWith("Original user request:")
      || looksLikeActionableTaskRequest(input.content);

    for await (const chunk of this.input.provider.streamResponse({
      content: input.content,
      contextMessages,
      signal: input.signal
    })) {
      buffer += chunk.delta;

      if (streamedVisible) {
        if (input.suppressMessageEmission || deferVisibleEmission) {
          continue;
        }

        const nextEvent = createAssistantDeltaEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          delta: chunk.delta
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
        visibleMessageEmitted = true;
        continue;
      }

      pendingPrefix += chunk.delta;
      const mode = classifyAssistantBuffer(pendingPrefix);

      if (mode === "tool") {
        continue;
      }

      if (mode === "message") {
        streamedVisible = true;

        if (!input.suppressMessageEmission && !deferVisibleEmission) {
          const nextEvent = createAssistantDeltaEvent({
            sessionId: input.sessionId,
            taskId: input.taskId,
            delta: pendingPrefix
          });
          this.input.bus.emit(nextEvent);
          await this.input.transcriptStore.appendEvent(nextEvent);
          visibleMessageEmitted = true;
        }

        pendingPrefix = "";
      }
    }

    if (streamedVisible) {
      const sanitizedMessage = sanitizeAssistantMessageForRuntime(input.content, buffer);
      return {
        kind: "message" as const,
        messageText: sanitizedMessage,
        messageWasEmitted: visibleMessageEmitted
      };
    }

    const parsedToolCall = parseAssistantToolCall(buffer);

    if (!parsedToolCall) {
      if (looksLikeToolCallBuffer(buffer)) {
        return {
          kind: "malformed_tool_call" as const,
          rawBuffer: buffer
        };
      }

      const sanitizedMessage = sanitizeAssistantMessageForRuntime(input.content, buffer);

      if (!input.suppressMessageEmission && sanitizedMessage.trim().length > 0) {
        const nextEvent = createAssistantDeltaEvent({
          sessionId: input.sessionId,
          taskId: input.taskId,
          delta: sanitizedMessage
        });
        this.input.bus.emit(nextEvent);
        await this.input.transcriptStore.appendEvent(nextEvent);
        visibleMessageEmitted = true;
      }

      return {
        kind: "message" as const,
        messageText: sanitizedMessage,
        messageWasEmitted: visibleMessageEmitted
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
    rememberTaskLatestEditablePath(this.taskLatestEditablePaths, input.rootTaskId, input.tool, input.input);

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
          errorMessage: ok ? undefined : event.payload.rawOutput ?? summary
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
    this.emitBusyState(sessionId, true, "assistant", taskId);
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
    this.taskLatestEditablePaths.delete(taskId);
    this.activeRun = undefined;
    this.emitBusyState(sessionId, false, "idle");
  }

  private setActivePhase(taskId: string, phase: "assistant" | "tool" | "approval") {
    if (!this.activeRun || this.activeRun.taskId !== taskId) {
      return;
    }

    this.activeRun.phase = phase;
    this.emitBusyState(this.activeRun.sessionId, true, phase, taskId);
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

  private emitBusyState(
    sessionId: string,
    active: boolean,
    phase: "idle" | "assistant" | "tool" | "approval",
    taskId?: string
  ) {
    this.input.bus.emit(createRuntimeBusyStateChangedEvent({
      sessionId,
      active,
      phase,
      taskId
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

function buildThrownToolFailureSummary(toolName: string, input: unknown) {
  const path = extractPathFromToolInput(input);

  if (path) {
    if (toolName === "edit") {
      const range = extractRangeFromToolInput(input);
      return `${path}${range ? `:${range}` : ""} · failed`;
    }

    return `${path} · failed`;
  }

  const command = extractShellCommandFromToolInput(input);

  if (command) {
    return `${command} · failed`;
  }

  return `${toolName} · failed`;
}

function extractPathFromToolInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  return typeof (input as { path?: unknown }).path === "string"
    ? normalizePromptPath((input as { path: string }).path)
    : undefined;
}

function extractRangeFromToolInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const startLine = typeof (input as { startLine?: unknown }).startLine === "number"
    ? (input as { startLine: number }).startLine
    : undefined;
  const endLine = typeof (input as { endLine?: unknown }).endLine === "number"
    ? (input as { endLine: number }).endLine
    : startLine;

  if (startLine === undefined || endLine === undefined) {
    return undefined;
  }

  return `${startLine}-${Math.max(startLine, endLine)}`;
}

function extractShellCommandFromToolInput(input: unknown) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  if (typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command.trim();
  }

  if (typeof (input as { cmd?: unknown }).cmd === "string") {
    return (input as { cmd: string }).cmd.trim();
  }

  return undefined;
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
    ...extractPathsFromSnippet(request.replace(/`[^`]+`/g, " ")),
    ...quoted.flatMap((value) => extractPathsFromSnippet(value))
  ];

  return dedupeNormalizedPaths(paths);
}

function extractPathsFromSnippet(content: string) {
  const commandPath = extractCommandPath(content);
  const directPaths = [...content.matchAll(/\b([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt|md|csv))\b/g)]
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
  const match = command.match(/\b(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\s+([^\s]+?\.(?:tsx|json|mjs|js|ts|txt|md|csv))\b/i);
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

function rememberTaskLatestEditablePath(
  latestEditablePaths: Map<string, string>,
  taskId: string,
  tool: ToolImplementation,
  input: unknown
) {
  const path = getWorkspaceToolPath(tool, input);

  if (!path) {
    return;
  }

  const normalized = normalizeApprovalPath(path);

  if (!normalized || !looksLikeEditableSourcePath(normalized)) {
    return;
  }

  latestEditablePaths.set(taskId, normalized);
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

function extractLastNonEmptyLine(content?: string) {
  if (!content) {
    return "";
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? "";
}

function createAbortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function withWorkingFileAnchor<T extends {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}>(input: T, workingFileAnchor?: string): T & { workingFileAnchor?: string } {
  return {
    ...input,
    workingFileAnchor
  };
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

function pushPreferredNextAction(lines: string[], actionHint?: string) {
  if (actionHint) {
    lines.push(`Preferred next action: ${actionHint}`);
  }
}

function pushPreferredAnswerStyle(lines: string[], answerStyleHint?: string) {
  if (answerStyleHint) {
    lines.push(`Preferred answer style: ${answerStyleHint}`);
  }
}

function pushClueLines(lines: string[], clueLines: string[]) {
  if (clueLines.length > 0) {
    lines.push(...clueLines);
  }
}

function buildAssistantMessageClueLines(assistantMessage: string) {
  const clues: string[] = [];
  const nextTargetPath = extractLikelyNextTargetPathFromAssistantMessage(assistantMessage);

  if (nextTargetPath) {
    clues.push(`Pending next step target: ${nextTargetPath}`);
  }

  return clues;
}

function pushErrorLine(lines: string[], errorMessage?: string) {
  if (errorMessage) {
    lines.push(`Error: ${errorMessage}`);
  }
}

function pushRawOutputSection(lines: string[], rawOutput?: string, fallback = false) {
  if (rawOutput && rawOutput.trim().length > 0) {
    lines.push("Raw output (already shown to the user):");
    lines.push(rawOutput);
    return;
  }

  if (fallback) {
    lines.push("Raw output: (none)");
  }
}

function buildAssistantToolPromptLines(input: {
  originalRequest: string;
  instructionLines: string[];
  preferredLanguage: PreferredReplyLanguage;
  assistantMessage: string;
  latestTool: Pick<RuntimeToolResult, "toolName" | "summary">;
}) {
  return [
    `Original user request: ${input.originalRequest}`,
    "",
    ...input.instructionLines,
    buildPreferredReplyLanguageInstruction(input.preferredLanguage),
    "",
    `Previous assistant message: ${input.assistantMessage.trim() || "(empty)"}`,
    `Latest tool: ${input.latestTool.toolName}`,
    `Latest summary: ${input.latestTool.summary}`
  ];
}

function buildToolResultPromptLines(input: {
  originalRequest: string;
  instructionLines: string[];
  preferredLanguage: PreferredReplyLanguage;
  toolResult: Pick<RuntimeToolResult, "toolName" | "summary">;
}) {
  return [
    `Original user request: ${input.originalRequest}`,
    "",
    ...input.instructionLines,
    buildPreferredReplyLanguageInstruction(input.preferredLanguage),
    "",
    `Tool: ${input.toolResult.toolName}`,
    `Summary: ${input.toolResult.summary}`
  ];
}

function buildRequestPromptLines(input: {
  originalRequest: string;
  instructionLines: string[];
  preferredLanguage: PreferredReplyLanguage;
  assistantMessage?: string;
}) {
  return [
    `Original user request: ${input.originalRequest}`,
    "",
    ...input.instructionLines,
    buildPreferredReplyLanguageInstruction(input.preferredLanguage),
    ...(typeof input.assistantMessage === "string"
      ? ["", `Previous assistant message: ${input.assistantMessage.trim() || "(empty)"}`]
      : [])
  ];
}

function buildToolContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  workingFileAnchor?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const remainingMultiTargetPath = extractRemainingMultiTargetPathFromResult(originalRequest, input);
  const lines = buildToolResultPromptLines({
    originalRequest,
    instructionLines: [
      "Continue from the latest tool result only.",
      "Do not infer anything that is not explicitly present in the result below.",
      ...(remainingMultiTargetPath
        ? [
          "The original request contains multiple concrete file changes.",
          "The latest successful edit only covers part of that requested work.",
          "Continue directly into the next remaining requested file instead of stopping at a status update."
        ]
        : []),
      "If another tool is required, return exactly one tool call block.",
      "If the original request is not yet completed, keep working instead of stopping at a status update.",
      "Otherwise answer the user briefly and directly.",
      "The terminal already shows the raw tool output to the user.",
      "Do not restate raw output line-by-line or quote it verbatim unless the user explicitly asked for a transformation or summary.",
      "For listings, reads, and command output, prefer a one-sentence conclusion over repeating the visible lines.",
      "If system context includes Recent task state, treat its Target verification and Working files as the current task anchor.",
      "If Recent task state includes Pending next step, continue that concrete next step before broad rereads or replanning.",
      "If Recent task state includes Pending approval, retry that exact action before reopening broader exploration.",
      "Do not rerun earlier auxiliary commands or warmups when a later target verification command is already established."
    ],
    preferredLanguage,
    toolResult: input
  });

  const actionHint = remainingMultiTargetPath
    ? `continue with the remaining requested change in ${remainingMultiTargetPath} now instead of stopping after the first successful edit`
    : buildToolContinuationActionHint(originalRequest, input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = buildToolContinuationClueLines(originalRequest, input);
  if (remainingMultiTargetPath) {
    clueLines.push(`Pending next step target: ${remainingMultiTargetPath}`);
  }
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput, true);

  return lines.join("\n");
}

function buildEditRangeRecoveryContinuationPrompt(originalRequest: string, failedEdit: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
  workingFileAnchor?: string;
}, currentRead: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  workingFileAnchor?: string;
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

  pushRawOutputSection(lines, currentRead.rawOutput);

  return lines.join("\n");
}

function buildPrematureContinuationPrompt(originalRequest: string, assistantMessage: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
  workingFileAnchor?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "You are still inside the same multi-step task.",
      "Your previous assistant message was only a progress update, not a completed result.",
      "Do not stop until the original request is actually completed.",
      "If more work is needed, return exactly one tool call block.",
      "Only answer directly after the requested read/create/edit/verification work is truly finished.",
      "Do not apologize or restate the same status update."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const clueLines = [
    ...buildAssistantMessageClueLines(assistantMessage),
    ...buildToolContinuationClueLines(originalRequest, input)
  ];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildStalledToolContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
  workingFileAnchor?: string;
}, repeatedCount: number, preferredLanguage: PreferredReplyLanguage) {
  const lines = buildToolResultPromptLines({
    originalRequest,
    instructionLines: [
      "The latest tool result repeated without progress.",
      `Repeated identical result count: ${repeatedCount + 1}`,
      "Do not repeat the same tool step again unless you just changed the exact source that should affect this result.",
      "Pick a different targeted action that can change the outcome.",
      "If another tool is needed, return exactly one tool call block.",
      "Only answer directly when the original request is truly complete."
    ],
    preferredLanguage,
    toolResult: input
  });

  const actionHint = buildStalledActionHint(originalRequest, input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = input.toolName === "shell"
    ? buildToolFailureClueLines(originalRequest, input)
    : [];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildPrematureTaskStartPrompt(
  originalRequest: string,
  assistantMessage: string,
  preferredLanguage: PreferredReplyLanguage
) {
  return buildRequestPromptLines({
    originalRequest,
    instructionLines: [
      "You have not started the requested work yet.",
      "Your previous assistant message described intent or a plan, but did not actually perform the task.",
      "For actionable requests, do the work now instead of describing what you will do.",
      "If tools are needed, return exactly one tool call block.",
      "Only answer directly when the request truly needs no tool work.",
      "Do not ask for permission to begin unless the user explicitly asked for discussion first."
    ],
    preferredLanguage,
    assistantMessage
  }).join("\n");
}

function buildProposalNarrowingPrompt(
  originalRequest: string,
  assistantMessage: string,
  preferredLanguage: PreferredReplyLanguage
) {
  return buildRequestPromptLines({
    originalRequest,
    instructionLines: [
      "The user asked for only the next step, not a broad plan.",
      "Rewrite your previous answer as exactly one concrete next step.",
      "Do not list multiple options.",
      "Do not start doing the work yet.",
      "Keep it short and directly executable after a simple user confirmation."
    ],
    preferredLanguage,
    assistantMessage
  }).join("\n");
}

function buildFailureRecoveryPrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
    workingFileAnchor?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "A single failed tool result does not complete this task.",
      "Your previous assistant message stopped after a failure instead of continuing the repair loop.",
      "Keep working from the failure you already have.",
      "If tools are needed, return exactly one tool call block.",
      "Only answer directly if the task is truly blocked on missing user input or a denied permission.",
      "Do not just restate the failure."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = buildFailureActionHint(input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = [
    ...buildAssistantMessageClueLines(assistantMessage),
    ...buildToolFailureClueLines(originalRequest, input)
  ];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildProjectInspectionContinuationPrompt(
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
  const targetPath = extractPathFromToolSummary(input.summary);
  const continuingFromProjectEntry = Boolean(
    input.toolName === "files"
    && targetPath
    && looksLikeProjectEntryPath(targetPath)
    && !looksLikeEditableSourcePath(targetPath)
  );
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: continuingFromProjectEntry
      ? [
        "You are in the middle of a concrete project inspection request.",
        "You already inspected a concrete project entry, so do not stop at a summary of the entry file.",
        "Continue the inspection now by reading the most likely implementation file for this project.",
        "If another tool is needed, return exactly one tool call block.",
        "Only answer directly after you have inspected at least one concrete implementation file or truly hit a blocker."
      ]
      : [
        "You are in the middle of a concrete project inspection request.",
        "Do not stop at a broad question after the workspace listing.",
        "Continue the inspection now by reading the most likely project entry from the listing.",
        "If another tool is needed, return exactly one tool call block.",
        "Only answer directly after you have inspected at least one concrete project entry."
      ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = buildToolContinuationActionHint(originalRequest, input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = [
    ...buildAssistantMessageClueLines(assistantMessage),
    ...buildToolContinuationClueLines(originalRequest, input)
  ];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildProjectWorkfileContinuationPrompt(
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
  const targetPath = extractPathFromToolSummary(input.summary);
  const likelyImprovementPath = targetPath
    ? deriveLikelyProjectImplementationPath(targetPath, input.rawOutput)
    : undefined;
  const continuingFromThinEntrySource = Boolean(
    targetPath
    && looksLikePrimaryProjectEntrySourcePath(targetPath)
    && likelyImprovementPath
    && likelyImprovementPath !== targetPath
  );
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: continuingFromThinEntrySource
      ? [
        "You are in the middle of a project improvement task.",
        "The file you just inspected is only a thin entry layer, not yet the real implementation target.",
        "Do not stop at analysis or a broad next-step suggestion.",
        "Continue now by reading the most likely local implementation file for the requested work.",
        "If another tool is needed, return exactly one tool call block.",
        "Only answer directly after you have inspected the concrete implementation file or truly completed the task."
      ]
      : [
        "You are in the middle of a project improvement task.",
        "You already inspected a concrete project entry, so do not stop at analysis or a broad next-step suggestion.",
        "Continue now by reading the most likely implementation file for the requested work.",
        "If another tool is needed, return exactly one tool call block.",
        "Only answer directly after you have inspected a concrete working file or truly completed the task."
      ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = buildToolContinuationActionHint(originalRequest, input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = [
    ...buildAssistantMessageClueLines(assistantMessage),
    ...buildToolContinuationClueLines(originalRequest, input)
  ];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildWholeProjectInspectionContinuationPrompt(
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
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "You are in the middle of a whole-project inspection request.",
      "Inspecting only the project entry or the first entry implementation file is not enough here.",
      "Continue now by reading the next most likely core implementation file for this project.",
      "If another tool is needed, return exactly one tool call block.",
      "Only answer directly after you have inspected more than one concrete core project file or truly hit a blocker."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const targetPath = extractPathFromToolSummary(input.summary);
  const inspectionFile = targetPath
    ? deriveLikelyWholeProjectInspectionPath(targetPath, input.rawOutput)
    : undefined;

  if (inspectionFile) {
    lines.push(`Likely inspection file: ${inspectionFile}`);
  }

  pushClueLines(lines, buildAssistantMessageClueLines(assistantMessage));
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildMultiTargetMutationContinuationPrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
    workingFileAnchor?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "The original request contains multiple concrete file changes.",
      "One successful edit does not complete the task when your own reply says more requested work remains.",
      "Continue with the next remaining requested change now.",
      "If tools are needed, return exactly one tool call block.",
      "Only answer directly after the remaining requested edits are done or truly blocked."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = input.toolName === "edit" || input.toolName === "write"
    ? "do not stop after the first successful edit; move to the next requested file or remaining requested change now"
    : buildToolContinuationActionHint(originalRequest, input);

  pushPreferredNextAction(lines, actionHint);
  pushClueLines(lines, buildAssistantMessageClueLines(assistantMessage));
  pushRawOutputSection(lines, input.rawOutput);

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
    workingFileAnchor?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const progressOnly = looksLikeProgressOnlyAssistantReply(assistantMessage);
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "You are already inside the execution phase of a concrete task.",
      progressOnly
        ? "Your previous assistant message was only a progress update, not a completed result."
        : "Your previous assistant message explained the situation but did not advance the task.",
      "Do not stop for explanation-only updates.",
      "Take the next concrete step that moves the task forward.",
      "If tools are needed, return exactly one tool call block.",
      "Only answer directly when the task is actually complete or truly blocked on user input."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = input.toolName === "shell"
    ? buildToolContinuationActionHint(originalRequest, input) ?? buildFailureActionHint(input)
    : buildToolContinuationActionHint(originalRequest, input);

  pushPreferredNextAction(lines, actionHint);

  const clueLines = input.toolName === "shell"
    ? [
      ...buildAssistantMessageClueLines(assistantMessage),
      ...buildToolFailureClueLines(originalRequest, input),
      ...(input.workingFileAnchor ? [`Working file anchor: ${input.workingFileAnchor}`] : [])
    ]
    : [
      ...buildAssistantMessageClueLines(assistantMessage),
      ...(input.workingFileAnchor ? [`Working file anchor: ${input.workingFileAnchor}`] : [])
    ];
  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

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
    workingFileAnchor?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const taskTerminal = isLatestToolResultTaskTerminal(originalRequest, input);
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      taskTerminal
        ? "The latest tool result appears to satisfy the task, but your previous reply did not close it clearly."
        : "The latest tool result does not satisfy the task yet, so your previous reply cannot end the task.",
      taskTerminal
        ? "Give a short direct completion answer instead of a vague explanation."
        : "Continue the task instead of ending on explanation alone.",
      taskTerminal
        ? "Do not call more tools unless the latest result still does not actually satisfy the request."
        : "If tools are needed, return exactly one tool call block."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = taskTerminal
    ? "answer directly in one short sentence that clearly states the completed outcome"
    : buildToolContinuationActionHint(originalRequest, input) ?? buildFailureActionHint(input);

  pushPreferredNextAction(lines, actionHint);

  const clueLines = input.toolName === "shell"
    ? buildToolFailureClueLines(originalRequest, input)
    : [];

  pushClueLines(lines, clueLines);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildFollowUpReplyTighteningPrompt(
  originalRequest: string,
  assistantMessage: string,
  input: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
    workingFileAnchor?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const lines = buildAssistantToolPromptLines({
    originalRequest,
    instructionLines: [
      "Your previous reply was too thin for an approval or continue follow-up.",
      "Do not start with an acknowledgement like 可以, 已继续, 好的, sure, or okay.",
      "Give one short direct answer that states the concrete work result and the current outcome.",
      "Do not ask a broad follow-up question here.",
      "Do not call more tools unless the latest result still does not actually satisfy the request."
    ],
    preferredLanguage,
    assistantMessage,
    latestTool: input
  });

  const actionHint = buildToolContinuationActionHint(originalRequest, input);

  pushPreferredNextAction(lines, actionHint);
  pushRawOutputSection(lines, input.rawOutput);

  return lines.join("\n");
}

function buildMalformedToolCallRepairPrompt(
  originalRequest: string,
  rawBuffer: string,
  preferredLanguage: PreferredReplyLanguage
) {
  return [
    `Original user request: ${originalRequest}`,
    preferredLanguage === "zh"
      ? "你上一条回复尝试调用工具，但 tool call 格式损坏了。"
      : "Your previous reply attempted to call a tool, but the tool call payload was malformed.",
    preferredLanguage === "zh"
      ? "如果仍然需要工具，立即只返回一个合法的 <tool_call> JSON 块。"
      : "If a tool is still needed, immediately return exactly one valid <tool_call> JSON block.",
    preferredLanguage === "zh"
      ? "如果不需要工具，就直接简短回答。不要附加多余说明。"
      : "If no tool is needed, answer directly and briefly. Do not include extra commentary.",
    `Malformed tool call preview: ${createMalformedToolCallPreview(rawBuffer)}`
  ].join("\n");
}

function buildUnknownToolRepairPrompt(
  originalRequest: string,
  toolName: string,
  availableTools: string[],
  preferredLanguage: PreferredReplyLanguage
) {
  return [
    `Original user request: ${originalRequest}`,
    preferredLanguage === "zh"
      ? `你上一条回复请求了不存在的工具：${toolName}。`
      : `Your previous reply requested an unknown tool: ${toolName}.`,
    preferredLanguage === "zh"
      ? `可用工具只有：${availableTools.join(", ")}。`
      : `The only available tools are: ${availableTools.join(", ")}.`,
    preferredLanguage === "zh"
      ? "如果仍然需要工具，立即只返回一个合法的 <tool_call> JSON 块，并使用可用工具名。"
      : "If a tool is still needed, immediately return exactly one valid <tool_call> JSON block using one of those tool names.",
    preferredLanguage === "zh"
      ? "如果不需要工具，就直接简短回答。不要附加多余说明。"
      : "If no tool is needed, answer directly and briefly. Do not include extra commentary."
  ].join("\n");
}

function buildInvalidToolInputRepairPrompt(
  originalRequest: string,
  toolName: string,
  error: unknown,
  preferredLanguage: PreferredReplyLanguage
) {
  return [
    `Original user request: ${originalRequest}`,
    preferredLanguage === "zh"
      ? `你上一条回复调用了工具 ${toolName}，但输入参数不合法。`
      : `Your previous reply called the ${toolName} tool, but its input was invalid.`,
    `Validation error: ${formatDirectCommandInputError(toolName, error)}`,
    preferredLanguage === "zh"
      ? "如果仍然需要工具，立即只返回一个合法的 <tool_call> JSON 块，并修正输入字段。"
      : "If a tool is still needed, immediately return exactly one valid <tool_call> JSON block with corrected input fields.",
    preferredLanguage === "zh"
      ? "如果不需要工具，就直接简短回答。不要附加多余说明。"
      : "If no tool is needed, answer directly and briefly. Do not include extra commentary."
  ].join("\n");
}

function buildDeniedContinuationPrompt(originalRequest: string, preferredLanguage: PreferredReplyLanguage) {
  return buildRequestPromptLines({
    originalRequest,
    instructionLines: [
      TOOL_CALL_DENIED_PROMPT,
      "Do not immediately retry the same denied action unless the user explicitly asks again or approves a new attempt."
    ],
    preferredLanguage
  }).join("\n");
}

function buildToolFailureContinuationPrompt(originalRequest: string, input: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
  workingFileAnchor?: string;
}, preferredLanguage: PreferredReplyLanguage) {
  const lines = buildToolResultPromptLines({
    originalRequest,
    instructionLines: [
      "The latest tool attempt failed.",
      "Do not repeat the raw failure twice.",
      "Explain the failure briefly and accurately.",
      "If another tool can help, return exactly one tool call block.",
      "Otherwise answer directly.",
      "The terminal already shows the raw tool output to the user.",
      "Do not restate stdout or stderr line-by-line unless one exact line is necessary to explain the next action.",
      "Prefer a short conclusion such as the key error, missing file, or exit code.",
      "If system context includes Recent task state, continue from its Target verification and Working files instead of restarting broader exploration.",
      "If Recent task state includes Pending next step, continue that concrete next step before broad rereads or replanning.",
      "If Recent task state includes Pending approval, retry that exact action before broad rereads or replanning.",
      "Do not go back to earlier auxiliary commands when the current task already has a later target verification command."
    ],
    preferredLanguage,
    toolResult: input
  });

  const replyHint = buildFailureReplyHint(input, preferredLanguage);
  pushPreferredAnswerStyle(lines, replyHint);

  const actionHint = buildFailureActionHint(input);
  pushPreferredNextAction(lines, actionHint);

  const clueLines = buildToolFailureClueLines(originalRequest, input);
  pushClueLines(lines, clueLines);
  pushErrorLine(lines, input.errorMessage);

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
    "When the user message is only an approval or continue follow-up, do not answer with filler acknowledgements like 可以, 好的, sure, or okay; either do the work or report the concrete result directly.",
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
    "If Recent task state includes Pending next step, continue that concrete step before broader replanning.",
    "If Recent task state includes Pending approval, retry that exact blocked action before drifting into broader analysis.",
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

  if (/[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt):\d+/i.test(shellText)) {
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
  workingFileAnchor?: string;
}) {
  if (input.toolName === "files") {
    const targetPath = extractPathFromToolSummary(input.summary);
    const isRequestedMultiTargetFile = Boolean(
      targetPath
      && input.workingFileAnchor
      && looksLikeMultiTargetMutationTask(originalRequest)
      && isExplicitRequestedTargetPath(originalRequest, targetPath)
    );
    const projectImplementationWorkingFile = targetPath
      && (looksLikeBroadProjectImprovementRequest(originalRequest) || looksLikeExecutableProjectRewriteRequest(originalRequest))
      ? deriveLikelyProjectImplementationPath(targetPath, input.rawOutput)
      : undefined;
    const rewriteWorkingFile = targetPath
      && looksLikeExecutableProjectRewriteRequest(originalRequest)
      && looksLikeProjectEntryPath(targetPath)
      && !looksLikeEditableSourcePath(targetPath)
      ? deriveLikelyProjectWorkfileFromEntryPath(targetPath, input.rawOutput)
      : undefined;

    if (rewriteWorkingFile) {
      return `use this project entry to continue the rewrite by reading ${rewriteWorkingFile} next instead of editing the entry file itself`;
    }

    if (projectImplementationWorkingFile && projectImplementationWorkingFile !== targetPath) {
      return `use this file only as the handoff point and continue by reading ${projectImplementationWorkingFile} next so you can work on the real implementation`;
    }

    if (!targetPath || !looksLikeExecutionTask(originalRequest)) {
      if (
        targetPath
        && looksLikeWholeProjectInspectionRequest(originalRequest)
        && looksLikeProjectEntryPath(targetPath)
        && !looksLikeEditableSourcePath(targetPath)
      ) {
        return "do not stop at the entry file; read the most likely core implementation file next so the user gets a fuller project-level inspection";
      }

      if (
        targetPath
        && looksLikeBroadProjectImprovementRequest(originalRequest)
        && looksLikeProjectEntryPath(targetPath)
        && !looksLikeEditableSourcePath(targetPath)
      ) {
        return "do not stop at project-entry analysis; read the most likely working file next so you can make a concrete improvement";
      }

      if (
        targetPath
        && looksLikeExecutableProjectRewriteRequest(originalRequest)
        && looksLikeProjectEntryPath(targetPath)
        && !looksLikeEditableSourcePath(targetPath)
      ) {
        return "do not stop at project-entry analysis; read the most likely working file next so you can carry the rewrite into a concrete implementation file";
      }

      return undefined;
    }

    if (looksLikeConfigurationSourcePath(targetPath)) {
      if (isRequestedMultiTargetFile) {
        return "this file is itself one of the requested change targets; use this source read to make the requested edit here now instead of jumping back to an earlier anchor";
      }

      if (input.workingFileAnchor && input.workingFileAnchor !== targetPath) {
        return `use this source data to continue the task, but prefer returning to the anchored working file ${input.workingFileAnchor} instead of rereading broader context first`;
      }

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

  if (looksLikeProjectInspectionRequest(originalRequest) && looksLikeProjectListingOutput(input.summary, input.rawOutput)) {
    return "do not stop at a broad question after the listing; pick the most likely project entry from the listing and read that package.json, README, or main source file next";
  }

  if (!looksLikeExactOutputRequest(originalRequest)) {
    return undefined;
  }

  const shellText = [input.summary, input.rawOutput].filter(Boolean).join("\n");

  if (!shellText.trim()) {
    return undefined;
  }

  if (input.workingFileAnchor) {
    return `if the command output is close but not exact, prefer the smallest edit to the anchored working file ${input.workingFileAnchor} and then rerun the same verification command`;
  }

  return "if the command output is close but not exact, prefer the smallest edit to the most likely source file and then rerun the same verification command";
}

function extractPathFromToolSummary(summary: string) {
  const match = summary.match(/^([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))(?::\d+(?:-\d+)?)?/);
  return match?.[1]?.trim();
}

function looksLikeProjectEntryPath(path: string) {
  return /(?:^|\/)(?:package\.json|README\.md|app\.js|src\/index\.(?:js|ts|tsx))$/i.test(path);
}

function looksLikeConfigurationSourcePath(path: string) {
  return /\.(?:json|txt|csv|md)$/i.test(path);
}

function looksLikeEditableSourcePath(path: string) {
  return /\.(?:mjs|cjs|js|ts|tsx|ejs|html|css)$/i.test(path);
}

function looksLikeAuxiliaryVerificationSourcePath(path: string) {
  const normalized = normalizePromptPath(path);

  return /(?:^|\/)(?:verify|verification|check|test|smoke|setup)[-_a-z0-9]*\.(?:mjs|cjs|js|ts|tsx)$/i.test(normalized)
    || /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(normalized);
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
  workingFileAnchor?: string;
}) {
  if (input.toolName === "files") {
    const targetPath = extractPathFromToolSummary(input.summary);
    const workingFile = targetPath
      ? (
        (looksLikeBroadProjectImprovementRequest(originalRequest) || looksLikeExecutableProjectRewriteRequest(originalRequest))
          ? deriveLikelyProjectImplementationPath(targetPath, input.rawOutput)
          : deriveLikelyProjectWorkfileFromEntryPath(targetPath, input.rawOutput)
      )
      : undefined;
    const clues: string[] = [];

    if (input.workingFileAnchor && input.workingFileAnchor !== targetPath) {
      clues.push(`Working file anchor: ${input.workingFileAnchor}`);
    }

    if (workingFile && looksLikeExecutableProjectRewriteRequest(originalRequest)) {
      clues.push(`Likely working file: ${workingFile}`);
      return dedupePromptLines(clues);
    }

    if (
      !workingFile
      || (
        !looksLikeBroadProjectImprovementRequest(originalRequest)
        && !looksLikeExecutableProjectRewriteRequest(originalRequest)
      )
    ) {
      return dedupePromptLines(clues);
    }

    clues.push(`Likely working file: ${workingFile}`);
    return dedupePromptLines(clues);
  }

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

  if (input.workingFileAnchor) {
    clues.push(`Working file anchor: ${input.workingFileAnchor}`);
  }

  if (looksLikeProjectInspectionRequest(originalRequest) && looksLikeProjectListingOutput(input.summary, input.rawOutput)) {
    const projectEntry = extractLikelyProjectEntryFromListing(input.rawOutput);

    if (projectEntry) {
      clues.push(`Likely project entry: ${projectEntry}`);
    }
  }

  return dedupePromptLines(clues);
}

function deriveLikelyProjectWorkfileFromEntryPath(path: string, rawOutput?: string) {
  const normalized = normalizePromptPath(path);
  const packageMatch = normalized.match(/^(.*)\/package\.json$/i);

  if (packageMatch?.[1]) {
    const inferredPackageEntry = extractLikelyWorkfileFromPackagePreview(normalized, rawOutput);

    if (inferredPackageEntry) {
      return inferredPackageEntry;
    }

    return `${packageMatch[1]}/app.js`;
  }

  const readmeMatch = normalized.match(/^(.*)\/README\.md$/i);

  if (readmeMatch?.[1]) {
    const inferredReadmeEntry = extractLikelyWorkfileFromReadmePreview(normalized, rawOutput);

    if (inferredReadmeEntry) {
      return inferredReadmeEntry;
    }

    return `${readmeMatch[1]}/app.js`;
  }

  return undefined;
}

function deriveLikelyProjectImplementationPath(path: string, rawOutput?: string) {
  const normalized = normalizePromptPath(path);

  if (looksLikeProjectEntryPath(normalized) && !looksLikeEditableSourcePath(normalized)) {
    return deriveLikelyProjectWorkfileFromEntryPath(normalized, rawOutput);
  }

  if (!looksLikePrimaryProjectEntrySourcePath(normalized)) {
    return undefined;
  }

  return extractLikelyRelativeImplementationImportPath(normalized, rawOutput);
}

function extractLikelyWorkfileFromPackagePreview(entryPath: string, rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const packageDir = normalizePromptPath(entryPath).replace(/\/package\.json$/i, "");
  const previewText = stripFilesPreviewPrefixes(rawOutput);
  const candidates: string[] = [];

  const mainMatch = previewText.match(/"main"\s*:\s*"([^"]+)"/i);

  if (mainMatch?.[1]) {
    candidates.push(mainMatch[1]);
  }

  for (const scriptName of ["start", "dev", "serve", "preview"]) {
    const scriptMatch = previewText.match(new RegExp(`"${scriptName}"\\s*:\\s*"([^"]+)"`, "i"));

    if (scriptMatch?.[1]) {
      const commandPath = extractScriptCommandEntryPath(scriptMatch[1]);

      if (commandPath) {
        candidates.push(commandPath);
      }
    }
  }

  for (const candidate of candidates) {
    for (const normalizedCandidate of resolveProjectEntryCandidates(packageDir, candidate)) {
      if (looksLikeEditableSourcePath(normalizedCandidate)) {
        return normalizedCandidate;
      }
    }
  }

  return undefined;
}

function extractLikelyWorkfileFromReadmePreview(entryPath: string, rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const projectDir = normalizePromptPath(entryPath).replace(/\/README\.md$/i, "");
  const previewText = stripFilesPreviewPrefixes(rawOutput);
  const candidates = [
    ...matchAllGroups(previewText, /\b([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|tsx))\b/g),
    ...extractReadmeCommandEntryPaths(previewText)
  ];

  for (const candidate of candidates) {
    for (const normalizedCandidate of resolveProjectEntryCandidates(projectDir, candidate)) {
      if (looksLikeEditableSourcePath(normalizedCandidate)) {
        return normalizedCandidate;
      }
    }
  }

  const fallbackCandidates = [
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "app.ts",
    "app.js"
  ];

  for (const candidate of fallbackCandidates) {
    for (const normalizedCandidate of resolveProjectEntryCandidates(projectDir, candidate)) {
      if (looksLikeEditableSourcePath(normalizedCandidate)) {
        return normalizedCandidate;
      }
    }
  }

  return undefined;
}

function stripFilesPreviewPrefixes(rawOutput: string) {
  return rawOutput
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\s+\|\s?/, ""))
    .join("\n");
}

function extractReadmeCommandEntryPaths(content: string) {
  const candidates: string[] = [];
  const commandMatches = [
    ...content.matchAll(/`([^`]+)`/g),
    ...content.matchAll(/^\s*(?:\$|>)\s+(.+)$/gm)
  ];

  for (const match of commandMatches) {
    const command = match[1]?.trim();

    if (!command) {
      continue;
    }

    const entryPath = extractScriptCommandEntryPath(command);

    if (entryPath) {
      candidates.push(entryPath);
    }
  }

  return candidates;
}

function extractScriptCommandEntryPath(command: string) {
  const tokens = tokenizeShellLikeCommand(command);
  const runtimeEntry = extractScriptPathFromRuntimeTokens(tokens);

  if (runtimeEntry) {
    return runtimeEntry;
  }

  for (const token of tokens) {
    const normalizedToken = stripWrappingQuotes(token);

    if (looksLikeScriptPathCandidate(normalizedToken)) {
      return normalizedToken;
    }
  }

  return undefined;
}

function tokenizeShellLikeCommand(command: string) {
  const tokens: string[] = [];

  for (const match of command.matchAll(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g)) {
    const token = match[0]?.trim();

    if (token) {
      tokens.push(token);
    }
  }

  return tokens;
}

function extractScriptPathFromRuntimeTokens(tokens: string[]) {
  const runtimeIndex = tokens.findIndex((token) => /^(node|tsx|ts-node|bun|deno)$/i.test(stripWrappingQuotes(token)));

  if (runtimeIndex < 0) {
    return undefined;
  }

  const runtime = stripWrappingQuotes(tokens[runtimeIndex]).toLowerCase();

  for (let index = runtimeIndex + 1; index < tokens.length; index += 1) {
    const token = stripWrappingQuotes(tokens[index]);

    if (!token || shouldSkipRuntimeCommandToken(runtime, token)) {
      continue;
    }

    if (looksLikeScriptPathCandidate(token)) {
      return token;
    }
  }

  return undefined;
}

function shouldSkipRuntimeCommandToken(runtime: string, token: string) {
  if (token.startsWith("-")) {
    return true;
  }

  const normalized = token.toLowerCase();

  if ((runtime === "bun" || runtime === "deno") && normalized === "run") {
    return true;
  }

  if ((runtime === "tsx" || runtime === "bun") && normalized === "watch") {
    return true;
  }

  return false;
}

function stripWrappingQuotes(value: string) {
  return value.replace(/^["'`](.*)["'`]$/s, "$1");
}

function looksLikeScriptPathCandidate(candidate: string) {
  const normalized = normalizePromptPath(stripWrappingQuotes(candidate));

  if (!normalized) {
    return false;
  }

  if (/\.(?:mjs|cjs|js|ts|tsx)$/i.test(normalized)) {
    return true;
  }

  if (normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("/")) {
    return !pathPosix.basename(normalized).startsWith(".");
  }

  if (!normalized.includes("/")) {
    return false;
  }

  const firstSegment = normalized.replace(/^\.?\//, "").split("/")[0]?.toLowerCase() ?? "";
  return SCRIPT_ENTRY_DIR_HINTS.has(firstSegment);
}

function resolveProjectEntryCandidates(packageDir: string, candidate: string) {
  const normalizedCandidate = normalizePromptPath(candidate);

  if (!normalizedCandidate) {
    return [];
  }

  const resolvedCandidate = (
    normalizedCandidate.startsWith("./")
    || normalizedCandidate.startsWith("../")
    || normalizedCandidate.includes("/")
  )
    ? pathPosix.normalize(pathPosix.join(packageDir, normalizedCandidate))
    : pathPosix.normalize(pathPosix.join(packageDir, normalizedCandidate));

  const sourceFallbacks = deriveSourceCandidatesFromBuiltArtifact(resolvedCandidate);
  const extensionlessCandidates = deriveExtensionlessEntryCandidates(resolvedCandidate);
  return dedupePromptLines([...sourceFallbacks, ...extensionlessCandidates, resolvedCandidate]);
}

function deriveSourceCandidatesFromBuiltArtifact(path: string) {
  const normalized = normalizePromptPath(path);

  if (!/\/dist\/.+\.(?:mjs|cjs|js)$/i.test(normalized)) {
    return [];
  }

  const sourceBase = normalized
    .replace(/\/dist\//i, "/src/")
    .replace(/\.(?:mjs|cjs|js)$/i, "");

  return [
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    `${sourceBase}.js`,
    `${sourceBase}.mjs`,
    `${sourceBase}.cjs`
  ];
}

function deriveExtensionlessEntryCandidates(path: string) {
  const normalized = normalizePromptPath(path);

  if (/\.[A-Za-z0-9]+$/.test(pathPosix.basename(normalized))) {
    return [];
  }

  return [
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.mjs`,
    `${normalized}.cjs`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.mjs`,
    `${normalized}/index.cjs`
  ];
}

function deriveLikelyWholeProjectInspectionPath(path: string, rawOutput?: string) {
  const normalized = normalizePromptPath(path);

  if (looksLikeProjectEntryPath(normalized) && !looksLikeEditableSourcePath(normalized)) {
    return deriveLikelyProjectWorkfileFromEntryPath(normalized, rawOutput);
  }

  if (!looksLikePrimaryProjectEntrySourcePath(normalized)) {
    return undefined;
  }

  const importedPath = extractLikelyRelativeImplementationImportPath(normalized, rawOutput);

  if (importedPath) {
    return importedPath;
  }

  return deriveLikelySiblingInspectionPath(normalized);
}

function looksLikePrimaryProjectEntrySourcePath(path: string) {
  const normalized = normalizePromptPath(path);

  return /(?:^|\/)(?:app|index|main|server)\.(?:mjs|cjs|js|ts|tsx)$/i.test(normalized)
    || /(?:^|\/)src\/index\.(?:mjs|cjs|js|ts|tsx)$/i.test(normalized);
}

function extractLikelyRelativeImplementationImportPath(fromFile: string, rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const matches = [
    ...rawOutput.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"'?#]+)["']/g),
    ...rawOutput.matchAll(/\brequire\(\s*["'](\.{1,2}\/[^"'?#]+)["']\s*\)/g)
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/\.(?:json|css|scss|sass|less|png|jpg|jpeg|gif|svg)$/i.test(value));

  for (const relativePath of matches) {
    const resolved = resolveRelativeInspectionImportPath(fromFile, relativePath);

    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function resolveRelativeInspectionImportPath(fromFile: string, target: string) {
  const resolvedBase = resolveRelativeModulePath(fromFile, target);

  if (!resolvedBase) {
    return undefined;
  }

  if (/\.(?:mjs|cjs|js|ts|tsx|ejs|html|css)$/i.test(resolvedBase)) {
    return resolvedBase;
  }

  const sourceExtension = pathPosix.extname(fromFile).toLowerCase();
  const preferredScriptExtensions = sourceExtension === ".tsx"
    ? [".tsx", ".ts", ".js", ".mjs", ".cjs"]
    : sourceExtension === ".ts"
      ? [".ts", ".tsx", ".js", ".mjs", ".cjs"]
      : sourceExtension === ".mjs"
        ? [".mjs", ".js", ".ts", ".tsx", ".cjs"]
        : sourceExtension === ".cjs"
          ? [".cjs", ".js", ".ts", ".tsx", ".mjs"]
          : [".js", ".ts", ".tsx", ".mjs", ".cjs"];

  const candidates = [
    ...preferredScriptExtensions.map((extension) => `${resolvedBase}${extension}`),
    `${resolvedBase}/index.js`,
    `${resolvedBase}/index.ts`,
    `${resolvedBase}/index.tsx`,
    `${resolvedBase}/index.mjs`
  ];

  return candidates[0];
}

function deriveLikelySiblingInspectionPath(path: string) {
  const normalized = normalizePromptPath(path);
  const appEntryMatch = normalized.match(/^(.*)\/app\.(?:mjs|cjs|js|ts|tsx)$/i);

  if (appEntryMatch?.[1]) {
    return `${appEntryMatch[1]}/views/index.ejs`;
  }

  const srcIndexMatch = normalized.match(/^(.*)\/src\/index\.(?:mjs|cjs|js|ts|tsx)$/i);

  if (srcIndexMatch?.[1]) {
    return `${srcIndexMatch[1]}/src/app.ts`;
  }

  return undefined;
}

function extractShellCommandFromSummary(summary: string) {
  const match = summary.match(/^(.+?)\s+·\s+(?:completed|failed(?:\s*\(\d+\))?|timed out|cancelled|running)\b/i);
  return match?.[1]?.trim();
}

function extractPrimaryPathFromShellCommand(command: string) {
  const match = command.match(
    /\b((?:src|config|apps?|packages?|docs)?\/?[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))\b/
  );
  const candidate = match?.[1]?.trim();

  if (!candidate) {
    return undefined;
  }

  const normalized = stripLineLocationSuffix(normalizePromptPath(candidate));

  if (
    normalized.startsWith("node:")
    || normalized.startsWith("file:///")
    || normalized.includes("/node_modules/")
    || normalized === "."
  ) {
    return undefined;
  }

  return normalized;
}

function extractExpectedExactOutput(content: string) {
  return extractExpectedOutputFromTaskRequest(content);
}

function extractVerificationCommandFromTaskRequest(content: string) {
  const backtickValues = [...content.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const commandValues = backtickValues.filter((value) => /^(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\b/i.test(value));
  return commandValues.at(-1);
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

function looksLikePendingVerificationShellOutput(output: string) {
  const normalized = output.trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  return /\b(app-only|view-only|not-ready|pending|incomplete|partial)\b/.test(normalized)
    || /(未就绪|未完成|进行中|只完成了一部分|部分完成)/u.test(output);
}

function rawShellOutputContainsPendingVerificationState(rawOutput?: string) {
  if (!rawOutput) {
    return false;
  }

  return looksLikePendingVerificationShellOutput(rawOutput);
}

function looksLikeProjectListingOutput(summary: string, rawOutput?: string) {
  const command = extractShellCommandFromSummary(summary)?.toLowerCase() ?? "";
  const output = rawOutput ?? "";

  if (!output.trim()) {
    return false;
  }

  if (/\b(ls|find|tree)\b/.test(command)) {
    return true;
  }

  return /(?:^|\n)(?:package\.json|README\.md|src\/|app\.js|index\.(?:js|ts)|node_modules|docs\/)/m.test(output);
}

function extractLikelyProjectEntryFromListing(rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [
    /(?:^|\/)([^/\s]+\/package\.json)$/i,
    /(?:^|\/)([^/\s]+\/README\.md)$/i,
    /(?:^|\/)([^/\s]+\/app\.js)$/i,
    /(?:^|\/)([^/\s]+\/src\/index\.(?:js|ts|tsx))$/i,
    /(?:^|\/)(package\.json)$/i,
    /(?:^|\/)(README\.md)$/i,
    /(?:^|\/)(app\.js)$/i
  ];

  for (const pattern of candidates) {
    const match = lines.find((line) => pattern.test(line))?.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
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
    ...matchAllGroups(content, /\b((?:src|config|apps?|packages?|docs)\/[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt|md|csv))(?::\d+(?::\d+)?)?/g),
    ...matchAllGroups(content, /\b([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt|md|csv))(?::\d+(?::\d+)?)?/g)
  ]
    .map(normalizePromptPath)
    .map(stripLineLocationSuffix)
    .filter((value) => !value.startsWith("node:"))
    .filter((value) => !value.includes("/node_modules/"))
    .filter((value) => !value.startsWith("file:///"));

  return dedupePromptLines(candidates)[0];
}

function extractReferencedLocation(content: string) {
  const match = content.match(/\b([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt|md|csv):\d+(?::\d+)?)\b/);
  return match?.[1] ? normalizePromptPath(match[1].trim()) : undefined;
}

function stripLineLocationSuffix(value: string) {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function normalizePromptPath(value: string) {
  const trimmed = value.trim();
  const relativeMatch = trimmed.match(/((?:src|config|apps?|packages?|docs)\/[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|js|ts|txt|md|csv)(?::\d+(?::\d+)?)?)/);

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

function shouldDeferAssistantMessageEmission(originalRequest: string) {
  if (looksLikeNextStepProposalRequest(originalRequest) || isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  return looksLikeActionableTaskRequest(originalRequest);
}

function shouldPreserveDeferredAssistantStage(content: string) {
  return looksLikeStageSummaryWithPendingWork(content)
    && !looksLikeBroadProposalReply(content)
    && Boolean(extractLikelyNextTargetPathFromAssistantMessage(content));
}

function extractPendingAssistantCheckpoint(
  content: string,
  originalRequest?: string,
  latestTool?: {
    toolName?: string;
    toolSummary?: string;
    toolRawOutput?: string;
  }
) {
  const targetPath = resolvePendingNextStepTargetFromAssistantStage({
    assistantMessage: content,
    originalRequest,
    latestTool
  });

  if (!targetPath || !looksLikeStageSummaryWithPendingWork(content)) {
    return undefined;
  }

  return {
    kind: "pending_next_step" as const,
    targetPath
  };
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
  const followUpContext = buildRecentFollowUpContext(historyEvents);
  const followUp = classifyRunnableFollowUp(content);

  if (!followUp) {
    return content;
  }

  if (
    followUp.kind === "inspect"
    && followUp.wholeProjectInspection
    && isStandaloneWholeProjectInspectionRequest(content)
  ) {
    return content;
  }

  const interruptedResume = resolveInterruptedResumeFollowUp({
    content,
    historyEvents,
    followUp,
    previousAssistantProposal: followUpContext.previousAssistantProposal
  });

  if (interruptedResume) {
    return interruptedResume;
  }

  const deniedApprovalResume = resolveDeniedApprovalResumeFollowUp({
    content,
    historyEvents,
    followUp
  });

  if (deniedApprovalResume) {
    return deniedApprovalResume;
  }

  if (followUp.kind === "resume") {
    return content;
  }

  if (followUp.kind === "optimize" && followUpContext.previousAssistantProposal && looksLikeAssistantOptimizationProposal(followUpContext.previousAssistantProposal)) {
    return buildApprovedOptimizeProposalPrompt({
      content,
      approvedProposal: followUpContext.previousAssistantProposal,
      recentEditableWorkingFile: followUpContext.recentEditableWorkingFile
    });
  }

  if (followUp.kind === "rewrite" && followUpContext.previousAssistantProposal && looksLikeAssistantRewriteProposal(followUpContext.previousAssistantProposal)) {
    return buildApprovedRewriteProposalPrompt({
      content,
      approvedProposal: followUpContext.previousAssistantProposal,
      recentEditableWorkingFile: followUpContext.recentEditableWorkingFile
    });
  }

  if (followUp.kind === "inspect" && followUpContext.previousAssistantProposal && looksLikeAssistantInspectionProposal(followUpContext.previousAssistantProposal)) {
    return buildApprovedInspectProposalPrompt({
      content,
      approvedProposal: followUpContext.previousAssistantProposal,
      recentEditableWorkingFile: followUpContext.recentEditableWorkingFile,
      wholeProjectInspection: followUp.wholeProjectInspection
    });
  }

  if (
    (followUp.kind === "optimize" || followUp.kind === "rewrite" || followUp.kind === "inspect")
    && (followUpContext.previousUserTask || followUpContext.recentEditableWorkingFile)
  ) {
    return buildRecentContextFollowUpPrompt({
      content,
      intent: followUp.kind,
      previousUserTask: followUpContext.previousUserTask,
      recentEditableWorkingFile: followUpContext.recentEditableWorkingFile,
      wholeProjectInspection: followUp.kind === "inspect" ? followUp.wholeProjectInspection : undefined
      });
  }

  if (followUp.kind === "approve" && followUpContext.previousAssistantProposal) {
    if (looksLikeAssistantRewriteProposal(followUpContext.previousAssistantProposal)) {
      return buildApprovedRewriteProposalPrompt({
        content,
        approvedProposal: followUpContext.previousAssistantProposal,
        recentEditableWorkingFile: followUpContext.recentEditableWorkingFile
      });
    }
  }

  if (followUp.kind !== "approve" || !followUpContext.previousAssistantProposal) {
    return content;
  }

  return buildApprovedProposalPrompt({
    content,
    approvedProposal: followUpContext.previousAssistantProposal
  });
}

type RunnableFollowUp =
  | { kind: "resume" }
  | { kind: "approve" }
  | { kind: "optimize" }
  | { kind: "rewrite" }
  | { kind: "inspect"; wholeProjectInspection: boolean };

function classifyRunnableFollowUp(content: string): RunnableFollowUp | undefined {
  if (isResumeFollowUp(content)) {
    return { kind: "resume" };
  }

  if (isVagueOptimizationFollowUp(content)) {
    return { kind: "optimize" };
  }

  if (isVagueRewriteFollowUp(content)) {
    return { kind: "rewrite" };
  }

  if (isVagueInspectionFollowUp(content)) {
    return {
      kind: "inspect",
      wholeProjectInspection: isWholeProjectInspectionFollowUp(content)
    };
  }

  if (isAffirmativeFollowUp(content)) {
    return { kind: "approve" };
  }

  return undefined;
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

  if (isProposalAcceptanceFollowUp(normalized)) {
    return true;
  }

  return /^(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧)(?:[\s,，。!！?？/]+(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧))+$/iu.test(normalized);
}

function isProposalAcceptanceFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  return /^(?:按你说的|照你说的)(?:改|做|来)吧?$|^(?:按这个|照这个)(?:改|做|来)吧?$|^(?:就按这个|那就按这个)(?:改|做|来)吧?$/iu.test(normalized);
}

function isVagueOptimizationFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 32) {
    return false;
  }

  return /^(?:帮我)?(?:优化|改进|重构)(?:一下|下)?$/iu.test(normalized)
    || /^(?:帮我)(?:优化|改进|重构)(?:(?:这个)?(?:项目|仓库|代码))(?:一下|下)?$/iu.test(normalized)
    || /^(?:optimize|improve|refactor)(?: it| this)?$/iu.test(normalized);
}

function isVagueRewriteFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 40) {
    return false;
  }

  return /^(?:你能)?(?:帮我)?(?:重新写|重写)(?:(?:这个|整个)?(?:项目|仓库|代码)|这个|整个|个项目|一个项目)?(?:一下|下|吗)?$/iu.test(normalized)
    || /^(?:rewrite|rebuild)(?: it| this| the project)?$/iu.test(normalized);
}

function isVagueInspectionFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 72) {
    return false;
  }

  return /^(?:帮我)?(?:看看|看下|检查下|瞅瞅)(?:这个|一下|下)?$/iu.test(normalized)
    || /^(?:帮我)(?:看看|看下|检查下|瞅瞅)(?:(?:这个)?(?:项目|仓库|代码))$/iu.test(normalized)
    || isWholeProjectInspectionFollowUp(normalized)
    || /^(?:inspect|review|look at)(?: it| this)?$/iu.test(normalized);
}

function isWholeProjectInspectionFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 72) {
    return false;
  }

  return /^(?:你能)?(?:不能)?(?:一次性)?(?:都)?(?:帮我)?(?:(?:看完|看看|检查|检查下|看下|审一下)).*(?:整个|完整|全部).*(?:项目|仓库|代码)(?:吗)?$/iu.test(normalized)
    || /^(?:你能)?(?:帮我)?(?:把)?(?:整个|完整|全部).*(?:项目|仓库|代码).*(?:看完|看看|检查|检查下|看下|审一下)(?:吗)?$/iu.test(normalized)
    || /^(?:inspect|review|look at).*(?:whole|entire|full).*(?:project|repo|repository|codebase)$/iu.test(normalized);
}

function isStandaloneWholeProjectInspectionRequest(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  return /^(?:你能|可以|能不能)(?:一次性)?(?:都)?(?:帮我)?(?:(?:看完|看看|检查|检查下|看下|审一下)).*(?:整个|完整|全部).*(?:项目|仓库|代码)(?:吗)?$/iu.test(normalized)
    || /^(?:can you|could you|please)\b.*(?:look at|inspect|review).*(?:whole|entire|full).*(?:project|repo|repository|codebase)\b/i.test(normalized);
}

function detectNaturalApprovalDecision(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return undefined;
  }

  if (normalized.length > 24) {
    return undefined;
  }

  if (isAffirmativeFollowUp(normalized)) {
    return "approve" as const;
  }

  if (/^(不行|不可以|不批|不同意|拒绝|先别|别执行|不要执行|deny|no|nope|stop here)$/iu.test(normalized)) {
    return "deny" as const;
  }

  return undefined;
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

function extractLatestActionableUserRequest(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

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
  const previousActionableUserIndex = findPreviousActionableUserTimelineIndex(timeline);
  let skippedLatestUser = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (previousActionableUserIndex >= 0 && index <= previousActionableUserIndex) {
      break;
    }

    if (entry?.kind === "assistant" && looksLikeAssistantProposal(entry.text)) {
      return entry.text;
    }
  }

  return undefined;
}

function findPreviousActionableUserTimelineIndex(
  timeline: ReturnType<typeof projectSessionTimeline>
) {
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
      return index;
    }
  }

  return -1;
}

function extractRecentEditableWorkingFile(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);
  const previousActionableUserIndex = findPreviousActionableUserTimelineIndex(timeline);
  let fallbackEditablePath: string | undefined;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (previousActionableUserIndex >= 0 && index <= previousActionableUserIndex) {
      break;
    }

    if (entry?.kind !== "tool" || !entry.toolSummary) {
      continue;
    }

    if (entry.toolName !== "files" && entry.toolName !== "edit" && entry.toolName !== "write") {
      continue;
    }

    const path = extractPathFromToolSummary(entry.toolSummary);

    if (path && looksLikeEditableSourcePath(path)) {
      fallbackEditablePath ??= path;

      if (!looksLikeAuxiliaryVerificationSourcePath(path)) {
        return path;
      }
    }
  }

  return fallbackEditablePath;
}

function extractRecentToolAnchor(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);
  const previousActionableUserIndex = findPreviousActionableUserTimelineIndex(timeline);
  let skippedLatestUser = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (previousActionableUserIndex >= 0 && index <= previousActionableUserIndex) {
      break;
    }

    if (entry?.kind === "tool" && entry.toolName && entry.toolSummary) {
      return {
        toolName: entry.toolName,
        summary: entry.toolSummary
      };
    }
  }

  return undefined;
}

function extractRecentPendingNextTarget(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const checkpointTarget = extractRecentPendingNextTargetCheckpoint(historyEvents);

  if (checkpointTarget) {
    return checkpointTarget;
  }

  const timeline = projectSessionTimeline(historyEvents);
  const previousActionableUserIndex = findPreviousActionableUserTimelineIndex(timeline);
  const originalRequest = extractPreviousActionableUserRequest(historyEvents)
    ?? extractLatestActionableUserRequest(historyEvents);
  let skippedLatestUser = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (previousActionableUserIndex >= 0 && index <= previousActionableUserIndex) {
      break;
    }

    if (entry?.kind !== "assistant") {
      continue;
    }

    const nextTarget = resolvePendingNextStepTargetFromAssistantStage({
      assistantMessage: entry.text,
      originalRequest,
      latestTool: findNearestToolTimelineEntryBeforeIndex(
        timeline,
        index,
        previousActionableUserIndex
      )
    });

    if (nextTarget) {
      return nextTarget;
    }
  }

  const latestTool = findNearestToolTimelineEntryBeforeIndex(
    timeline,
    timeline.length,
    previousActionableUserIndex
  );

  return derivePendingNextTargetFromLatestToolContext({
    originalRequest,
    latestTool
  });
}

function extractRecentPendingNextTargetCheckpoint(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const taskAnchorUserEventIndex = findPreviousActionableUserEventIndex(historyEvents) >= 0
    ? findPreviousActionableUserEventIndex(historyEvents)
    : findLatestActionableUserEventIndex(historyEvents);
  const relevantEvents = taskAnchorUserEventIndex >= 0
    ? historyEvents.slice(taskAnchorUserEventIndex + 1)
    : historyEvents;

  for (let index = relevantEvents.length - 1; index >= 0; index -= 1) {
    const event = relevantEvents[index];

    if (event?.type !== "assistant.checkpoint.recorded" || event.payload.kind !== "pending_next_step") {
      continue;
    }

    if (event.payload.targetPath) {
      return event.payload.targetPath;
    }
  }

  return undefined;
}

function findNearestToolTimelineEntryBeforeIndex(
  timeline: ReturnType<typeof projectSessionTimeline>,
  index: number,
  lowerBoundExclusive = -1
) {
  for (let cursor = index - 1; cursor > lowerBoundExclusive; cursor -= 1) {
    const entry = timeline[cursor];

    if (entry?.kind === "tool" && entry.toolName && entry.toolSummary) {
      return entry;
    }
  }

  return undefined;
}

function extractRecentInterruptedApprovalAnchor(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const latestUserIndex = findLatestUserMessageIndex(historyEvents);
  const previousActionableUserEventIndex = findPreviousActionableUserEventIndex(historyEvents);
  const relevantEvents = latestUserIndex >= 0
    ? historyEvents.slice(
      Math.max(0, previousActionableUserEventIndex >= 0 ? previousActionableUserEventIndex : 0),
      latestUserIndex
    )
    : historyEvents;

  for (let index = relevantEvents.length - 1; index >= 0; index -= 1) {
    const event = relevantEvents[index];

    if (event?.type !== "approval.resolved" || event.payload.approved) {
      continue;
    }

    let requestIndex = -1;

    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = relevantEvents[candidateIndex];

      if (
        candidate?.type === "approval.requested"
        && candidate.payload.approvalId === event.payload.approvalId
      ) {
        requestIndex = candidateIndex;
        break;
      }
    }

    if (requestIndex < 0) {
      continue;
    }

    const interruptedAfterRequest = relevantEvents.slice(requestIndex + 1, index).some((candidate) =>
      candidate.type === "runtime.interrupt.requested"
    );

    if (!interruptedAfterRequest) {
      continue;
    }

    const request = relevantEvents[requestIndex];

    if (request?.type !== "approval.requested") {
      continue;
    }

    const target = renderApprovalTarget(request.payload.toolName, request.payload.input) || request.payload.reason;

    return {
      toolName: request.payload.toolName,
      target
    };
  }

  return undefined;
}

function extractRecentDeniedApprovalAnchor(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const latestUserIndex = findLatestUserMessageIndex(historyEvents);
  const previousActionableUserEventIndex = findPreviousActionableUserEventIndex(historyEvents);
  const relevantEvents = latestUserIndex >= 0
    ? historyEvents.slice(
      Math.max(0, previousActionableUserEventIndex >= 0 ? previousActionableUserEventIndex : 0),
      latestUserIndex
    )
    : historyEvents;

  for (let index = relevantEvents.length - 1; index >= 0; index -= 1) {
    const event = relevantEvents[index];

    if (event?.type !== "approval.resolved" || event.payload.approved) {
      continue;
    }

    let requestIndex = -1;

    for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = relevantEvents[candidateIndex];

      if (
        candidate?.type === "approval.requested"
        && candidate.payload.approvalId === event.payload.approvalId
      ) {
        requestIndex = candidateIndex;
        break;
      }
    }

    if (requestIndex < 0) {
      continue;
    }

    const request = relevantEvents[requestIndex];

    if (request?.type !== "approval.requested") {
      continue;
    }

    const target = renderApprovalTarget(request.payload.toolName, request.payload.input) || request.payload.reason;

    return {
      toolName: request.payload.toolName,
      target
    };
  }

  return undefined;
}

function findLatestUserMessageIndex(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    if (historyEvents[index]?.type === "user.message.submitted") {
      return index;
    }
  }

  return -1;
}

function findPreviousActionableUserEventIndex(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const latestUserIndex = findLatestUserMessageIndex(historyEvents);

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];

    if (event?.type !== "user.message.submitted") {
      continue;
    }

    const content = event.payload.content;

    if (
      !isAffirmativeFollowUp(content)
      && !isResumeFollowUp(content)
      && looksLikeActionableTaskRequest(content)
    ) {
      return index;
    }
  }

  return -1;
}

function findLatestActionableUserEventIndex(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];

    if (event?.type !== "user.message.submitted") {
      continue;
    }

    const content = event.payload.content;

    if (
      !isAffirmativeFollowUp(content)
      && !isResumeFollowUp(content)
      && looksLikeActionableTaskRequest(content)
    ) {
      return index;
    }
  }

  return -1;
}

function buildRecentContextFollowUpPrompt(input: {
  content: string;
  intent: "optimize" | "rewrite" | "inspect";
  previousUserTask?: string;
  recentEditableWorkingFile?: string;
  wholeProjectInspection?: boolean;
}) {
  const requestLine = input.intent === "inspect"
    ? input.wholeProjectInspection
      ? `The user replied "${input.content.trim()}" and wants you to inspect the most recently active whole project now.`
      : `The user replied "${input.content.trim()}" and wants you to inspect the most recently active project or file now.`
    : `The user replied "${input.content.trim()}" and wants you to ${input.intent} the most recently inspected project or file now.`;

  const actionLine = input.intent === "optimize"
    ? "Do the work now instead of stopping at analysis."
    : input.intent === "rewrite"
      ? "Do the rewrite work now instead of stopping at analysis or another proposal."
      : input.wholeProjectInspection
        ? "Treat this as a whole-project inspection follow-up, not a single-file peek."
        : "Inspect the most concrete current target instead of restarting broad exploration.";

  const targetingLine = input.intent === "inspect"
    ? "Do not ask what to inspect first unless the current context truly lacks a concrete target."
    : "Do not ask which file to start from unless the current context truly lacks a concrete target.";
  const projectRewriteLine = input.intent === "rewrite"
    ? "Treat this as a project-level rewrite follow-up, so anchor on the project entry before narrowing back down to implementation files."
    : "";
  const recentEditableWorkingFileLine = input.intent === "rewrite"
    ? ""
    : input.recentEditableWorkingFile ? `Recent editable working file: ${input.recentEditableWorkingFile}` : "";

  return [
    requestLine,
    actionLine,
    targetingLine,
    projectRewriteLine,
    "Start with the concrete work result, current finding, or the next real action.",
    "Continue from the latest task state and recent working files already in context.",
    recentEditableWorkingFileLine,
    input.previousUserTask ? `Previous context request: ${input.previousUserTask}` : ""
  ].filter(Boolean).join("\n");
}

function buildApprovedProposalPrompt(input: {
  content: string;
  approvedProposal: string;
}) {
  return [
    `The user replied "${input.content.trim()}" to approve the immediately previous proposal.`,
    "Carry out that approved proposal now instead of restating it.",
    "Do not start with an acknowledgement like 可以, 可以继续, 好的, sure, or okay.",
    "Start with the concrete work result, current finding, or the next real action.",
    `Approved proposal: ${input.approvedProposal}`
  ].join("\n");
}

function buildApprovedRewriteProposalPrompt(input: {
  content: string;
  approvedProposal: string;
  recentEditableWorkingFile?: string;
}) {
  return [
    `The user replied "${input.content.trim()}" and wants you to execute the immediately previous rewrite proposal now.`,
    "Carry out that rewrite now instead of narrowing it to a single-file tweak.",
    "Do the rewrite work now instead of stopping at analysis or another proposal.",
    "Do not ask which file to start from unless the current context truly lacks a concrete target.",
    "Start with the concrete work result, current finding, or the next real action.",
    "Continue from the latest task state and recent working files already in context.",
    input.recentEditableWorkingFile ? `Recent editable working file: ${input.recentEditableWorkingFile}` : "",
    `Approved proposal: ${input.approvedProposal}`
  ].filter(Boolean).join("\n");
}

function buildApprovedOptimizeProposalPrompt(input: {
  content: string;
  approvedProposal: string;
  recentEditableWorkingFile?: string;
}) {
  return [
    `The user replied "${input.content.trim()}" and wants you to execute the immediately previous optimize proposal now.`,
    "Carry out that optimization now instead of turning it into another generic suggestion.",
    "Do the optimize work now instead of stopping at analysis or another proposal.",
    "Do not ask which file to start from unless the current context truly lacks a concrete target.",
    "Start with the concrete work result, current finding, or the next real action.",
    "Continue from the latest task state and recent working files already in context.",
    input.recentEditableWorkingFile ? `Recent editable working file: ${input.recentEditableWorkingFile}` : "",
    `Approved proposal: ${input.approvedProposal}`
  ].filter(Boolean).join("\n");
}

function buildApprovedInspectProposalPrompt(input: {
  content: string;
  approvedProposal: string;
  recentEditableWorkingFile?: string;
  wholeProjectInspection?: boolean;
}) {
  return [
    `The user replied "${input.content.trim()}" and wants you to execute the immediately previous inspect proposal now.`,
    input.wholeProjectInspection
      ? "Carry out that whole-project inspection now instead of shrinking it to a single-file glance."
      : "Carry out that inspection now instead of drifting into another generic suggestion.",
    input.wholeProjectInspection
      ? "Treat this as a whole-project inspection follow-up, not a single-file peek."
      : "Inspect the most concrete current target instead of restarting broad exploration.",
    "Do not ask what to inspect first unless the current context truly lacks a concrete target.",
    "Start with the concrete work result, current finding, or the next real action.",
    "Continue from the latest task state and recent working files already in context.",
    input.recentEditableWorkingFile ? `Recent editable working file: ${input.recentEditableWorkingFile}` : "",
    `Approved proposal: ${input.approvedProposal}`
  ].filter(Boolean).join("\n");
}

function buildRecentFollowUpContext(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const previousUserTask = extractPreviousActionableUserRequest(historyEvents);

  return {
    previousUserTask,
    previousAssistantProposal: extractPreviousAssistantProposal(historyEvents),
    recentEditableWorkingFile: deriveRecentFollowUpWorkingFile(previousUserTask, historyEvents)
  };
}

function deriveRecentFollowUpWorkingFile(
  previousUserTask: string | undefined,
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  if (previousUserTask && (
    looksLikeBroadProjectImprovementRequest(previousUserTask)
    || looksLikeProjectRewriteRequest(previousUserTask)
    || looksLikeProjectInspectionRequest(previousUserTask)
    || looksLikeExactOutputRequest(previousUserTask)
  )) {
    const explicitEditableTargets = extractExplicitFileTargets(previousUserTask)
      .filter((path) => looksLikeEditableSourcePath(path) && !looksLikeAuxiliaryVerificationSourcePath(path));

    if (explicitEditableTargets.length > 0) {
      return explicitEditableTargets[0];
    }
  }

  return extractRecentEditableWorkingFile(historyEvents);
}

function resolveInterruptedResumeFollowUp(input: {
  content: string;
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>;
  followUp: RunnableFollowUp;
  previousAssistantProposal?: string;
}) {
  switch (input.followUp.kind) {
    case "resume":
      return buildInterruptedTaskResumeForFollowUp({
        content: input.content,
        historyEvents: input.historyEvents,
        acknowledgementMode: "discussion question",
        requireInterruptedTask: false
      });

    case "approve":
      return buildInterruptedTaskResumeForFollowUp({
        content: input.content,
        historyEvents: input.historyEvents,
        acknowledgementMode: "generic acknowledgement",
        requireInterruptedTask: true,
        allowProposalResumeOnlyAfterExecution: true,
        previousAssistantProposal: input.previousAssistantProposal
      });

    case "optimize":
      return buildInterruptedTaskResumeForFollowUp({
        content: input.content,
        historyEvents: input.historyEvents,
        acknowledgementMode: "broad optimization follow-up",
        requireInterruptedTask: true
      });

    case "rewrite":
      {
        const previousUserTask = extractPreviousActionableUserRequest(input.historyEvents);
        const isInterruptedDirectRewriteTask = Boolean(
          previousUserTask && looksLikeExecutableProjectRewriteRequest(previousUserTask)
        );

        return buildInterruptedTaskResumeForFollowUp({
          content: input.content,
          historyEvents: input.historyEvents,
          acknowledgementMode: "broad rewrite follow-up",
          requireInterruptedTask: true,
          requireProposalExecution: !isInterruptedDirectRewriteTask
        });
      }

    case "inspect":
      return buildInterruptedTaskResumeForFollowUp({
        content: input.content,
        historyEvents: input.historyEvents,
        acknowledgementMode: "broad inspection follow-up",
        requireInterruptedTask: true
      });

    default:
      return undefined;
  }
}

function resolveDeniedApprovalResumeFollowUp(input: {
  content: string;
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>;
  followUp: RunnableFollowUp;
}) {
  if (
    input.followUp.kind !== "resume"
    && input.followUp.kind !== "approve"
    && input.followUp.kind !== "optimize"
    && input.followUp.kind !== "rewrite"
  ) {
    return undefined;
  }

  if (hasRecentInterruptedAssistantTask(input.historyEvents)) {
    return undefined;
  }

  const previousUserTask = extractPreviousActionableUserRequest(input.historyEvents);

  if (!previousUserTask) {
    return undefined;
  }

  const recentDeniedApproval = extractRecentDeniedApprovalAnchor(input.historyEvents);

  if (!recentDeniedApproval) {
    return undefined;
  }

  return [
    `The user replied "${input.content.trim()}" after the most recent task reached a denied approval.`,
    "Do not retry the same denied action unless the user explicitly asks again or approves a new attempt.",
    "Explain briefly what remains blocked and what explicit approval or request would be needed to continue.",
    `Latest denied approval: ${recentDeniedApproval.toolName} · ${recentDeniedApproval.target}`,
    `Original task: ${previousUserTask}`
  ].join("\n");
}

function buildInterruptedTaskResumeForFollowUp(input: {
  content: string;
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>;
  acknowledgementMode:
    | "discussion question"
    | "generic acknowledgement"
    | "broad rewrite follow-up"
    | "broad optimization follow-up"
    | "broad inspection follow-up";
  requireInterruptedTask: boolean;
  requireProposalExecution?: boolean;
  allowProposalResumeOnlyAfterExecution?: boolean;
  previousAssistantProposal?: string;
}) {
  const previousUserTask = extractPreviousActionableUserRequest(input.historyEvents);

  if (!previousUserTask) {
    return undefined;
  }

  if (input.requireInterruptedTask && !hasRecentInterruptedAssistantTask(input.historyEvents)) {
    return undefined;
  }

  if (input.requireProposalExecution && !hasRecentInterruptedProposalExecution(input.historyEvents)) {
    return undefined;
  }

  if (input.allowProposalResumeOnlyAfterExecution) {
    const previousAssistantProposal = input.previousAssistantProposal ?? extractPreviousAssistantProposal(input.historyEvents);

    if (previousAssistantProposal && !hasRecentInterruptedProposalExecution(input.historyEvents)) {
      return undefined;
    }
  }

  return buildInterruptedTaskResumeRequest({
    content: input.content,
    previousUserTask,
    historyEvents: input.historyEvents,
    acknowledgementMode: input.acknowledgementMode
  });
}

function buildInterruptedTaskResumeRequest(input: {
  content: string;
  previousUserTask: string;
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>;
  acknowledgementMode:
    | "discussion question"
    | "generic acknowledgement"
    | "broad rewrite follow-up"
    | "broad optimization follow-up"
    | "broad inspection follow-up";
}) {
  const recentEditableWorkingFile = extractRecentEditableWorkingFile(input.historyEvents);
  const recentPendingNextTarget = extractRecentPendingNextTarget(input.historyEvents);
  const recentToolAnchor = extractRecentToolAnchor(input.historyEvents);
  const interruptedApprovalAnchor = hasRecentInterruptedAssistantTask(input.historyEvents)
    ? extractRecentInterruptedApprovalAnchor(input.historyEvents)
    : undefined;

  return [
    `The user replied "${input.content.trim()}" and wants to continue the most recent unfinished task.`,
    `Resume that task now instead of treating this as a ${input.acknowledgementMode}.`,
    "Do not start with an acknowledgement like 可以, 可以继续, 好的, sure, or okay.",
    "Start with the concrete work result, current finding, or the next real action.",
    "Continue from the latest task state already in context.",
    recentEditableWorkingFile ? `Recent editable working file: ${recentEditableWorkingFile}` : "",
    recentPendingNextTarget ? `Pending next step target: ${recentPendingNextTarget}` : "",
    recentToolAnchor ? `Latest tool in context: ${recentToolAnchor.toolName}` : "",
    recentToolAnchor ? `Latest tool summary in context: ${recentToolAnchor.summary}` : "",
    interruptedApprovalAnchor
      ? `Interrupted pending approval: ${interruptedApprovalAnchor.toolName} · ${interruptedApprovalAnchor.target}`
      : "",
    interruptedApprovalAnchor
      ? "The previous run stopped while waiting for that approval. Retry that concrete action first instead of restarting broader inspection."
      : "",
    `Original task: ${input.previousUserTask}`
  ].filter(Boolean).join("\n");
}

function hasRecentInterruptedAssistantTask(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
    const event = historyEvents[index];

    if (event?.type !== "task.state.changed" || event.payload.title !== "Respond to user input") {
      continue;
    }

    return event.payload.state === "cancelled" || event.payload.state === "failed";
  }

  return false;
}

function hasRecentInterruptedProposalExecution(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  return hasRecentInterruptedAssistantTask(historyEvents)
    && hasToolActivitySinceLatestAssistantProposal(historyEvents);
}

function hasToolActivitySinceLatestAssistantProposal(
  historyEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  const timeline = projectSessionTimeline(historyEvents);
  const previousActionableUserIndex = findPreviousActionableUserTimelineIndex(timeline);
  let skippedLatestUser = false;
  let sawToolAfterProposal = false;

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (previousActionableUserIndex >= 0 && index <= previousActionableUserIndex) {
      break;
    }

    if (entry?.kind === "assistant" && looksLikeAssistantProposal(entry.text)) {
      return sawToolAfterProposal;
    }

    if (entry?.kind === "tool") {
      sawToolAfterProposal = true;
    }
  }

  return false;
}

function looksLikeAssistantProposal(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  const hasOffer = /\b(if you want|if you'd like|i can|next step|if you want me to continue|i would first|i'd first|i would start by|i'd start by|i would begin by|i'd begin by)\b/i.test(normalized)
    || /(如果你愿意|如果你要我继续|我下一步可以|我可以继续|下一步可以|我建议下一步|下一步我可以|我会先|我先)/u.test(normalized);
  const hasAction = /\b(read|write|edit|fix|repair|create|update|change|modify|inspect|review|check|run|look at|rewrite|rebuild|optimize|improve|refactor)\b/i.test(normalized)
    || /(读取|写入|编辑|修复|创建|更新|修改|检查|运行|改|阅读|查看|看下|看看|审一下|读|重写|优化|改进|重构)/u.test(normalized);

  return hasOffer && hasAction;
}

function looksLikeAssistantRewriteProposal(content: string) {
  const normalized = content.trim();

  if (!looksLikeAssistantProposal(normalized)) {
    return false;
  }

  const hasRewriteCue = /\b(rewrite|rebuild)\b/i.test(normalized)
    || /(重写|重新写)/u.test(normalized);
  const mentionedTargets = extractExplicitFileTargets(normalized);

  return hasRewriteCue || mentionedTargets.length >= 2;
}

function looksLikeAssistantOptimizationProposal(content: string) {
  const normalized = content.trim();

  if (!looksLikeAssistantProposal(normalized)) {
    return false;
  }

  if (looksLikeAssistantRewriteProposal(normalized)) {
    return false;
  }

  const hasOptimizeCue = /\b(optimize|improve|refactor|improvement)\b/i.test(normalized)
    || /(优化|改进|重构)/u.test(normalized);
  const mentionedTargets = extractExplicitFileTargets(normalized);

  return hasOptimizeCue || mentionedTargets.length >= 2;
}

function looksLikeAssistantInspectionProposal(content: string) {
  const normalized = content.trim();

  if (!looksLikeAssistantProposal(normalized)) {
    return false;
  }

  if (looksLikeAssistantRewriteProposal(normalized) || looksLikeAssistantOptimizationProposal(normalized)) {
    return false;
  }

  const hasInspectCue = /\b(inspect|inspection|review|check|look at|read through|read)\b/i.test(normalized)
    || /(检查|看看|看下|审一下|阅读|读一遍|查看|读)/u.test(normalized);
  const mentionedTargets = extractExplicitFileTargets(normalized);

  return hasInspectCue || mentionedTargets.length >= 2;
}

function resolveAssistantMessageContinuation(input: {
  originalRequest: string;
  assistantMessage: string;
  preferredLanguage: PreferredReplyLanguage;
  hasAttemptedTool: boolean;
  proposalNarrowingCount: number;
  lastToolResult?: RuntimeToolResult;
  workingFileAnchor?: string;
}) {
  if (
    input.proposalNarrowingCount === 0
    && shouldForceProposalNarrowing(input.originalRequest, input.assistantMessage)
  ) {
    return {
      nextPrompt: buildProposalNarrowingPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.preferredLanguage
      ),
      consumeProposalNarrowingCount: true
    };
  }

  if (
    !input.hasAttemptedTool
    && shouldForceInitialTaskStart(input.originalRequest, input.assistantMessage)
  ) {
    return {
      nextPrompt: buildPrematureTaskStartPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.preferredLanguage
      )
    };
  }

  if (!input.lastToolResult) {
    return undefined;
  }

  const anchoredToolResult = withWorkingFileAnchor(input.lastToolResult, input.workingFileAnchor);
  const continuationRules = [
    {
      when: () => shouldForceTaskContinuation(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildPrematureContinuationPrompt(
        input.originalRequest,
        input.assistantMessage,
        anchoredToolResult,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceProjectInspectionContinuation(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildProjectInspectionContinuationPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.lastToolResult!,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceWholeProjectInspectionContinuation(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildWholeProjectInspectionContinuationPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.lastToolResult!,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceProjectWorkfileContinuation(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildProjectWorkfileContinuationPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.lastToolResult!,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceFailureRecovery(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildFailureRecoveryPrompt(
        input.originalRequest,
        input.assistantMessage,
        anchoredToolResult,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceExecutionConvergence(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildExecutionConvergencePrompt(
        input.originalRequest,
        input.assistantMessage,
        anchoredToolResult,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceMultiTargetMutationContinuation(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildMultiTargetMutationContinuationPrompt(
        input.originalRequest,
        input.assistantMessage,
        anchoredToolResult,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceFollowUpReplyTightening(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildFollowUpReplyTighteningPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.lastToolResult!,
        input.preferredLanguage
      )
    },
    {
      when: () => shouldForceCompletionTightening(input.originalRequest, input.assistantMessage, input.lastToolResult!),
      nextPrompt: () => buildCompletionTighteningPrompt(
        input.originalRequest,
        input.assistantMessage,
        input.lastToolResult!,
        input.preferredLanguage
      )
    }
  ];

  for (const rule of continuationRules) {
    if (rule.when()) {
      return { nextPrompt: rule.nextPrompt() };
    }
  }

  return undefined;
}

function resolveFailedToolResultContinuation(input: {
  originalRequest: string;
  preferredLanguage: PreferredReplyLanguage;
  previousToolResult?: RuntimeToolResult;
  previousRepeatedToolResultCount: number;
  result: RuntimeToolResult;
  workingFileAnchor?: string;
}) {
  const repeatedToolResultCount = isSameToolResult(input.previousToolResult, input.result)
    ? input.previousRepeatedToolResultCount + 1
    : 0;

  if (shouldAutoSummarizeToolFailure(input.originalRequest, input.result)) {
    const directAnswer = buildDirectToolFailureAnswer(input.result, input.preferredLanguage);

    if (directAnswer) {
      return {
        kind: "direct_answer" as const,
        repeatedToolResultCount,
        directAnswer
      };
    }
  }

  const anchoredResult = withWorkingFileAnchor(input.result, input.workingFileAnchor);
  const nextPrompt = shouldUseStalledContinuationPrompt(input.originalRequest, repeatedToolResultCount, input.result)
    ? buildStalledToolContinuationPrompt(
      input.originalRequest,
      anchoredResult,
      repeatedToolResultCount,
      input.preferredLanguage
    )
    : buildToolFailureContinuationPrompt(
      input.originalRequest,
      anchoredResult,
      input.preferredLanguage
    );

  return {
    kind: "continue" as const,
    repeatedToolResultCount,
    nextPrompt
  };
}

function resolveSuccessfulToolResultContinuation(input: {
  originalRequest: string;
  preferredLanguage: PreferredReplyLanguage;
  previousToolResult?: AnchoredRuntimeToolResult;
  previousRepeatedToolResultCount: number;
  result: RuntimeToolResult;
  workingFileAnchor?: string;
}) {
  const repeatedToolResultCount = isSameToolResult(input.previousToolResult, input.result)
    ? input.previousRepeatedToolResultCount + 1
    : 0;

  if (shouldDirectlyFinalizeTerminalResult(input.originalRequest, input.result)) {
    const directAnswer = buildDirectTerminalCompletionAnswer(
      input.originalRequest,
      input.result,
      input.preferredLanguage
    );

    if (directAnswer) {
      return {
        repeatedToolResultCount,
        directAnswer
      };
    }

    return {
      repeatedToolResultCount,
      nextPrompt: buildToolContinuationPrompt(
        input.originalRequest,
        withWorkingFileAnchor(input.result, input.workingFileAnchor),
        input.preferredLanguage
      )
    };
  }

  const anchoredResult = withWorkingFileAnchor(input.result, input.workingFileAnchor);
  const nextPrompt = shouldUseStalledContinuationPrompt(input.originalRequest, repeatedToolResultCount, input.result)
    ? buildStalledToolContinuationPrompt(
      input.originalRequest,
      anchoredResult,
      repeatedToolResultCount,
      input.preferredLanguage
    )
    : input.previousToolResult && shouldCarryEditRangeFailureForward(input.previousToolResult, input.result)
      ? buildEditRangeRecoveryContinuationPrompt(
        input.originalRequest,
        input.previousToolResult,
        input.result,
        input.preferredLanguage
      )
      : buildToolContinuationPrompt(
        input.originalRequest,
        anchoredResult,
        input.preferredLanguage
      );

  return {
    repeatedToolResultCount,
    nextPrompt
  };
}

function shouldForceTaskContinuation(originalRequest: string, assistantMessage: string, latestToolResult: RuntimeToolResult) {
  if (!looksLikeLongRunningTask(originalRequest)) {
    return false;
  }

  if (isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (looksLikeProjectInspectionRequest(originalRequest) || looksLikeExecutionTask(originalRequest)) {
    return false;
  }

  if (
    looksLikePathScopedCompletionForMultiTargetRequest(originalRequest, assistantMessage, latestToolResult)
    || looksLikeCompletionToneWithPendingWork(assistantMessage)
    || looksLikeAssistantProposal(assistantMessage)
  ) {
    return true;
  }

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  return false;
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

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  if (looksLikeUserInputBlockingQuestion(assistantMessage)) {
    return false;
  }

  return !looksLikeCompletionReply(assistantMessage)
    || looksLikeFailureSummarizingCompletionReply(assistantMessage)
    || looksLikeStageSummaryWithPendingWork(assistantMessage)
    || looksLikeCompletionToneWithPendingWork(assistantMessage);
}

function shouldForceProjectInspectionContinuation(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeProjectInspectionRequest(originalRequest)) {
    return false;
  }

  if (latestToolResult.toolName === "shell") {
    if (!looksLikeProjectListingOutput(latestToolResult.summary, latestToolResult.rawOutput)) {
      return false;
    }

    return looksLikeBlockingQuestion(assistantMessage)
      || looksLikeStageSummaryWithPendingWork(assistantMessage)
      || looksLikeProgressOnlyAssistantReply(assistantMessage)
      || looksLikeCompletionToneWithPendingWork(assistantMessage)
      || looksLikeAssistantProposal(assistantMessage)
      || looksLikeThinCompletionReply(originalRequest, assistantMessage, latestToolResult);
  }

  if (latestToolResult.toolName !== "files") {
    return false;
  }

  if (looksLikeWholeProjectInspectionRequest(originalRequest)) {
    return false;
  }

  if (
    looksLikeBroadProjectImprovementRequest(originalRequest)
    || looksLikeProjectRewriteRequest(originalRequest)
  ) {
    return false;
  }

  const targetPath = extractPathFromToolSummary(latestToolResult.summary);

  if (!targetPath || !looksLikeProjectEntryPath(targetPath) || looksLikeEditableSourcePath(targetPath)) {
    return false;
  }

  return true;
}

function shouldForceWholeProjectInspectionContinuation(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeWholeProjectInspectionRequest(originalRequest)) {
    return false;
  }

  if (latestToolResult.toolName !== "files") {
    return false;
  }

  const targetPath = extractPathFromToolSummary(latestToolResult.summary);
  const shallowInspectionAnchor = Boolean(
    targetPath
    && (
      (looksLikeProjectEntryPath(targetPath) && !looksLikeEditableSourcePath(targetPath))
      || looksLikePrimaryProjectEntrySourcePath(targetPath)
    )
  );

  if (!shallowInspectionAnchor) {
    return false;
  }

  return true;
}

function shouldForceProjectWorkfileContinuation(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeBroadProjectImprovementRequest(originalRequest) && !looksLikeExecutableProjectRewriteRequest(originalRequest)) {
    return false;
  }

  if (latestToolResult.toolName !== "files") {
    return false;
  }

  const targetPath = extractPathFromToolSummary(latestToolResult.summary);

  if (!targetPath) {
    return false;
  }

  const likelyImprovementPath = deriveLikelyProjectImplementationPath(targetPath, latestToolResult.rawOutput);
  const shallowImprovementAnchor = (
    looksLikeProjectEntryPath(targetPath) && !looksLikeEditableSourcePath(targetPath)
  ) || Boolean(
    looksLikePrimaryProjectEntrySourcePath(targetPath)
    && likelyImprovementPath
    && likelyImprovementPath !== targetPath
  );

  if (!shallowImprovementAnchor) {
    return false;
  }

  return true;
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

  if (
    (latestToolResult.toolName === "edit" || latestToolResult.toolName === "write")
    && looksLikeCompletionReply(assistantMessage)
    && !looksLikeStageSummaryWithPendingWork(assistantMessage)
    && !looksLikeCompletionToneWithPendingWork(assistantMessage)
    && !looksLikeAssistantProposal(assistantMessage)
    && !looksLikeBlockingQuestion(assistantMessage)
    && !looksLikeVerificationRequest(originalRequest)
    && !looksLikeExactOutputRequest(originalRequest)
    && !looksLikeMultiTargetMutationTask(originalRequest)
  ) {
    return false;
  }

  if (!looksLikeExecutionTask(originalRequest) || isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (
    (latestToolResult.toolName === "edit" || latestToolResult.toolName === "write")
    && looksLikeMultiTargetMutationTask(originalRequest)
    && !looksLikeVerificationRequest(originalRequest)
    && !looksLikeExactOutputRequest(originalRequest)
  ) {
    return false;
  }

  if (looksLikeBlockingQuestion(assistantMessage)) {
    if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
      return false;
    }

    if (hasDirectExecutionCue(originalRequest)) {
      return true;
    }

    if (
      latestToolResult.toolName === "shell"
      && (
        looksLikeVerificationRequest(originalRequest)
        || looksLikeExactOutputRequest(originalRequest)
        || looksLikeMultiTargetMutationTask(originalRequest)
      )
    ) {
      return true;
    }

    return latestToolResult.toolName === "files"
      && Boolean(extractPathFromToolSummary(latestToolResult.summary));
  }

  if (isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  if (looksLikeStageSummaryWithPendingWork(assistantMessage)) {
    return true;
  }

  if (looksLikeCompletionToneWithPendingWork(assistantMessage)) {
    return true;
  }

  if (looksLikeLocalCompletionBeforeVerification(originalRequest, assistantMessage, latestToolResult)) {
    return true;
  }

  if (looksLikePathScopedCompletionForMultiTargetRequest(originalRequest, assistantMessage, latestToolResult)) {
    return true;
  }

  if (looksLikeAssistantProposal(assistantMessage)) {
    return true;
  }

  if (looksLikeProgressOnlyAssistantReply(assistantMessage)) {
    return true;
  }

  return !looksLikeCompletionReply(assistantMessage);
}

function shouldForceMultiTargetMutationContinuation(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeMultiTargetMutationTask(originalRequest)) {
    return false;
  }

  if (latestToolResult.toolName !== "edit" && latestToolResult.toolName !== "write") {
    return false;
  }

  if (looksLikeBlockingQuestion(assistantMessage)) {
    return true;
  }

  return looksLikeStageSummaryWithPendingWork(assistantMessage)
    || looksLikeCompletionToneWithPendingWork(assistantMessage)
    || looksLikeAssistantProposal(assistantMessage)
    || looksLikePathScopedCompletionForMultiTargetRequest(originalRequest, assistantMessage, latestToolResult);
}

function shouldForceCompletionTightening(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (isDirectShellExecutionRequest(originalRequest)) {
    return false;
  }

  if (!looksLikeLongRunningTask(originalRequest) && !looksLikeExecutionTask(originalRequest)) {
    return false;
  }

  if (hasSatisfiedWholeProjectInspectionAnchor(originalRequest, latestToolResult)) {
    return false;
  }

  const taskTerminal = isLatestToolResultTaskTerminal(originalRequest, latestToolResult);

  if (!taskTerminal) {
    if (looksLikeBlockingQuestion(assistantMessage)) {
      return false;
    }

    return !looksLikeProgressOnlyAssistantReply(assistantMessage);
  }

  if (looksLikeBlockingQuestion(assistantMessage)) {
    return true;
  }

  if (
    looksLikeExplicitFileExistenceQuestion(originalRequest)
    && latestToolResult.toolName === "files"
    && looksLikeFileExistenceCompletionReply(assistantMessage)
  ) {
    return false;
  }

  const isVerificationTerminalTool = latestToolResult.toolName === "shell" || latestToolResult.toolName === "files";

  if (!isVerificationTerminalTool) {
    return looksLikeBlockingQuestion(assistantMessage)
      || looksLikeThinCompletionReply(originalRequest, assistantMessage, latestToolResult);
  }

  return !looksLikeCompletionReply(assistantMessage)
    || looksLikeThinCompletionReply(originalRequest, assistantMessage, latestToolResult)
    || looksLikeMissingExactOutputAnchorCompletionReply(originalRequest, assistantMessage, latestToolResult)
    || looksLikeMissingFileVerificationAnchorCompletionReply(originalRequest, assistantMessage, latestToolResult)
    || looksLikeMissingShellVerificationAnchorCompletionReply(originalRequest, assistantMessage, latestToolResult)
    || looksLikeDistractedCompletionReply(originalRequest, assistantMessage, latestToolResult)
    || looksLikeFailureRecapCompletionReply(assistantMessage)
    || looksLikeProcessHeavyCompletionReply(assistantMessage);
}

function hasSatisfiedWholeProjectInspectionAnchor(originalRequest: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeWholeProjectInspectionRequest(originalRequest) || latestToolResult.toolName !== "files") {
    return false;
  }

  const latestPath = extractPathFromToolSummary(latestToolResult.summary);
  return Boolean(
    latestPath
    && looksLikeEditableSourcePath(latestPath)
    && !looksLikePrimaryProjectEntrySourcePath(latestPath)
  );
}

function shouldAutoFinalizeRepeatedTerminalAssistantReply(input: {
  originalRequest: string;
  assistantMessage: string;
  latestToolResult?: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  };
  repeatedAssistantMessageCount: number;
}) {
  if (!input.latestToolResult) {
    return false;
  }

  if (!isLatestToolResultTaskTerminal(input.originalRequest, input.latestToolResult)) {
    return false;
  }

  if (!input.assistantMessage.trim()) {
    return !looksLikeBlockingQuestion(input.assistantMessage);
  }

  if (input.repeatedAssistantMessageCount < 1) {
    return false;
  }

  if (
    looksLikeVerificationRequest(input.originalRequest)
    || extractExplicitFileTargets(input.originalRequest).length > 1
    || looksLikeBlockingQuestion(input.assistantMessage)
  ) {
    return false;
  }

  const latestPath = extractPathFromToolSummary(input.latestToolResult.summary);
  const normalizedMessage = input.assistantMessage.trim().toLowerCase();

  if (!latestPath || !normalizedMessage.includes(latestPath.toLowerCase())) {
    return false;
  }

  return /\b(updated?|updating|fixed?|created?|optimized?|improved?|refactored?|rewrote|changed?)\b/i.test(input.assistantMessage)
    || /(已更新|已修复|已创建|已优化|已改进|已重构|已重写|已修改|更新了|修好了|创建了|优化了|改进了|重构了|重写了|修改了)/u.test(input.assistantMessage);
}

function buildDirectTerminalCompletionAnswer(
  originalRequest: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  },
  preferredLanguage: PreferredReplyLanguage
) {
  const finalOutput = extractLastNonEmptyLine(latestToolResult.rawOutput);
  const latestPath = extractPathFromToolSummary(latestToolResult.summary);
  const requestedPaths = extractWritableTaskPaths(originalRequest);
  const primaryRequestedPath = requestedPaths.length > 0 && requestedPaths.length <= 2
    ? requestedPaths.at(-1)
    : undefined;
  const createIntent = /\b(create|write)\b/i.test(originalRequest) || /(创建|新建|写入)/u.test(originalRequest);
  const mutationAnchor = extractRequestedMutationAnchor(originalRequest);

  if (
    latestToolResult.toolName === "shell"
    && looksLikeExactOutputRequest(originalRequest)
    && finalOutput
  ) {
    if (primaryRequestedPath) {
      if (preferredLanguage === "zh") {
        return createIntent
          ? `已创建 ${primaryRequestedPath}，并验证其精确输出为 ${finalOutput}。`
          : `已完成 ${primaryRequestedPath}，并验证其精确输出为 ${finalOutput}。`;
      }

      return createIntent
        ? `Created ${primaryRequestedPath} and verified it prints exactly ${finalOutput}.`
        : `Completed ${primaryRequestedPath} and verified it prints exactly ${finalOutput}.`;
    }

    return preferredLanguage === "zh"
      ? `已完成，并重新运行验证命令，最终输出是 \`${finalOutput}\`。`
      : `Completed and reran the verification command; the final output was \`${finalOutput}\`.`;
  }

  if (
    latestToolResult.toolName === "shell"
    && looksLikeVerificationRequest(originalRequest)
    && finalOutput
  ) {
    return preferredLanguage === "zh"
      ? `已完成，并重新运行验证命令，最终输出是 \`${finalOutput}\`。`
      : `Completed and reran the verification command; the final output was \`${finalOutput}\`.`;
  }

  if (
    latestPath
    && (latestToolResult.toolName === "edit" || latestToolResult.toolName === "write" || latestToolResult.toolName === "files")
  ) {
    if (primaryRequestedPath && mutationAnchor) {
      return preferredLanguage === "zh"
        ? `已完成 \`${primaryRequestedPath}\`，现在已使用 \`${mutationAnchor}\`。`
        : `Completed ${primaryRequestedPath}; it now uses \`${mutationAnchor}\`.`;
    }

    return preferredLanguage === "zh"
      ? `已完成，已处理 \`${latestPath}\`。`
      : `Completed; updated \`${latestPath}\`.`;
  }

  return preferredLanguage === "zh"
    ? "已完成。"
    : "Completed.";
}

function extractRequestedMutationAnchor(originalRequest: string) {
  const taskContent = extractEmbeddedTaskContent(originalRequest);

  return taskContent.match(/\bprocess\.env\.[A-Za-z0-9_]+\b/)?.[0]
    ?? taskContent.match(/\bprints?\s+exactly\s+["'`]([^"'`\n]+)["'`]/i)?.[1]
    ?? taskContent.match(/\boutput\s+["'`]([^"'`\n]+)["'`]/i)?.[1]
    ?? taskContent.match(/输出\s*["'“”`]?([^"'“”`\n。！!？?]+)["'“”`]?/u)?.[1]?.trim()
    ?? taskContent.match(/改成输出\s*["'“”`]?([^"'“”`\n。！!？?]+)["'“”`]?/u)?.[1]?.trim()
    ?? taskContent.match(/\bmaxlength(?:\s*=|\s+)\d+\b/i)?.[0]?.replace(/\s*=\s*/g, "=");
}

function shouldTightenTerminalCompletionInsteadOfExtraTool(originalRequest: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!looksLikeLongRunningTask(originalRequest) && !looksLikeExecutionTask(originalRequest)) {
    return false;
  }

  if (
    latestToolResult.toolName === "shell"
    && looksLikeProjectListingOutput(latestToolResult.summary, latestToolResult.rawOutput)
    && (
      looksLikeProjectInspectionRequest(originalRequest)
      || looksLikeWholeProjectInspectionRequest(originalRequest)
      || looksLikeBroadProjectImprovementRequest(originalRequest)
      || looksLikeProjectRewriteRequest(originalRequest)
    )
  ) {
    return false;
  }

  if (
    (latestToolResult.toolName === "edit" || latestToolResult.toolName === "write")
    && !looksLikeVerificationRequest(originalRequest)
    && (
      looksLikeMultiTargetMutationTask(originalRequest)
      || looksLikeBroadProjectImprovementRequest(originalRequest)
    )
  ) {
    return false;
  }

  return isLatestToolResultTaskTerminal(originalRequest, latestToolResult);
}

function shouldDirectlyFinalizeTerminalResult(originalRequest: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (
    latestToolResult.toolName !== "shell"
    || isDirectShellExecutionRequest(originalRequest)
    || !looksLikeExactOutputRequest(originalRequest)
    || hasMutationIntent(originalRequest)
  ) {
    return false;
  }

  return shouldTightenTerminalCompletionInsteadOfExtraTool(originalRequest, latestToolResult);
}

function shouldForceFollowUpReplyTightening(originalRequest: string, assistantMessage: string, latestToolResult: {
  toolName: string;
  summary: string;
  rawOutput?: string;
  errorMessage?: string;
}) {
  if (!isSyntheticFollowUpRequest(originalRequest)) {
    return false;
  }

  if (looksLikeBlockingQuestion(assistantMessage)) {
    return true;
  }

  if (looksLikeLowValueAcknowledgementPrefix(assistantMessage)) {
    return true;
  }

  if (looksLikeThinCompletionReply(originalRequest, assistantMessage, latestToolResult)) {
    return true;
  }

  return false;
}

function shouldForceInitialTaskStart(originalRequest: string, assistantMessage: string) {
  if (!looksLikeActionableTaskRequest(originalRequest)) {
    return false;
  }

  if (
    requiresToolGroundedInitialExecution(originalRequest)
    && !looksLikeUserInputBlockingQuestion(assistantMessage)
  ) {
    return true;
  }

  const explicitTargets = extractExplicitFileTargets(originalRequest);

  if (
    explicitTargets.length > 0
    && looksLikeBlockingQuestion(assistantMessage)
    && !looksLikeUserInputBlockingQuestion(assistantMessage)
  ) {
    return true;
  }

  if (looksLikeAssistantProposal(assistantMessage) && !looksLikeBlockingQuestion(assistantMessage)) {
    return true;
  }

  if (looksLikeProgressOnlyAssistantReply(assistantMessage)) {
    return true;
  }

  return isSyntheticFollowUpRequest(originalRequest) && looksLikeBlockingQuestion(assistantMessage);
}

function shouldForceProposalNarrowing(originalRequest: string, assistantMessage: string) {
  if (!looksLikeNextStepProposalRequest(originalRequest)) {
    return false;
  }

  return looksLikeBroadProposalReply(assistantMessage);
}

function requiresToolGroundedInitialExecution(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || looksLikeNextStepProposalRequest(taskContent)) {
    return false;
  }

  if (isDirectShellExecutionRequest(taskContent)) {
    return true;
  }

  if (looksLikeWorkspaceInspectionQuestion(taskContent)) {
    return true;
  }

  if (looksLikeExplicitFileExistenceQuestion(taskContent)) {
    return true;
  }

  if (
    looksLikeVerificationRequest(taskContent)
    || looksLikeExactOutputRequest(taskContent)
    || looksLikeProjectInspectionRequest(taskContent)
    || looksLikeBroadProjectImprovementRequest(taskContent)
    || looksLikeExecutableProjectRewriteRequest(taskContent)
  ) {
    return true;
  }

  if (extractExplicitFileTargets(taskContent).length > 0) {
    return true;
  }

  if (hasMutationIntent(taskContent)) {
    return true;
  }

  return /\b(read|list|run|running)\b/i.test(taskContent)
    || /\bby running\b/i.test(taskContent)
    || /(读取|列出|运行)/u.test(taskContent);
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

function shouldAbortForRepeatedToolStall(input: {
  originalRequest: string;
  repeatedToolResultCount: number;
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  };
}) {
  if (input.repeatedToolResultCount < MAX_REPEATED_IDENTICAL_TOOL_RESULTS) {
    return false;
  }

  if (
    !looksLikeLongRunningTask(input.originalRequest)
    && !looksLikeExecutionTask(input.originalRequest)
    && !looksLikeProjectInspectionRequest(input.originalRequest)
  ) {
    return false;
  }

  if (isLatestToolResultTaskTerminal(input.originalRequest, input.latestToolResult)) {
    return false;
  }

  return true;
}

function buildRepeatedToolStallError(latestToolResult: {
  toolName: string;
  summary: string;
}) {
  const location = extractPathFromToolSummary(latestToolResult.summary)
    || extractShellCommandFromSummary(latestToolResult.summary)
    || latestToolResult.summary;

  return `Agent stalled after repeated identical ${latestToolResult.toolName} results${location ? ` (${location})` : ""}`;
}

function shouldAbortForRepeatedAssistantStall(input: {
  originalRequest: string;
  repeatedAssistantMessageCount: number;
  assistantMessage: string;
  latestToolResult?: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  };
}) {
  if (input.repeatedAssistantMessageCount < MAX_REPEATED_IDENTICAL_ASSISTANT_MESSAGES) {
    return false;
  }

  if (
    !looksLikeLongRunningTask(input.originalRequest)
    && !looksLikeExecutionTask(input.originalRequest)
    && !looksLikeProjectInspectionRequest(input.originalRequest)
  ) {
    return false;
  }

  if (looksLikeBlockingQuestion(input.assistantMessage)) {
    return false;
  }

  if (input.latestToolResult && isLatestToolResultTaskTerminal(input.originalRequest, input.latestToolResult)) {
    return false;
  }

  return true;
}

function buildRepeatedAssistantStallError(assistantMessage: string) {
  const normalized = assistantMessage.trim().replace(/\s+/g, " ");
  const preview = normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
  return `Agent stalled after repeated identical assistant replies${preview ? ` (${preview})` : ""}`;
}

function getAgentToolStepBudget(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent)) {
    return STANDARD_AGENT_TOOL_STEPS;
  }

  if (looksLikeBroadProjectImprovementRequest(taskContent) || looksLikeExecutableProjectRewriteRequest(taskContent)) {
    return PROJECT_AGENT_TOOL_STEPS;
  }

  if (
    looksLikeVerificationRequest(taskContent)
    || looksLikeExactOutputRequest(taskContent)
    || looksLikeMultiTargetMutationTask(taskContent)
  ) {
    return VERIFICATION_AGENT_TOOL_STEPS;
  }

  if (
    looksLikeExtendedCodingTask(taskContent)
    || looksLikeProjectInspectionRequest(taskContent)
    || looksLikeLongRunningTask(taskContent)
  ) {
    return EXTENDED_AGENT_TOOL_STEPS;
  }

  return STANDARD_AGENT_TOOL_STEPS;
}

function hasMutationIntent(content: string) {
  return /\b(create|write|edit|fix|repair|update|change|modify|improve|optimize|refactor|rewrite|rebuild)\b/i.test(content)
    || /(创建|写入|编辑|修复|更新|修改|优化|改进|重构|重写|重做|改成|改为|改下|改一下|换成|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)/u.test(content);
}

function looksLikeExtendedCodingTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  if (isDirectShellExecutionRequest(taskContent)) {
    return false;
  }

  if (
    !hasMutationIntent(taskContent)
    && looksLikeExactOutputRequest(taskContent)
    && /\b(inspect|read)\b/i.test(taskContent)
    && /\b(existing|current)\b/i.test(taskContent)
  ) {
    return true;
  }

  if (!hasMutationIntent(taskContent)) {
    return false;
  }

  if (looksLikeVerificationRequest(taskContent) || looksLikeExactOutputRequest(taskContent)) {
    return true;
  }

  return extractExplicitFileTargets(taskContent).length >= 3;
}

function looksLikeExecutionTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || looksLikeNextStepProposalRequest(taskContent)) {
    return false;
  }

  if (!hasMutationIntent(taskContent)) {
    return false;
  }

  return true;
}

function hasDirectExecutionCue(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  return /\b(do it directly|do the change directly|make the change directly|apply it directly|directly)\b/i.test(taskContent)
    || /(直接修改|直接改|直接做|直接处理|直接执行|不用先问|别先问)/u.test(taskContent);
}

function looksLikeActionableTaskRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  if (isDirectShellExecutionRequest(taskContent)) {
    return true;
  }

  if (looksLikeExplicitFileContentQuestion(taskContent)) {
    return true;
  }

  if (looksLikeExplicitFileExistenceQuestion(taskContent)) {
    return true;
  }

  if (looksLikeWorkspaceInspectionQuestion(taskContent)) {
    return true;
  }

  if (hasMutationIntent(taskContent)) {
    return true;
  }

  if (/\b(read|write|edit|fix|repair|create|inspect|run|running|verify|check|list|update|change|modify|improve|optimize|refactor)\b/i.test(taskContent)) {
    return true;
  }

  if (/\bby running\b/i.test(taskContent)) {
    return true;
  }

  if (/(读取|写入|编辑|修复|创建|检查|运行|验证|列出|修改|更新|优化|改进|重构|改成|改为|改下|改一下|换成|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)/u.test(taskContent)) {
    return true;
  }

  return false;
}

function looksLikeNextStepProposalRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (/^The user replied ".+" and wants you to execute the immediately previous (?:rewrite |optimize |inspect )?proposal now\./.test(taskContent)) {
    return false;
  }

  return /\b(next step|what.*improve next|what.*do next)\b/i.test(taskContent)
    || /(下一步|接下来.*做什么|想.*改进什么)/u.test(taskContent);
}

function looksLikeLongRunningTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeNextStepProposalRequest(taskContent)) {
    return false;
  }

  if (looksLikeExactOutputRequest(taskContent)) {
    return true;
  }

  if (/\b(verify|fix|repair|create|edit|update|change|inspect|improve|optimize|refactor|keep working|keep verifying)\b/i.test(taskContent)) {
    return true;
  }

  if (/(验证|修复|创建|编辑|修改|更新|检查|继续|保持|优化|改进|重构)/u.test(taskContent)) {
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

    const observedOutput = extractObservedShellOutput(latestToolResult.rawOutput);

    if (
      rawShellOutputContainsPendingVerificationState(latestToolResult.rawOutput)
      || (observedOutput && looksLikePendingVerificationShellOutput(observedOutput))
    ) {
      return false;
    }

    return /\bverify|run\b/i.test(originalRequest) || /(验证|运行)/u.test(originalRequest);
  }

  if ((latestToolResult.toolName === "write" || latestToolResult.toolName === "edit") && !looksLikeVerificationRequest(originalRequest)) {
    return true;
  }

  if (latestToolResult.toolName === "files") {
    if (
      looksLikeExplicitFileExistenceQuestion(originalRequest)
      && /ENOENT|no such file or directory/i.test(latestToolResult.errorMessage ?? latestToolResult.rawOutput ?? "")
    ) {
      return true;
    }

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

  const requestedPaths = extractWritableTaskPaths(originalRequest).map(normalizeApprovalPath);
  const normalizedPath = normalizeApprovalPath(path);

  if (!requestedPaths.includes(normalizedPath)) {
    return false;
  }

  const finalRequestedPath = requestedPaths.at(-1);

  if (requestedPaths.length > 1 && finalRequestedPath && normalizedPath !== finalRequestedPath) {
    return false;
  }

  if (looksLikeEditableSourcePath(path)) {
    return false;
  }

  return true;
}

function looksLikeVerificationRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const normalizedTask = stripPathLikeTokensForIntentDetection(taskContent);
  return /\b(verify|run|test|check|keep working|keep verifying)\b/i.test(normalizedTask)
    || /(验证|运行|测试|检查|继续(?:验证|检查|运行|测试))/u.test(taskContent);
}

function stripPathLikeTokensForIntentDetection(content: string) {
  return content.replace(
    /\b[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv)\b/g,
    " "
  );
}

function looksLikeDiscussionRequest(content: string) {
  const normalized = stripPathLikeTokensForIntentDetection(content);

  if (/\b(discuss|brainstorm|explain|why|architecture|tradeoff|plan|strategy|how would you|what would you do|tell me what you(?:'d| would) do)\b/i.test(normalized)) {
    return true;
  }

  return /(讨论|聊聊|为什么|架构|取舍|方案|计划|策略|先讨论|告诉我.*怎么做|会怎么做|你会怎么做)/u.test(normalized);
}

function looksLikeProjectInspectionRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  return looksLikeWholeProjectInspectionRequest(taskContent)
    || /\b(look at|inspect|review|check|explore)\s+(the\s+)?(project|repo|repository|codebase)\b/i.test(taskContent)
    || /(看看|检查|看下|瞅瞅).*(项目|仓库|代码)/u.test(taskContent)
    || /(项目|仓库|代码).*(看看|检查|看下|瞅瞅)/u.test(taskContent);
}

function looksLikeWholeProjectInspectionRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  return /\bwhole-project inspection\b/i.test(taskContent)
    || /\b(whole|entire|full)\s+(project|repo|repository|codebase)\b/i.test(taskContent)
    || /(整个|完整|全部).*(项目|仓库|代码)/u.test(taskContent)
    || /(项目|仓库|代码).*(整个|完整|全部)/u.test(taskContent);
}

function looksLikeBroadProjectImprovementRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || looksLikeNextStepProposalRequest(taskContent)) {
    return false;
  }

  if (!hasMutationIntent(taskContent)) {
    return false;
  }

  return looksLikeProjectInspectionRequest(taskContent)
    || /\b(project|repo|repository|codebase)\b/i.test(taskContent)
    || /(项目|仓库|代码)/u.test(taskContent);
}

function looksLikeProjectRewriteRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const hasRewriteIntent = /\b(rewrite|rebuild)\b/i.test(taskContent)
    || /(重写|重做)/u.test(taskContent);

  if (!hasRewriteIntent) {
    return false;
  }

  return /\b(project|repo|repository|codebase)\b/i.test(taskContent)
    || /(项目|仓库|代码)/u.test(taskContent);
}

function looksLikeExecutableProjectRewriteRequest(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  return looksLikeProjectRewriteRequest(taskContent)
    && !looksLikeDiscussionRequest(taskContent)
    && !looksLikeNextStepProposalRequest(taskContent);
}

function looksLikeMultiTargetMutationTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (!hasMutationIntent(taskContent)) {
    return false;
  }

  return extractExplicitRequestedMutationTargets(taskContent).length >= 2;
}

function looksLikeMultiTargetInspectionTask(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || hasMutationIntent(taskContent)) {
    return false;
  }

  return extractExplicitFileTargets(taskContent).length >= 3;
}

function looksLikeExplicitFileContentQuestion(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const targets = extractExplicitFileTargets(taskContent);

  if (targets.length === 0 || looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  return /\b(what(?:'s| is)?|show|tell me|contents?|inside|line\s+\d+|first line|second line|prints?)\b/i.test(taskContent)
    || /(内容|里面|写了什么|写了啥|第\s*\d+\s*行|第一行|第二行|是什么|是啥|输出什么|打印什么)/u.test(taskContent);
}

function looksLikeWorkspaceInspectionQuestion(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);

  if (looksLikeDiscussionRequest(taskContent) || extractExplicitFileTargets(taskContent).length > 0) {
    return false;
  }

  return /\b(current|working)\s+(directory|folder|workspace)\b/i.test(taskContent)
    || /\b(files?|entries?)\s+(in|under)\s+(the\s+)?(current|working)\s+(directory|folder|workspace)\b/i.test(taskContent)
    || /\bwhat(?:'s| is)\s+in\s+(the\s+)?(current|working)\s+(directory|folder|workspace)\b/i.test(taskContent)
    || /(当前|工作).*(目录|文件夹|工作区)/u.test(taskContent)
    || /(目录|文件夹|工作区).*(有哪些|有什么|内容|文件)/u.test(taskContent)
    || /(当前目录|当前文件夹|当前工作区).*(有哪些|有什么|内容|文件)/u.test(taskContent);
}

function looksLikeExplicitFileExistenceQuestion(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const targets = extractExplicitFileTargets(taskContent);

  if (targets.length === 0 || looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  return /\b(exists?|there)\b/i.test(taskContent)
    || /\b(is|are)\s+.+\s+there\b/i.test(taskContent)
    || /(在吗|存在吗|有没有|找得到吗|是否存在)/u.test(taskContent);
}

function extractExplicitFileTargets(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const pathMatches = taskContent.match(/[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv)/g) ?? [];
  return Array.from(new Set(pathMatches.map((path) => stripLineLocationSuffix(normalizePromptPath(path.trim())))));
}

function extractExplicitRequestedMutationTargets(content: string) {
  const taskContent = extractEmbeddedTaskContent(content);
  const pattern = /[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv)/g;
  const matches = [...taskContent.matchAll(pattern)];
  const targets: string[] = [];

  for (const match of matches) {
    const rawPath = match[0]?.trim();
    const index = match.index ?? -1;

    if (!rawPath || index < 0) {
      continue;
    }

    const path = stripLineLocationSuffix(normalizePromptPath(rawPath));
    const before = taskContent.slice(Math.max(0, index - 40), index);
    const after = taskContent.slice(index + rawPath.length, index + rawPath.length + 40);
    const localContext = `${before} ${after}`;
    const immediatePrefix = before.trimEnd().slice(-16);
    const immediateSuffix = after.trimStart().slice(0, 20);
    const hasMutationCue = /\b(fix|repair|edit|write|create|update|change|modify|rewrite|rebuild|optimize|improve|refactor|add|remove|rename|replace)\b/i.test(localContext)
      || /(修复|编辑|写入|创建|更新|修改|改成|改为|改掉|重写|重做|优化|改进|重构|新增|删除|替换|补上|加上|移除|调整|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)/u.test(localContext);
    const hasReadOnlyCue = /\b(read|inspect|review|check|look at|open|analyze)\b/i.test(localContext)
      || /(读取|读一下|读下|看看|看下|检查|查看|审一下|打开|分析)/u.test(localContext);
    const hasImmediateReadOnlyCue = /\b(read|inspect|review|check|look at|open|analyze)\s*$/i.test(immediatePrefix)
      || /(读取|读一下|读下|看看|看下|检查|查看|审一下|打开|分析)\s*$/u.test(immediatePrefix);
    const hasImmediateMutationCue = /\b(fix|repair|edit|write|create|update|change|modify|rewrite|rebuild|optimize|improve|refactor|add|remove|rename|replace)\s*$/i.test(immediatePrefix)
      || /^\s*(?:to\s+)?\b(fix|repair|edit|write|create|update|change|modify|rewrite|rebuild|optimize|improve|refactor|add|remove|rename|replace)\b/i.test(immediateSuffix)
      || /(修复|编辑|写入|创建|更新|修改|改成|改为|改掉|重写|重做|优化|改进|重构|新增|删除|替换|补上|加上|移除|调整|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)\s*$/u.test(immediatePrefix)
      || /^\s*(?:为|成|成了|一下|下)?\s*(修复|编辑|写入|创建|更新|修改|改成|改为|改掉|重写|重做|优化|改进|重构|新增|删除|替换|补上|加上|移除|调整|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)/u.test(immediateSuffix);

    if (hasImmediateReadOnlyCue && !hasImmediateMutationCue) {
      continue;
    }

    if (!hasMutationCue && hasReadOnlyCue) {
      continue;
    }

    if (!hasMutationCue && !looksLikeEditableSourcePath(path) && !looksLikeConfigurationSourcePath(path)) {
      continue;
    }

    if (!targets.includes(path)) {
      targets.push(path);
    }
  }

  return targets;
}

function isExplicitRequestedTargetPath(content: string, targetPath: string) {
  return extractExplicitRequestedMutationTargets(content).some((path) => pathsReferToSameTarget(path, targetPath));
}

function normalizeComparablePath(value: string) {
  return stripLineLocationSuffix(normalizePromptPath(value))
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function pathsReferToSameTarget(left: string, right: string) {
  const normalizedLeft = normalizeComparablePath(left).toLowerCase();
  const normalizedRight = normalizeComparablePath(right).toLowerCase();

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function extractLikelyNextTargetPathFromAssistantMessage(content: string) {
  if (
    !looksLikeStageSummaryWithPendingWork(content)
    && !looksLikeProgressOnlyAssistantReply(content)
    && !looksLikeCompletionToneWithPendingWork(content)
  ) {
    return undefined;
  }

  const targets = extractExplicitFileTargets(content);

  if (targets.length === 0) {
    return undefined;
  }

  return targets.at(-1);
}

function resolvePendingNextStepTargetFromAssistantStage(input: {
  assistantMessage: string;
  originalRequest?: string;
  latestTool?: {
    toolName?: string;
    toolSummary?: string;
    toolRawOutput?: string;
  };
}) {
  const explicitTarget = extractLikelyNextTargetPathFromAssistantMessage(input.assistantMessage);

  if (!explicitTarget) {
    return undefined;
  }

  const inferredTarget = inferPendingNextStepTargetFromRecentToolContext({
    explicitTarget,
    originalRequest: input.originalRequest,
    latestTool: input.latestTool
  });

  return inferredTarget ?? explicitTarget;
}

function inferPendingNextStepTargetFromRecentToolContext(input: {
  explicitTarget: string;
  originalRequest?: string;
  latestTool?: {
    toolName?: string;
    toolSummary?: string;
    toolRawOutput?: string;
  };
}) {
  if (!input.originalRequest || input.latestTool?.toolName !== "files" || !input.latestTool.toolSummary) {
    return undefined;
  }

  const latestPath = extractPathFromToolSummary(input.latestTool.toolSummary);

  if (!latestPath || !pathsReferToSameTarget(input.explicitTarget, latestPath)) {
    return undefined;
  }

  let inferredTarget: string | undefined;

  if (looksLikeWholeProjectInspectionRequest(input.originalRequest)) {
    inferredTarget = deriveLikelyWholeProjectInspectionPath(latestPath, input.latestTool.toolRawOutput);
  } else if (
    looksLikeBroadProjectImprovementRequest(input.originalRequest)
    || looksLikeExecutableProjectRewriteRequest(input.originalRequest)
  ) {
    inferredTarget = deriveLikelyProjectImplementationPath(latestPath, input.latestTool.toolRawOutput);
  } else if (looksLikeProjectInspectionRequest(input.originalRequest)) {
    inferredTarget = deriveLikelyProjectWorkfileFromEntryPath(latestPath, input.latestTool.toolRawOutput);
  }

  if (!inferredTarget || pathsReferToSameTarget(inferredTarget, input.explicitTarget)) {
    return undefined;
  }

  return inferredTarget;
}

function derivePendingNextTargetFromLatestToolContext(input: {
  originalRequest?: string;
  latestTool?: {
    toolName?: string;
    toolSummary?: string;
    toolRawOutput?: string;
  };
}) {
  if (!input.originalRequest || input.latestTool?.toolName !== "files" || !input.latestTool.toolSummary) {
    return undefined;
  }

  const latestPath = extractPathFromToolSummary(input.latestTool.toolSummary);

  if (!latestPath) {
    return undefined;
  }

  let inferredTarget: string | undefined;

  if (looksLikeWholeProjectInspectionRequest(input.originalRequest)) {
    inferredTarget = deriveLikelyWholeProjectInspectionPath(latestPath, input.latestTool.toolRawOutput);
  } else if (
    looksLikeBroadProjectImprovementRequest(input.originalRequest)
    || looksLikeExecutableProjectRewriteRequest(input.originalRequest)
  ) {
    inferredTarget = deriveLikelyProjectImplementationPath(latestPath, input.latestTool.toolRawOutput);
  } else if (looksLikeProjectInspectionRequest(input.originalRequest)) {
    inferredTarget = deriveLikelyProjectWorkfileFromEntryPath(latestPath, input.latestTool.toolRawOutput);
  }

  if (!inferredTarget || pathsReferToSameTarget(inferredTarget, latestPath)) {
    return undefined;
  }

  return inferredTarget;
}

function extractPendingTargetPathFromToolRequest(toolName: string, toolInput: unknown) {
  if ((toolName !== "files" && toolName !== "edit" && toolName !== "write") || !toolInput || typeof toolInput !== "object") {
    return undefined;
  }

  const candidatePath = "path" in toolInput && typeof toolInput.path === "string"
    ? normalizePromptPath(toolInput.path)
    : undefined;

  return candidatePath || undefined;
}

function extractPendingTargetPathFromContinuationPrompt(content: string) {
  const patterns = [
    /\bPending next step target:\s*([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))/i,
    /\bLikely target file:\s*([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))/i,
    /\bRecent editable working file:\s*([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))/i
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    const targetPath = match?.[1]?.trim();

    if (targetPath) {
      return normalizePromptPath(targetPath);
    }
  }

  return undefined;
}

function derivePendingTargetPathFromContinuationContext(input: {
  originalRequest: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  };
}) {
  const explicitMutationTargets = extractExplicitRequestedMutationTargets(input.originalRequest);
  const preferredExplicitTarget = [...explicitMutationTargets]
    .reverse()
    .find((path) => looksLikeEditableSourcePath(path))
    ?? explicitMutationTargets.at(-1);

  if (preferredExplicitTarget) {
    return normalizePromptPath(preferredExplicitTarget);
  }

  const explicitTargets = extractExplicitFileTargets(input.originalRequest);
  const preferredExplicitFile = [...explicitTargets]
    .reverse()
    .find((path) => looksLikeEditableSourcePath(path))
    ?? explicitTargets.at(-1);

  if (preferredExplicitFile) {
    return normalizePromptPath(preferredExplicitFile);
  }

  if (!input.previousToolResult) {
    return undefined;
  }

  if (input.previousToolResult.toolName === "shell") {
    const shellText = [
      input.previousToolResult.summary,
      input.previousToolResult.errorMessage,
      input.previousToolResult.rawOutput
    ].filter(Boolean).join("\n");
    return deriveLikelyTargetFileForShellFailure(input.previousToolResult.summary, shellText);
  }

  return extractPathFromToolSummary(input.previousToolResult.summary);
}

function buildStepLimitPendingCheckpointContent(input: {
  originalRequest: string;
  targetPath: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
  };
}) {
  const intro = looksLikeWholeProjectInspectionRequest(input.originalRequest)
    ? `I still need to continue the whole-project inspection by reading ${input.targetPath}.`
    : looksLikeBroadProjectImprovementRequest(input.originalRequest) || looksLikeExecutableProjectRewriteRequest(input.originalRequest)
      ? `I still need to continue this project task at ${input.targetPath}.`
      : `I still need to continue the task at ${input.targetPath}.`;
  const bridge = input.previousToolResult
    ? `The latest completed tool result was ${input.previousToolResult.summary}.`
    : "";

  return [intro, bridge, `The pending next step target is ${input.targetPath}.`]
    .filter(Boolean)
    .join(" ");
}

function buildStepLimitAutoContinuationPrompt(input: {
  originalRequest: string;
  targetPath: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
  };
}) {
  return [
    "The current task hit the per-slice tool budget but still has unfinished work.",
    "Continue the same task now instead of stopping or restarting from earlier completed steps.",
    "Do not ask the user to continue; keep working from the pending next step target until the original request is actually complete or truly blocked.",
    `Pending next step target: ${input.targetPath}`,
    input.previousToolResult ? `Latest tool in context: ${input.previousToolResult.toolName}` : "",
    input.previousToolResult ? `Latest tool summary in context: ${input.previousToolResult.summary}` : "",
    `Original task: ${input.originalRequest}`
  ].filter(Boolean).join("\n");
}

function buildAssistantPassLimitAutoContinuationPrompt(input: {
  originalRequest: string;
  targetPath: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
  };
}) {
  return [
    "The current task used up its assistant pass budget but still has unfinished work.",
    "Continue the same task now instead of stopping or repeating the same broad explanation loop.",
    "Do not ask the user to continue; move directly onto the pending next step target and keep working until the original request is actually complete or truly blocked.",
    `Pending next step target: ${input.targetPath}`,
    input.previousToolResult ? `Latest tool in context: ${input.previousToolResult.toolName}` : "",
    input.previousToolResult ? `Latest tool summary in context: ${input.previousToolResult.summary}` : "",
    `Original task: ${input.originalRequest}`
  ].filter(Boolean).join("\n");
}

function buildToolRecoveryAutoContinuationPrompt(input: {
  originalRequest: string;
  nextPrompt: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
  };
  recoveryKind: string;
}) {
  const targetPath = extractPendingTargetPathFromContinuationPrompt(input.nextPrompt)
    ?? derivePendingTargetPathFromContinuationContext({
      originalRequest: input.originalRequest,
      previousToolResult: input.previousToolResult
    });

  return [
    "The task hit repeated tool-recovery failures but the task context is still actionable.",
    `Latest recovery issue: ${input.recoveryKind}.`,
    "Continue the same task now instead of stopping or asking the user to continue.",
    "Do not repeat the same broken tool repair loop. Move directly onto the pending next step target and keep working until the original request is complete or truly blocked.",
    targetPath ? `Pending next step target: ${targetPath}` : "",
    input.previousToolResult ? `Latest tool in context: ${input.previousToolResult.toolName}` : "",
    input.previousToolResult ? `Latest tool summary in context: ${input.previousToolResult.summary}` : "",
    `Original task: ${input.originalRequest}`
  ].filter(Boolean).join("\n");
}

function buildRepeatedStallAutoContinuationPrompt(input: {
  originalRequest: string;
  nextPrompt: string;
  previousToolResult?: {
    toolName: string;
    summary: string;
  };
  stallKind: string;
}) {
  const targetPath = extractPendingTargetPathFromContinuationPrompt(input.nextPrompt)
    ?? derivePendingTargetPathFromContinuationContext({
      originalRequest: input.originalRequest,
      previousToolResult: input.previousToolResult
    });

  return [
    "The task stalled after repeated identical progress signals but the task context is still actionable.",
    `Latest stall kind: ${input.stallKind}.`,
    "Continue the same task now instead of stopping or asking the user to continue.",
    "Do not repeat the same stalled loop. Move directly onto the pending next step target and keep working until the original task is complete or truly blocked.",
    targetPath ? `Pending next step target: ${targetPath}` : "",
    input.previousToolResult ? `Latest tool in context: ${input.previousToolResult.toolName}` : "",
    input.previousToolResult ? `Latest tool summary in context: ${input.previousToolResult.summary}` : "",
    `Original task: ${input.originalRequest}`
  ].filter(Boolean).join("\n");
}

function shouldAutoContinueAfterStepLimit(
  originalRequest: string,
  targetPath: string
) {
  const taskContent = extractEmbeddedTaskContent(originalRequest);

  if (!targetPath || looksLikeDiscussionRequest(taskContent)) {
    return false;
  }

  return hasMutationIntent(taskContent)
    || looksLikeMultiTargetInspectionTask(taskContent)
    || looksLikeProjectInspectionRequest(taskContent)
    || looksLikeWholeProjectInspectionRequest(taskContent);
}

function shouldAutoContinueAfterToolRecovery(
  originalRequest: string,
  nextPrompt: string,
  previousToolResult?: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  const pendingTargetPath = extractPendingTargetPathFromContinuationPrompt(nextPrompt)
    ?? derivePendingTargetPathFromContinuationContext({
      originalRequest,
      previousToolResult
    });

  if (!pendingTargetPath) {
    return false;
  }

  return shouldAutoContinueAfterStepLimit(originalRequest, pendingTargetPath);
}

function shouldAutoContinueAfterRepeatedStall(
  originalRequest: string,
  nextPrompt: string,
  previousToolResult?: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  const pendingTargetPath = extractPendingTargetPathFromContinuationPrompt(nextPrompt)
    ?? derivePendingTargetPathFromContinuationContext({
      originalRequest,
      previousToolResult
    });

  if (!pendingTargetPath) {
    return false;
  }

  return shouldAutoContinueAfterStepLimit(originalRequest, pendingTargetPath);
}

function looksLikePathScopedCompletionForMultiTargetRequest(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (!looksLikeCompletionReply(content)) {
    return false;
  }

  const targets = extractExplicitRequestedMutationTargets(originalRequest);

  if (targets.length < 2) {
    return false;
  }

  const latestPath = extractPathFromToolSummary(latestToolResult.summary);
  const mentionedPaths = extractExplicitFileTargets(content);

  if (!latestPath || mentionedPaths.length === 0) {
    return false;
  }

  const matchedRequestedTargets = targets.filter((target) =>
    mentionedPaths.some((mentionedPath) => pathsReferToSameTarget(mentionedPath, target))
  );

  if (!matchedRequestedTargets.some((target) => pathsReferToSameTarget(target, latestPath))) {
    return false;
  }

  return matchedRequestedTargets.every((target) => pathsReferToSameTarget(target, latestPath));
}

function extractRemainingMultiTargetPathFromResult(
  originalRequest: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (
    (latestToolResult.toolName !== "edit" && latestToolResult.toolName !== "write")
    || !looksLikeMultiTargetMutationTask(originalRequest)
  ) {
    return undefined;
  }

  const latestPath = extractPathFromToolSummary(latestToolResult.summary);

  if (!latestPath) {
    return undefined;
  }

  const targets = extractExplicitRequestedMutationTargets(originalRequest);

  if (targets.length < 2) {
    return undefined;
  }

  const latestTargetIndex = targets.findIndex((target) => pathsReferToSameTarget(target, latestPath));

  if (latestTargetIndex === -1) {
    return undefined;
  }

  return targets.slice(latestTargetIndex + 1).find(Boolean);
}

function extractEmbeddedTaskContent(content: string) {
  const approvedProposalMatch = content.match(/\bApproved proposal:\s*([\s\S]+)$/i);

  if (approvedProposalMatch?.[1]?.trim()) {
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const approvedProposal = approvedProposalMatch[1].trim();

    if (/^The user replied ".+" and wants you to execute the immediately previous (?:rewrite |optimize |inspect )?proposal now\./.test(firstLine)) {
      const preservedIntentLine = /\bwhole-project inspection\b/i.test(content)
        ? "whole-project inspection"
        : "";
      return [firstLine, preservedIntentLine, approvedProposal].filter(Boolean).join("\n");
    }

    return approvedProposal;
  }

  const originalTaskMatch = content.match(/\bOriginal task:\s*([\s\S]+)$/i);

  if (originalTaskMatch?.[1]?.trim()) {
    return originalTaskMatch[1].trim();
  }

  const previousContextMatch = content.match(/\bPrevious context request:\s*([^\n]+)/i);

  if (previousContextMatch?.[1]?.trim()) {
    const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const previousContext = previousContextMatch[1].trim();

    if (/^The user replied ".+"/.test(firstLine)) {
      const recentEditableWorkingFileMatch = content.match(/\bRecent editable working file:\s*([A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv))/i);

      if (recentEditableWorkingFileMatch?.[1]?.trim()) {
        return `${firstLine}\n${stripLineLocationSuffix(normalizePromptPath(recentEditableWorkingFileMatch[1].trim()))}`;
      }

      const pathMatches = previousContext.match(/[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv)/g) ?? [];
      const normalizedPaths = Array.from(new Set(pathMatches.map((path) =>
        stripLineLocationSuffix(normalizePromptPath(path.trim()))
      )));

      if (normalizedPaths.length > 0) {
        return `${firstLine}\n${normalizedPaths.join("\n")}`;
      }

      return firstLine;
    }

    return previousContext;
  }

  return content;
}

function looksLikeBlockingQuestion(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  return /\?\s*$/.test(normalized)
    || /\b(do you want me to|should i|shall i|want me to|would you like me to)\b/i.test(normalized)
    || /(要不要我|要我.*吗|是否要我|需不需要我)/u.test(normalized)
    || /\b(can you|could you|please provide|which|what path|what file)\b/i.test(normalized)
    || /(能否|可以提供|请提供|哪个|什么路径|什么文件|需要你提供)/u.test(normalized);
}

function looksLikeUserInputBlockingQuestion(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  return /\b(can you|could you|please provide|which|what path|what file)\b/i.test(normalized)
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

  if (looksLikeAssistantProposal(normalized) && !looksLikeBlockingQuestion(normalized)) {
    return true;
  }

  if (/\b(done|completed|finished|verified|confirmed|exactly|updated|fixed|created|optimized|improved|refactored|rewrote|changed)\b/i.test(normalized)) {
    return false;
  }

  if (/(完成|已修复|已创建|已验证|已经|精确|确认|已更新|已优化|已改进|已重构|已重写|已修改)/u.test(normalized)) {
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

  return /\b(done|completed|finished|verified|confirmed|exactly|updated|fixed|created|optimized|improved|refactored|rewrote|changed)\b/i.test(normalized)
    || /(完成|已修复|已创建|已验证|已经|精确|确认|已更新|已优化|已改进|已重构|已重写|已修改)/u.test(normalized);
}

function looksLikeStageSummaryWithPendingWork(content: string) {
  const normalized = content.trim();

  if (!normalized || containsToolCallMarkup(normalized)) {
    return false;
  }

  const hasCompletedStep = /\b(created|updated|fixed|repaired|read|reviewed|inspected|found|verified|optimized|improved|refactored|rewrote|changed)\b/i.test(normalized)
    || /(已创建|已更新|已修复|修好了|读取了|已读|读了|已经读了|已回到|回到了|已经回到|回来了|看了|检查了|找到了|已验证|发现了|已优化|已改进|已重构|已重写|已修改|改成了|处理了|做完了)/u.test(normalized);
  const hasNextStepCue = /\b(next|then|will|going to|after that|before verifying|and verify)\b/i.test(normalized)
    || /(接下来|下一步|然后|还会|还要|再去|再做|并验证|再验证)/u.test(normalized);

  return hasCompletedStep && hasNextStepCue;
}

function looksLikeCompletionToneWithPendingWork(content: string) {
  const normalized = content.trim();

  if (!normalized || containsToolCallMarkup(normalized) || !looksLikeCompletionReply(normalized)) {
    return false;
  }

  return /\b(still needs?|still need to|still requires?|remaining|rest of the|cannot finish until|cannot succeed until|before verification can succeed|before it can succeed|before rerunning|before verifying|one more|another file still)\b/i.test(normalized)
    || /(还需要|仍需|还要|还得|剩下|余下|还不能|在验证成功之前|在重新运行之前|还需修|还没法完成)/u.test(normalized);
}

function looksLikeFailureSummarizingCompletionReply(content: string) {
  const normalized = content.trim();

  if (!normalized || containsToolCallMarkup(normalized) || !looksLikeCompletionReply(normalized)) {
    return false;
  }

  const hasFailureCue = /\b(failed|failure|error|broken|crash|exception|exit code|module not found|still failing)\b/i.test(normalized)
    || /(失败|错误|报错|坏了|崩溃|异常|退出码|找不到模块|仍然失败)/u.test(normalized);
  const hasRecoveryCue = /\b(repair|fix|continue|retry|rerun|latest failure point|remaining issue)\b/i.test(normalized)
    || /(修复|继续|重试|重新运行|最新失败点|剩余问题)/u.test(normalized);

  return hasFailureCue && hasRecoveryCue;
}

function looksLikeLocalCompletionBeforeVerification(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (
    !looksLikeCompletionReply(content)
    || (!looksLikeVerificationRequest(originalRequest) && !looksLikeExactOutputRequest(originalRequest))
    || (latestToolResult.toolName !== "edit" && latestToolResult.toolName !== "write" && latestToolResult.toolName !== "files")
  ) {
    return false;
  }

  const latestPath = extractPathFromToolSummary(latestToolResult.summary);

  if (!latestPath) {
    return false;
  }

  if (latestToolResult.toolName === "files" && isFilesVerificationTerminal(originalRequest, latestToolResult.summary)) {
    return false;
  }

  const normalized = content.toLowerCase();
  const expectedOutput = extractExpectedExactOutput(originalRequest)?.toLowerCase();
  const verificationCommand = extractVerificationCommandFromTaskRequest(originalRequest)?.toLowerCase();

  if (expectedOutput && normalized.includes(expectedOutput)) {
    return false;
  }

  if (verificationCommand && normalized.includes(verificationCommand)) {
    return false;
  }

  if (normalized.includes(latestPath.toLowerCase())) {
    return true;
  }

  return (latestToolResult.toolName === "edit" || latestToolResult.toolName === "write")
    && normalized.length <= 160
    && !looksLikeStageSummaryWithPendingWork(content)
    && !looksLikeCompletionToneWithPendingWork(content)
    && !looksLikeAssistantProposal(content)
    && !looksLikeBlockingQuestion(content);
}

function looksLikeThinCompletionReply(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  const normalized = content.trim();

  if (!normalized) {
    return true;
  }

  if (looksLikeLowValueAcknowledgementPrefix(normalized)) {
    return true;
  }

  if (
    looksLikeExplicitFileExistenceQuestion(originalRequest)
    && latestToolResult.toolName === "files"
    && looksLikeFileExistenceCompletionReply(normalized)
  ) {
    return false;
  }

  const anchors = [
    extractPathFromToolSummary(latestToolResult.summary),
    extractExpectedExactOutput(originalRequest),
    extractObservedShellOutput(latestToolResult.rawOutput),
    extractShellCommandFromSummary(latestToolResult.summary)
  ].filter(Boolean) as string[];

  const hasAnchor = anchors.some((anchor) => normalized.toLowerCase().includes(anchor.toLowerCase()));

  if (isSyntheticFollowUpRequest(originalRequest) && normalized.length < 90) {
    return !hasAnchor;
  }

  if (normalized.length >= 60) {
    return false;
  }

  return !hasAnchor;
}

function looksLikeMissingExactOutputAnchorCompletionReply(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (!looksLikeExactOutputRequest(originalRequest)) {
    return false;
  }

  if (latestToolResult.toolName !== "shell" || !isLatestToolResultTaskTerminal(originalRequest, latestToolResult)) {
    return false;
  }

  if (!looksLikeCompletionReply(content)) {
    return false;
  }

  const expectedOutput = extractExpectedExactOutput(originalRequest);
  const observedOutput = extractObservedShellOutput(latestToolResult.rawOutput);

  if (!expectedOutput || !observedOutput || expectedOutput !== observedOutput) {
    return false;
  }

  const normalized = content.toLowerCase();
  return !normalized.includes(expectedOutput.toLowerCase());
}

function looksLikeMissingFileVerificationAnchorCompletionReply(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (latestToolResult.toolName !== "files" || !isFilesVerificationTerminal(originalRequest, latestToolResult.summary)) {
    return false;
  }

  if (!looksLikeCompletionReply(content)) {
    return false;
  }

  const targetPath = extractPathFromToolSummary(latestToolResult.summary);

  if (!targetPath) {
    return false;
  }

  const mentionedPaths = extractExplicitFileTargets(content);
  return !mentionedPaths.some((mentionedPath) => pathsReferToSameTarget(mentionedPath, targetPath));
}

function looksLikeFileExistenceCompletionReply(content: string) {
  const normalized = content.trim();

  if (!normalized || looksLikeBlockingQuestion(normalized)) {
    return false;
  }

  return /\bdoes not exist\b/i.test(normalized)
    || /\bexists?\b/i.test(normalized)
    || /(不存在|不在|存在|在的|在呢)/u.test(normalized);
}

function looksLikeMissingShellVerificationAnchorCompletionReply(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  if (
    latestToolResult.toolName !== "shell"
    || !isLatestToolResultTaskTerminal(originalRequest, latestToolResult)
    || !looksLikeVerificationRequest(originalRequest)
    || looksLikeExactOutputRequest(originalRequest)
  ) {
    return false;
  }

  if (!looksLikeCompletionReply(content)) {
    return false;
  }

  const normalized = content.toLowerCase();
  const observedOutput = extractObservedShellOutput(latestToolResult.rawOutput);

  if (observedOutput && normalized.includes(observedOutput.toLowerCase())) {
    return false;
  }

  const command = extractShellCommandFromSummary(latestToolResult.summary);

  if (!command) {
    return false;
  }

  if (normalized.includes(command.toLowerCase())) {
    return false;
  }

  const targetPath = extractPrimaryPathFromShellCommand(command);

  if (targetPath && normalized.includes(targetPath.toLowerCase())) {
    return false;
  }

  return true;
}

function looksLikeProcessHeavyCompletionReply(content: string) {
  const normalized = content.trim();

  if (normalized.length < 160) {
    return false;
  }

  const processMarkers = [
    /\b(first|then|after that|earlier|previously|before that|at first)\b/i,
    /\b(failed|failure|wrong|mismatch|broken|import path)\b/i,
    /(先|然后|之前|一开始|前面|失败|报错|错误|不匹配|导入路径)/u
  ];
  const matchedMarkers = processMarkers.filter((pattern) => pattern.test(normalized)).length;
  const sentenceCount = normalized.split(/[.!?。！？]+/u).map((part) => part.trim()).filter(Boolean).length;

  return matchedMarkers >= 2 && sentenceCount >= 2;
}

function looksLikeFailureRecapCompletionReply(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.length >= 160) {
    return false;
  }

  const hasFailureRecapCue = /\b(earlier|previously|before|at first)\b/i.test(normalized)
    || /(之前|前面|一开始)/u.test(normalized);
  const hasFailureMarker = /\b(failed|failure|wrong|broken|mismatch|used a dash|used the old)\b/i.test(normalized)
    || /(失败|错误|坏了|不匹配|用了横杠|旧格式)/u.test(normalized);
  const hasCompletionAnchor = /\b(done|completed|finished|verified|confirmed|exactly|updated|fixed|created)\b/i.test(normalized)
    || /(完成|已修复|已创建|已验证|已经|精确|确认|已更新)/u.test(normalized);

  return hasFailureRecapCue && hasFailureMarker && hasCompletionAnchor;
}

function looksLikeDistractedCompletionReply(
  originalRequest: string,
  content: string,
  latestToolResult: {
    toolName: string;
    summary: string;
    rawOutput?: string;
    errorMessage?: string;
  }
) {
  const targets = extractExplicitFileTargets(originalRequest);

  if (targets.length < 1) {
    return false;
  }

  const mentionedPaths = extractExplicitFileTargets(content);

  if (mentionedPaths.length < 2) {
    return false;
  }

  const allowedTargets = new Set<string>(targets);
  const latestPath = extractPathFromToolSummary(latestToolResult.summary);

  if (latestPath) {
    allowedTargets.add(latestPath);
  }

  return mentionedPaths.some((path) =>
    !Array.from(allowedTargets).some((allowedTarget) => pathsReferToSameTarget(path, allowedTarget))
  );
}

function renderAssistantToolCallForPrompt(toolCall: ParsedAssistantToolCall) {
  return `${TOOL_CALL_OPEN}\n${JSON.stringify(toolCall)}\n${TOOL_CALL_CLOSE}`;
}

function isSyntheticFollowUpRequest(content: string) {
  return /^The user replied ".+" (?:and wants to continue the most recent unfinished task\.|to approve the immediately previous proposal\.)/i.test(content.trim());
}

function sanitizeAssistantMessageForRuntime(originalRequest: string, content: string) {
  if (!content.trim()) {
    return content;
  }

  if (!looksLikeActionableTaskRequest(originalRequest) && !isSyntheticFollowUpRequest(originalRequest)) {
    return content;
  }

  const stripped = stripLowValueAcknowledgementPrefix(content);

  if (stripped === content) {
    return content;
  }

  return /[\p{L}\p{N}\p{Script=Han}]/u.test(stripped) ? stripped : content;
}

function stripLowValueAcknowledgementPrefix(content: string) {
  const leadingWhitespace = content.match(/^\s*/u)?.[0] ?? "";
  const trimmedStart = content.slice(leadingWhitespace.length);
  const stripped = trimmedStart.replace(/^(?:(?:可以继续吗|可以继续|可以了|可以|已继续|继续了|好的|好|行|没问题|sure|okay|ok)\b[\s,，。!！:：-]*)+/iu, "");
  return stripped === trimmedStart ? content : `${leadingWhitespace}${stripped}`;
}

function createAssistantStageSignature(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized || undefined;
}

function createAssistantLoopSignature(content: string) {
  if (looksLikeFailureSummarizingCompletionReply(content)) {
    return "__failure-summary__";
  }

  if (looksLikeStageSummaryWithPendingWork(content)) {
    return "__stage-summary__";
  }

  if (looksLikeCompletionToneWithPendingWork(content)) {
    return "__completion-pending__";
  }

  if (looksLikeAssistantProposal(content)) {
    return "__proposal__";
  }

  if (looksLikeProgressOnlyAssistantReply(content)) {
    return "__progress__";
  }

  const normalized = stripLowValueAcknowledgementPrefix(content)
    .replace(/`[^`]+`/g, "`<code>`")
    .replace(/"[^"\n]{1,120}"/g, "\"<quote>\"")
    .replace(/'[^'\n]{1,120}'/g, "'<quote>'")
    .replace(/\b[A-Za-z0-9_./-]+\.(?:tsx|json|mjs|cjs|ejs|html|css|js|ts|txt|md|csv)\b/g, "<path>")
    .replace(/\bnode\s+[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts)\b/gi, "node <path>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return normalized || undefined;
}

function looksLikeLowValueAcknowledgementPrefix(content: string) {
  return stripLowValueAcknowledgementPrefix(content) !== content;
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

  const prefixedMatch = trimmed.match(/^(运行|执行|run|跑下|跑一下|试下|试一下|跑|试)\s+(.+)$/i);

  if (prefixedMatch) {
    const rawCommand = prefixedMatch[2] ?? "";
    const normalizedCommand = rawCommand.replace(/\s*(看看|看下|看一下|试试)\s*$/u, "");
    return looksLikeStandaloneShellCommand(normalizedCommand);
  }

  return looksLikeStandaloneShellCommand(trimmed);
}

function looksLikeStandaloneShellCommand(content: string) {
  const trimmed = content.trim();

  if (!trimmed) {
    return false;
  }

  if (/^[A-Z][A-Za-z0-9_-]*(?:\s|$)/.test(trimmed)) {
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
    input: normalizeParsedToolInput(parsed.tool.trim(), derivedInput)
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
    const command = extractLooseQuotedField(content, "command") ?? extractLooseQuotedField(content, "cmd");

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

  if (toolName === "files" || toolName === "edit" || toolName === "write") {
    const path = extractLooseQuotedField(content, "path");

    if (!path) {
      return undefined;
    }

    const input: Record<string, unknown> = { path };
    const startLine = extractLooseNumericField(content, "startLine");
    const endLine = extractLooseNumericField(content, "endLine");
    const maxBytes = extractLooseNumericField(content, "maxBytes");
    const replacement = extractLooseQuotedField(content, "replacement");
    const fileContent = extractLooseQuotedField(content, "content");

    if (typeof startLine === "number") {
      input.startLine = startLine;
    }

    if (typeof endLine === "number") {
      input.endLine = endLine;
    }

    if (typeof maxBytes === "number") {
      input.maxBytes = maxBytes;
    }

    if (typeof replacement === "string") {
      input.replacement = replacement;
    }

    if (typeof fileContent === "string") {
      input.content = fileContent;
    }

    return {
      tool: toolName,
      input
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

function extractLooseNumericField(content: string, fieldName: string) {
  const escapedField = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`"${escapedField}"\\s*:\\s*"?(-?\\d+)"?`, "i"));

  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeParsedToolInput(toolName: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const record = { ...(input as Record<string, unknown>) };
  normalizeFileStyleToolAliases(toolName, record);

  if (toolName === "files" || toolName === "edit") {
    coerceKnownNumericField(record, "startLine");
    coerceKnownNumericField(record, "endLine");
  }

  if (toolName === "files") {
    coerceKnownNumericField(record, "maxBytes");
  }

  normalizeFileStylePathRange(record);

  return record;
}

function coerceKnownNumericField(record: Record<string, unknown>, fieldName: string) {
  const value = record[fieldName];

  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    return;
  }

  const parsed = Number.parseInt(value.trim(), 10);

  if (Number.isFinite(parsed)) {
    record[fieldName] = parsed;
  }
}

function normalizeFileStyleToolAliases(toolName: string, record: Record<string, unknown>) {
  if (toolName === "shell") {
    moveAliasField(record, "cmd", "command");
    return;
  }

  if (toolName !== "files" && toolName !== "edit" && toolName !== "write") {
    return;
  }

  moveAliasField(record, "start", "startLine");
  moveAliasField(record, "end", "endLine");
  moveAliasField(record, "max_bytes", "maxBytes");
}

function moveAliasField(record: Record<string, unknown>, from: string, to: string) {
  if (!(from in record) || to in record) {
    return;
  }

  record[to] = record[from];
}

function normalizeFileStylePathRange(record: Record<string, unknown>) {
  if (typeof record.path !== "string" || "startLine" in record || "endLine" in record) {
    return;
  }

  const match = record.path.match(/^(.*?):(\d+)(?:-(\d+))?$/);

  if (!match) {
    return;
  }

  record.path = match[1];
  record.startLine = Number.parseInt(match[2], 10);
  record.endLine = Number.parseInt(match[3] ?? match[2], 10);
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
