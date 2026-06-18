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
  const requestedVerificationCommand = latestUserRequest ? extractVerificationCommandFromRequest(latestUserRequest) : undefined;
  const requestedPaths = latestUserRequest ? extractTaskRelevantPaths(latestUserRequest, requestedVerificationCommand) : [];
  const recentRepairSummary = buildRecentRepairSummary(recentEntries, requestedPaths, requestedVerificationCommand);
  const recentTaskState = buildRecentTaskState(recentEntries);

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

function buildRecentTaskState(entries: SessionTimelineEntry[]) {
  const latestUserRequest = [...entries].reverse().find((entry) => entry.kind === "user")?.text;
  const expectedOutput = latestUserRequest ? extractExpectedOutputFromRequest(latestUserRequest) : undefined;
  const requestedVerificationCommand = latestUserRequest ? extractVerificationCommandFromRequest(latestUserRequest) : undefined;
  const requestedPaths = latestUserRequest ? extractTaskRelevantPaths(latestUserRequest, requestedVerificationCommand) : [];
  const workingFiles = dedupeNotes(filterTaskRelevantWorkingFiles(
    extractRecentWorkingFiles(entries),
    requestedPaths,
    false
  )).slice(0, 4);
  const lastRepairSummary = buildRecentRepairSummary(entries, requestedPaths, requestedVerificationCommand)
    .map((line) => line.replace(/^- /, ""))
    .filter(Boolean);
  const prioritizedRepairState = lastRepairSummary.filter((line) =>
    /^(Last failure|Failure reason|Last verification|Last observed output):/.test(line)
  );

  const notes = [
    latestUserRequest ? `Current request: ${createInlinePreview(latestUserRequest, 140)}` : "",
    expectedOutput ? `Target output: ${expectedOutput}` : "",
    requestedVerificationCommand ? `Target verification: ${requestedVerificationCommand}` : "",
    workingFiles.length > 0 ? `Working files: ${workingFiles.join(", ")}` : "",
    ...prioritizedRepairState
  ].filter(Boolean);

  return dedupeNotes(notes).slice(0, 8).map((note) => `- ${note}`);
}

function extractExpectedOutputFromRequest(request: string) {
  return extractExpectedOutputFromTaskRequest(request);
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
