import type { ProviderContextMessage } from "../providers/base.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import { extractExpectedOutputFromTaskRequest } from "./task-intent.js";

export interface SessionTimelineEntry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  searchText: string;
  toolName?: string;
  toolSummary?: string;
  toolRawOutput?: string;
}

const RECENT_USER_TURN_WINDOW = 3;
const SUMMARY_ENTRY_WINDOW = 6;
const RECENT_TOOL_NOTE_WINDOW = 4;
const MAX_CONTEXT_MESSAGE_CHARS = 1200;
const MAX_SUMMARY_CHARS = 1400;
const MAX_TOOL_NOTE_CHARS = 220;
const MAX_RECENT_USER_CHARS = 1400;
const MAX_RECENT_ASSISTANT_CHARS = 1200;

export function projectSessionTimeline(events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>) {
  const entries: SessionTimelineEntry[] = [];
  let assistantEntryOpen = false;
  let assistantTaskId: string | undefined;

  for (const item of events) {
    if (item.type === "user.message.submitted") {
      const content = item.payload.content.trim();
      assistantEntryOpen = false;
      assistantTaskId = undefined;

      if (!content || content.startsWith("/")) {
        continue;
      }

      entries.push({
        kind: "user",
        text: normalizePreviewText(content),
        searchText: normalizeSearchText(content)
      });
      continue;
    }

    if (item.type === "assistant.delta.received") {
      const last = entries.at(-1);

      if (assistantEntryOpen && last?.kind === "assistant" && assistantTaskId === item.taskId) {
        last.text = `${last.text}${item.payload.delta}`;
        last.searchText = normalizeSearchText(last.text);
      } else {
        entries.push({
          kind: "assistant",
          text: item.payload.delta,
          searchText: normalizeSearchText(item.payload.delta)
        });
      }

      assistantEntryOpen = true;
      assistantTaskId = item.taskId;
      continue;
    }

    if (item.type === "assistant.completed") {
      assistantEntryOpen = false;
      assistantTaskId = undefined;
      continue;
    }

    if (item.type === "assistant.checkpoint.recorded") {
      assistantEntryOpen = false;
      assistantTaskId = undefined;
      continue;
    }

    if (item.type === "tool.execution.completed") {
      assistantEntryOpen = false;
      assistantTaskId = undefined;
      const summary = normalizePreviewText(item.payload.summary || `${item.payload.toolName} completed`);

      entries.push({
        kind: "tool",
        text: `${item.payload.toolName}: ${summary}`,
        searchText: normalizeSearchText(summary),
        toolName: item.payload.toolName,
        toolSummary: summary,
        toolRawOutput: item.payload.rawOutput
      });
      continue;
    }

    if (item.type === "runtime.error.raised") {
      assistantEntryOpen = false;
      assistantTaskId = undefined;
      entries.push({
        kind: "error",
        text: normalizePreviewText(item.payload.message),
        searchText: normalizeSearchText(item.payload.message)
      });
    }
  }

  return entries;
}

export function renderTimelineEntry(entry: SessionTimelineEntry) {
  if (entry.kind === "user") {
    return `> ${createInlinePreview(entry.text)}`;
  }

  if (entry.kind === "assistant") {
    return `• ${createInlinePreview(entry.text, 120)}`;
  }

  if (entry.kind === "tool") {
    return `tool ${createInlinePreview(entry.text, 120)}`;
  }

  return `error: ${createInlinePreview(entry.text, 120)}`;
}

export function normalizePreviewText(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

export function normalizeSearchText(content: string) {
  return normalizePreviewText(content).toLowerCase();
}

export function createInlinePreview(content: string, maxLength = 80) {
  const trimmed = normalizePreviewText(content);

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildContextMessages(events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>): ProviderContextMessage[] {
  const timeline = projectSessionTimeline(events);

  if (timeline.length === 0) {
    return [];
  }

  const recentBoundaryIndex = findRecentBoundaryIndex(timeline);
  const recentEntries = timeline.slice(recentBoundaryIndex);
  const earlierEntries = timeline.slice(0, recentBoundaryIndex);
  const messages: ProviderContextMessage[] = [];
  const summary = clipForContext(summarizeTimelineEntries(earlierEntries), MAX_SUMMARY_CHARS);
  const recentNotes = recentEntries
    .filter((entry) => entry.kind === "tool" || entry.kind === "error")
    .slice(-RECENT_TOOL_NOTE_WINDOW)
    .map((entry) => `- ${entry.kind}: ${createInlinePreview(entry.text, MAX_TOOL_NOTE_CHARS)}`);
  const recentCodingNotes = buildRecentCodingNotes(recentEntries);
  const latestUserRequest = [...recentEntries].reverse().find((entry) => entry.kind === "user")?.text;
  const taskAnchorRequest = latestUserRequest
    ? resolveTaskAnchorRequest(latestUserRequest, timeline)
    : undefined;
  const requestedVerificationCommand = taskAnchorRequest ? extractVerificationCommandFromRequest(taskAnchorRequest) : undefined;
  const requestedPaths = taskAnchorRequest ? extractTaskRelevantPaths(taskAnchorRequest, requestedVerificationCommand) : [];
  const recentRepairSummary = buildRecentRepairSummary(recentEntries, requestedPaths, requestedVerificationCommand);
  const recentTaskState = buildRecentTaskState(recentEntries, events, timeline);

  if (summary) {
    messages.push({
      role: "system",
      content: clipForContext(`Earlier session summary:\n${summary}`, MAX_CONTEXT_MESSAGE_CHARS)
    });
  }

  if (recentNotes.length > 0) {
    messages.push({
      role: "system",
      content: clipForContext(`Recent session notes:\n${recentNotes.join("\n")}`, MAX_CONTEXT_MESSAGE_CHARS)
    });
  }

  if (recentCodingNotes.length > 0) {
    messages.push({
      role: "system",
      content: clipForContext(`Recent coding notes:\n${recentCodingNotes.join("\n")}`, MAX_CONTEXT_MESSAGE_CHARS)
    });
  }

  if (recentRepairSummary.length > 0) {
    messages.push({
      role: "system",
      content: clipForContext(`Recent repair thread:\n${recentRepairSummary.join("\n")}`, MAX_CONTEXT_MESSAGE_CHARS)
    });
  }

  if (recentTaskState.length > 0) {
    messages.push({
      role: "system",
      content: clipForContext(`Recent task state:\n${recentTaskState.join("\n")}`, MAX_CONTEXT_MESSAGE_CHARS)
    });
  }

  for (const entry of recentEntries) {
    if (entry.kind === "user") {
      messages.push({
        role: "user",
        content: clipForContext(entry.text, MAX_RECENT_USER_CHARS)
      });
      continue;
    }

    if (entry.kind === "assistant") {
      messages.push({
        role: "assistant",
        content: clipForContext(entry.text, MAX_RECENT_ASSISTANT_CHARS)
      });
    }
  }

  return messages;
}

export function summarizeTimelineEntries(entries: SessionTimelineEntry[]) {
  if (entries.length === 0) {
    return "";
  }

  const recentSummaryEntries = entries.slice(-SUMMARY_ENTRY_WINDOW);
  const userCount = entries.filter((entry) => entry.kind === "user").length;
  const assistantCount = entries.filter((entry) => entry.kind === "assistant").length;
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  const errorCount = entries.filter((entry) => entry.kind === "error").length;
  const lines = [
    `Earlier items: ${entries.length}`,
    userCount > 0 ? `User turns: ${userCount}` : "",
    assistantCount > 0 ? `Assistant turns: ${assistantCount}` : "",
    toolCount > 0 ? `Tool results: ${toolCount}` : "",
    errorCount > 0 ? `Errors: ${errorCount}` : "",
    ...recentSummaryEntries.map((entry) => {
      const prefix = entry.kind === "user"
        ? "User"
        : entry.kind === "assistant"
          ? "Assistant"
          : entry.kind === "tool"
            ? "Tool"
            : "Error";
      return `- ${prefix}: ${createInlinePreview(entry.text, 140)}`;
    })
  ].filter(Boolean);

  return clipForContext(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function findRecentBoundaryIndex(entries: SessionTimelineEntry[]) {
  const userIndexes = entries.flatMap((entry, index) =>
    entry.kind === "user"
      ? [index]
      : []
  );

  if (userIndexes.length <= RECENT_USER_TURN_WINDOW) {
    return 0;
  }

  return userIndexes.at(-RECENT_USER_TURN_WINDOW) ?? 0;
}

function clipForContext(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars - 3).trimEnd()}...`;
}

function buildRecentCodingNotes(entries: SessionTimelineEntry[]) {
  const notes: string[] = [];

  for (const entry of entries) {
    if (entry.kind !== "tool" || !entry.toolName || !entry.toolSummary) {
      continue;
    }

    const note = summarizeCodingToolEntry(entry.toolName, entry.toolSummary);

    if (note) {
      notes.push(note);
    }
  }

  return dedupeNotes(notes).slice(-4).map((note) => `- ${note}`);
}

function summarizeCodingToolEntry(toolName: string, summary: string) {
  if (toolName === "files") {
    const path = extractPathFromToolSummary(summary);
    return path ? `Read ${path}` : undefined;
  }

  if (toolName === "edit") {
    const path = extractPathFromToolSummary(summary);
    return path ? `Updated ${path}` : undefined;
  }

  if (toolName === "write") {
    const path = extractPathFromToolSummary(summary);
    return path ? `Created ${path}` : undefined;
  }

  if (toolName === "shell") {
    const command = extractCommandFromShellSummary(summary);

    if (command?.startsWith("node ")) {
      return `Verified with ${command}`;
    }

    return undefined;
  }

  return undefined;
}

function extractPathFromToolSummary(summary: string) {
  const match = summary.match(/^(.+?)(?::\d+(?:-\d+)?)?(?:\s+·\s+.+)?$/);
  return match?.[1]?.trim();
}

function extractCommandFromShellSummary(summary: string) {
  const match = summary.match(/^(.+?)\s+·\s+(?:completed|failed(?:\s*\(\d+\))?|timed out|cancelled|running)\b/i);
  return match?.[1]?.trim();
}

function dedupeNotes(notes: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const note of notes) {
    const normalized = note.trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function buildRecentRepairSummary(
  entries: SessionTimelineEntry[],
  requestedPaths: string[] = [],
  requestedVerificationCommand?: string
) {
  let lastFailedShell: string | undefined;
  let lastFailureReason: string | undefined;
  let lastReadPath: string | undefined;
  let lastChangedFile: string | undefined;
  let lastVerificationCommand: string | undefined;
  let lastObservedOutput: string | undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry.kind !== "tool" || !entry.toolName || !entry.toolSummary) {
      continue;
    }

    if (!lastVerificationCommand && entry.toolName === "shell") {
      const command = extractCommandFromShellSummary(entry.toolSummary);

      if (command?.startsWith("node ") && isTaskRelevantShellCommand(command, requestedPaths, requestedVerificationCommand)) {
        lastVerificationCommand = command;
        lastObservedOutput = extractObservedToolOutput(entry.toolRawOutput);
      }
    }

    if (
      !lastFailedShell
      && entry.toolName === "shell"
      && /\bfailed\b|\btimed out\b|\bcancelled\b/i.test(entry.toolSummary)
    ) {
      const command = extractCommandFromShellSummary(entry.toolSummary);

      if (!command || isTaskRelevantShellCommand(command, requestedPaths, requestedVerificationCommand)) {
        lastFailedShell = entry.toolSummary;
        lastFailureReason = extractFailureReason(entry.toolRawOutput);
      }
    }

    if (!lastChangedFile && (entry.toolName === "edit" || entry.toolName === "write")) {
      const path = extractPathFromToolSummary(entry.toolSummary);

      if (path && isTaskRelevantFile(path, requestedPaths)) {
        const verb = entry.toolName === "edit" ? "Updated" : "Created";
        lastChangedFile = `${verb} ${path}`;
      }
    }

    if (!lastReadPath && entry.toolName === "files") {
      const path = extractPathFromToolSummary(entry.toolSummary);

      if (path && isTaskRelevantFile(path, requestedPaths)) {
        lastReadPath = `Read ${path}`;
      }
    }
  }

  const notes = [
    lastFailedShell ? `Last failure: ${lastFailedShell}` : "",
    lastFailureReason ? `Failure reason: ${lastFailureReason}` : "",
    lastReadPath ? `Last read: ${lastReadPath.slice("Read ".length)}` : "",
    lastChangedFile ? `Last change: ${lastChangedFile}` : "",
    lastVerificationCommand ? `Last verification: ${lastVerificationCommand}` : "",
    lastObservedOutput ? `Last observed output: ${lastObservedOutput}` : ""
  ].filter(Boolean);

  return notes.map((note) => `- ${note}`);
}

function extractFailureReason(rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  const signalLine = lines.find((line) =>
    /\b(?:Error|Exception|ERR_[A-Z0-9_]+|ENOENT|EACCES|ReferenceError|TypeError|SyntaxError)\b/.test(line)
  ) ?? lines[0];

  return createInlinePreview(signalLine, 120);
}

function extractObservedToolOutput(rawOutput?: string) {
  if (!rawOutput) {
    return undefined;
  }

  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  if (lines.length === 1) {
    return createInlinePreview(lines[0], 120);
  }

  return undefined;
}

function buildRecentTaskState(
  entries: SessionTimelineEntry[],
  rawEvents: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>,
  allEntries: SessionTimelineEntry[] = entries
) {
  const latestUserIndex = findLatestUserEntryIndex(entries);
  const currentTaskEntries = latestUserIndex >= 0 ? entries.slice(latestUserIndex) : entries;
  const latestUserRequest = currentTaskEntries.find((entry) => entry.kind === "user")?.text;
  const taskAnchorRequest = latestUserRequest
    ? resolveTaskAnchorRequest(latestUserRequest, allEntries)
    : undefined;
  const taskAnchorEntryIndex = resolveTaskAnchorUserEntryIndex(latestUserRequest, allEntries);
  const taskStateEntries = taskAnchorEntryIndex >= 0 ? allEntries.slice(taskAnchorEntryIndex) : currentTaskEntries;
  const expectedOutput = taskAnchorRequest ? extractExpectedOutputFromRequest(taskAnchorRequest) : undefined;
  const requestedVerificationCommand = taskAnchorRequest ? extractVerificationCommandFromRequest(taskAnchorRequest) : undefined;
  const requestedPaths = taskAnchorRequest ? extractTaskRelevantPaths(taskAnchorRequest, requestedVerificationCommand) : [];
  const pendingApproval = extractPendingApprovalState(rawEvents, latestUserRequest);
  const workingFiles = dedupeNotes(filterTaskRelevantWorkingFiles(
    extractRecentWorkingFiles(taskStateEntries),
    requestedPaths,
    false
  )).slice(0, 4);
  const pendingAssistantStep = extractPendingAssistantCheckpoint(
    rawEvents,
    requestedPaths,
    latestUserRequest,
    requestedVerificationCommand
  )
    ?? extractPendingAssistantStep(taskStateEntries, requestedPaths);
  const lastRepairSummary = buildRecentRepairSummary(taskStateEntries, requestedPaths, requestedVerificationCommand)
    .map((line) => line.replace(/^- /, ""))
    .filter(Boolean);
  const prioritizedRepairState = lastRepairSummary.filter((line) =>
    /^(Last failure|Failure reason|Last verification|Last observed output):/.test(line)
  );
  const underlyingTask = taskAnchorRequest && latestUserRequest && normalizePreviewText(taskAnchorRequest) !== normalizePreviewText(latestUserRequest)
    ? taskAnchorRequest
    : undefined;

  const notes = [
    latestUserRequest ? `Current request: ${createInlinePreview(latestUserRequest, 140)}` : "",
    underlyingTask ? `Underlying task: ${createInlinePreview(underlyingTask, 140)}` : "",
    expectedOutput ? `Target output: ${expectedOutput}` : "",
    requestedVerificationCommand ? `Target verification: ${requestedVerificationCommand}` : "",
    pendingApproval ? `Pending approval: ${pendingApproval}` : "",
    workingFiles.length > 0 ? `Working files: ${workingFiles.join(", ")}` : "",
    pendingAssistantStep ? `Pending next step: ${pendingAssistantStep}` : "",
    ...prioritizedRepairState
  ].filter(Boolean);

  return dedupeNotes(notes).slice(0, 8).map((note) => `- ${note}`);
}

function findLatestUserEntryIndex(entries: SessionTimelineEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "user") {
      return index;
    }
  }

  return -1;
}

function extractPendingApprovalState(
  events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>,
  latestUserRequest?: string
) {
  const taskAnchorUserEventIndex = resolveTaskAnchorUserEventIndex(events, latestUserRequest);
  const relevantEvents = taskAnchorUserEventIndex >= 0 ? events.slice(taskAnchorUserEventIndex + 1) : events;
  const resolvedApprovalIds = new Set<string>();

  for (let index = relevantEvents.length - 1; index >= 0; index -= 1) {
    const event = relevantEvents[index];

    if (event?.type === "approval.resolved") {
      resolvedApprovalIds.add(event.payload.approvalId);
      continue;
    }

    if (event?.type !== "approval.requested") {
      continue;
    }

    if (resolvedApprovalIds.has(event.payload.approvalId)) {
      continue;
    }

    return renderPendingApprovalState(event.payload.toolName, event.payload.input, event.payload.reason);
  }

  return undefined;
}

function findLatestUserEventIndex(
  events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>
) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "user.message.submitted") {
      return index;
    }
  }

  return -1;
}

function renderPendingApprovalState(toolName: string, input: unknown, reason: string) {
  const target = renderContextApprovalTarget(toolName, input);
  return target ? `${toolName} · ${target}` : `${toolName} · ${createInlinePreview(reason, 120)}`;
}

function renderContextApprovalTarget(toolName: string, input: unknown) {
  if (toolName === "shell" && input && typeof input === "object" && "command" in input && typeof input.command === "string") {
    return createInlinePreview(input.command, 96);
  }

  if (
    (toolName === "files" || toolName === "write" || toolName === "edit")
    && input
    && typeof input === "object"
    && "path" in input
    && typeof input.path === "string"
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

function extractPendingAssistantStep(entries: SessionTimelineEntry[], requestedPaths: string[] = []) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry.kind !== "assistant") {
      continue;
    }

    const normalized = normalizePreviewText(entry.text);

    if (!normalized || !looksLikePendingAssistantStep(normalized)) {
      continue;
    }

    if (requestedPaths.length > 0) {
      const mentionedPaths = extractTaskRelevantPaths(normalized);

      if (mentionedPaths.length > 0 && !mentionedPaths.some((path) => requestedPaths.includes(path))) {
        continue;
      }
    }

    return createInlinePreview(normalized, 160);
  }

  return undefined;
}

function extractPendingAssistantCheckpoint(
  events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>,
  requestedPaths: string[] = [],
  latestUserRequest?: string,
  requestedVerificationCommand?: string
) {
  const taskAnchorUserEventIndex = resolveTaskAnchorUserEventIndex(events, latestUserRequest);
  const relevantEvents = taskAnchorUserEventIndex >= 0 ? events.slice(taskAnchorUserEventIndex + 1) : events;

  for (let index = relevantEvents.length - 1; index >= 0; index -= 1) {
    const event = relevantEvents[index];

    if (event?.type !== "assistant.checkpoint.recorded" || event.payload.kind !== "pending_next_step") {
      continue;
    }

    if (
      requestedPaths.length > 0
      && event.payload.targetPath
      && (
        !requestedVerificationCommand
        || normalizePreviewText(event.payload.targetPath) !== normalizePreviewText(requestedVerificationCommand)
      )
      && !requestedPaths.includes(event.payload.targetPath)
    ) {
      continue;
    }

    return createInlinePreview(normalizePreviewText(event.payload.content), 160);
  }

  return undefined;
}

function extractExpectedOutputFromRequest(request: string) {
  return extractExpectedOutputFromTaskRequest(request);
}

function resolveTaskAnchorRequest(latestUserRequest: string, entries: SessionTimelineEntry[]) {
  const embeddedAnchor = extractEmbeddedTaskAnchorFromRequest(latestUserRequest);

  if (embeddedAnchor) {
    return embeddedAnchor;
  }

  if (!isContextRunnableFollowUp(latestUserRequest)) {
    return latestUserRequest;
  }

  if (isContextAffirmativeFollowUp(latestUserRequest)) {
    const previousAssistantProposal = extractPreviousAssistantProposal(entries);

    if (previousAssistantProposal) {
      return previousAssistantProposal;
    }
  }

  return findPreviousActionableUserRequest(entries) ?? latestUserRequest;
}

function extractEmbeddedTaskAnchorFromRequest(request: string) {
  const approvedProposalMatch = request.match(/\bApproved proposal:\s*([\s\S]+)$/i);

  if (approvedProposalMatch?.[1]?.trim()) {
    return approvedProposalMatch[1].trim();
  }

  const originalTaskMatch = request.match(/\bOriginal task:\s*([\s\S]+)$/i);

  if (originalTaskMatch?.[1]?.trim()) {
    return originalTaskMatch[1].trim();
  }

  const previousContextMatch = request.match(/\bPrevious context request:\s*([\s\S]+)$/i);

  if (previousContextMatch?.[1]?.trim()) {
    return previousContextMatch[1].trim();
  }

  return undefined;
}

function findPreviousActionableUserRequest(entries: SessionTimelineEntry[]) {
  const latestUserIndex = findLatestUserEntryIndex(entries);

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry?.kind !== "user") {
      continue;
    }

    if (!isContextRunnableFollowUp(entry.text) && looksLikeContextActionableTaskRequest(entry.text)) {
      return entry.text;
    }
  }

  return undefined;
}

function extractPreviousAssistantProposal(entries: SessionTimelineEntry[]) {
  let skippedLatestUser = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (!skippedLatestUser) {
      if (entry?.kind === "user") {
        skippedLatestUser = true;
      }

      continue;
    }

    if (entry?.kind === "user" && !isContextRunnableFollowUp(entry.text) && looksLikeContextActionableTaskRequest(entry.text)) {
      break;
    }

    if (entry?.kind === "assistant" && looksLikeContextAssistantProposal(entry.text)) {
      return entry.text;
    }
  }

  return undefined;
}

function resolveTaskAnchorUserEntryIndex(
  latestUserRequest: string | undefined,
  entries: SessionTimelineEntry[]
) {
  const latestUserIndex = findLatestUserEntryIndex(entries);

  if (latestUserIndex < 0) {
    return -1;
  }

  if (!latestUserRequest || !isContextRunnableFollowUp(latestUserRequest)) {
    return latestUserIndex;
  }

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry?.kind !== "user") {
      continue;
    }

    if (!isContextRunnableFollowUp(entry.text) && looksLikeContextActionableTaskRequest(entry.text)) {
      return index;
    }
  }

  return latestUserIndex;
}

function resolveTaskAnchorUserEventIndex(
  events: Awaited<ReturnType<TranscriptStore["readEventsBySession"]>>,
  latestUserRequest?: string
) {
  const latestUserEventIndex = findLatestUserEventIndex(events);

  if (latestUserEventIndex < 0) {
    return -1;
  }

  if (!latestUserRequest || !isContextRunnableFollowUp(latestUserRequest)) {
    return latestUserEventIndex;
  }

  for (let index = latestUserEventIndex - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event?.type !== "user.message.submitted") {
      continue;
    }

    if (!isContextRunnableFollowUp(event.payload.content) && looksLikeContextActionableTaskRequest(event.payload.content)) {
      return index;
    }
  }

  return latestUserEventIndex;
}

function extractVerificationCommandFromRequest(request: string) {
  const backtickValues = [...request.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const commandValues = backtickValues.filter((value) => /^(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\b/i.test(value));
  return commandValues.at(-1);
}

function extractRecentWorkingFiles(entries: SessionTimelineEntry[]) {
  const files: string[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry.kind !== "tool" || !entry.toolName || !entry.toolSummary) {
      continue;
    }

    if (entry.toolName === "files" || entry.toolName === "edit" || entry.toolName === "write") {
      const path = extractPathFromToolSummary(entry.toolSummary);

      if (path) {
        files.push(path);
      }
    }
  }

  return files;
}

function extractTaskRelevantPaths(request: string, primaryVerificationCommand?: string) {
  const backtickValues = [...request.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const strippedRequest = request.replace(/`[^`]+`/g, " ");
  const primaryCommandPath = primaryVerificationCommand
    ? extractCommandPath(primaryVerificationCommand)
    : undefined;
  const directBacktickPaths = backtickValues
    .filter((value) => !/^(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\b/i.test(value))
    .filter((value) => /\.[A-Za-z0-9]+$/.test(value));
  const plainTextPaths = [...strippedRequest.matchAll(/\b([A-Za-z0-9_./-]+\.(?:mjs|js|ts|tsx|json|txt|md|csv))\b/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  return dedupeNotes([
    ...(primaryCommandPath ? [primaryCommandPath] : []),
    ...directBacktickPaths,
    ...plainTextPaths
  ]);
}

function isContextRunnableFollowUp(content: string) {
  return isContextResumeFollowUp(content)
    || isContextAffirmativeFollowUp(content)
    || isContextVagueOptimizationFollowUp(content)
    || isContextVagueRewriteFollowUp(content)
    || isContextVagueInspectionFollowUp(content);
}

function isContextResumeFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 24) {
    return false;
  }

  return /^(还能继续吗|能继续吗|继续吗|还能接着做吗|能接着做吗|接着来|接着做|继续做|继续搞|继续弄|继续干)$/iu.test(normalized);
}

function isContextAffirmativeFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 24) {
    return false;
  }

  return /^(可以|行|好|好的|好啊|继续|开始吧|来吧|弄吧|搞吧|干吧|没问题|行吧|可以了|继续吧|yes|ok|okay|sure|go ahead|please do)$/iu.test(normalized)
    || /^(?:按你说的|照你说的)(?:改|做|来)吧?$|^(?:按这个|照这个)(?:改|做|来)吧?$|^(?:就按这个|那就按这个)(?:改|做|来)吧?$/iu.test(normalized)
    || /^(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧)(?:[\s,，。!！?？/]+(?:继续|继续吧|干|干吧|搞|搞吧|弄|弄吧|来吧|开始吧))+$/iu.test(normalized);
}

function isContextVagueOptimizationFollowUp(content: string) {
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

function isContextVagueRewriteFollowUp(content: string) {
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

function isContextVagueInspectionFollowUp(content: string) {
  const normalized = content.trim();

  if (!normalized || normalized.startsWith("/")) {
    return false;
  }

  if (normalized.length > 72) {
    return false;
  }

  return /^(?:帮我)?(?:看看|看下|检查下|瞅瞅)(?:这个|一下|下)?$/iu.test(normalized)
    || /^(?:帮我)(?:看看|看下|检查下|瞅瞅)(?:(?:这个)?(?:项目|仓库|代码))$/iu.test(normalized)
    || /^(?:你能)?(?:不能)?(?:一次性)?(?:都)?(?:帮我)?(?:(?:看完|看看|检查|检查下|看下|审一下)).*(?:整个|完整|全部).*(?:项目|仓库|代码)(?:吗)?$/iu.test(normalized)
    || /^(?:你能)?(?:帮我)?(?:把)?(?:整个|完整|全部).*(?:项目|仓库|代码).*(?:看完|看看|检查|检查下|看下|审一下)(?:吗)?$/iu.test(normalized)
    || /^(?:inspect|review|look at)(?: it| this)?$/iu.test(normalized)
    || /^(?:inspect|review|look at).*(?:whole|entire|full).*(?:project|repo|repository|codebase)$/iu.test(normalized);
}

function looksLikeContextActionableTaskRequest(content: string) {
  if (looksLikeContextDiscussionRequest(content)) {
    return false;
  }

  return /\b(read|write|edit|fix|repair|create|inspect|run|running|verify|check|list|update|change|modify|improve|optimize|refactor|rewrite|rebuild)\b/i.test(content)
    || /\bby running\b/i.test(content)
    || /(读取|写入|编辑|修复|创建|检查|运行|验证|列出|修改|更新|优化|改进|重构|重写|重做|改成|改为|改下|改一下|换成)/u.test(content);
}

function looksLikeContextDiscussionRequest(content: string) {
  return /\b(discuss|brainstorm|explain|why|architecture|tradeoff|plan|strategy|how would you|what would you do|tell me what you(?:'d| would) do)\b/i.test(content)
    || /(讨论|聊聊|为什么|架构|取舍|方案|计划|策略|先讨论|告诉我.*怎么做|会怎么做|你会怎么做)/u.test(content);
}

function looksLikeContextAssistantProposal(content: string) {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  const hasOffer = /\b(if you want|if you'd like|i can|next step|if you want me to continue|i would first|i'd first|i would start by|i'd start by|i would begin by|i'd begin by)\b/i.test(normalized)
    || /(如果你愿意|如果你要我继续|我下一步可以|我可以继续|下一步可以|我建议下一步|下一步我可以|我会先|我先|我下一步(?:先)?(?:帮你|给你)?|下一步我(?:先)?(?:帮你|给你)?|我接下来(?:先)?(?:帮你|给你)?|接下来我(?:先)?(?:帮你|给你)?)/u.test(normalized);
  const hasAction = /\b(read|write|edit|fix|repair|create|update|change|modify|inspect|review|check|run|look at|rewrite|rebuild|optimize|improve|refactor)\b/i.test(normalized)
    || /(读取|写入|编辑|修复|创建|更新|修改|检查|运行|改|阅读|查看|看下|看看|审一下|读|重写|优化|改进|重构|处理下|处理一下|搞下|搞一下|弄下|弄一下|整下|整一下|搞成|弄成|整成)/u.test(normalized);

  return hasOffer && hasAction;
}

function looksLikePendingAssistantStep(content: string) {
  if (!content) {
    return false;
  }

  const hasNextStepCue = /\b(next|then|after that|will continue|continue with|going to|before verifying)\b/i.test(content)
    || /(接下来|下一步|然后|继续|再去|再做|还会|还要|并验证|再验证)/u.test(content);
  const hasConcreteWorkCue = /\b(read|write|edit|fix|repair|create|update|change|modify|inspect|review|check|run|rewrite|optimize|improve|refactor)\b/i.test(content)
    || /(读取|写入|编辑|修复|创建|更新|修改|检查|运行|重写|优化|改进|重构)/u.test(content);
  const hasCompletionCue = /\b(done|completed|finished|verified|confirmed|exactly)\b/i.test(content)
    || /(完成|已修复|已创建|已验证|已经|精确|确认)/u.test(content);

  return hasNextStepCue && (hasConcreteWorkCue || hasCompletionCue);
}

function filterTaskRelevantWorkingFiles(files: string[], requestedPaths: string[], fallbackToAll = true) {
  if (requestedPaths.length === 0) {
    return files;
  }

  const requestedBasenames = requestedPaths.map(basenameFromPath);
  const relevantFiles = files.filter((file) => {
    const basename = basenameFromPath(file);
    return requestedPaths.includes(file) || requestedBasenames.includes(basename);
  });

  return relevantFiles.length > 0 || !fallbackToAll ? relevantFiles : files;
}

function isTaskRelevantFile(path: string, requestedPaths: string[]) {
  if (requestedPaths.length === 0) {
    return true;
  }

  const basename = basenameFromPath(path);
  const requestedBasenames = requestedPaths.map(basenameFromPath);
  return requestedPaths.includes(path) || requestedBasenames.includes(basename);
}

function isTaskRelevantShellCommand(command: string, requestedPaths: string[], requestedVerificationCommand?: string) {
  if (requestedVerificationCommand && normalizePreviewText(command) === normalizePreviewText(requestedVerificationCommand)) {
    return true;
  }

  if (requestedPaths.length === 0) {
    return true;
  }

  const commandPaths = extractTaskRelevantPaths(command);

  if (commandPaths.length === 0) {
    return false;
  }

  return commandPaths.some((path) => isTaskRelevantFile(path, requestedPaths));
}

function extractCommandPath(command: string) {
  const commandMatch = command.match(/\b(?:node|pnpm|npm|yarn|bun|deno|python|python3|sh|bash|tsx)\s+([^\s]+?\.(?:mjs|js|ts|tsx|json|txt|md|csv))\b/i);
  return commandMatch?.[1]?.trim();
}

function basenameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.at(-1) ?? normalized;
}
