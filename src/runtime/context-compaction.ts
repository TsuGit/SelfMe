import type { ProviderContextMessage } from "../providers/base.js";
import type { TranscriptStore } from "../storage/transcripts.js";

export interface SessionTimelineEntry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  searchText: string;
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

  for (const item of events) {
    if (item.type === "user.message.submitted") {
      const content = item.payload.content.trim();

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

      if (last?.kind === "assistant") {
        last.text = `${last.text}${item.payload.delta}`;
        last.searchText = normalizeSearchText(last.text);
      } else {
        entries.push({
          kind: "assistant",
          text: item.payload.delta,
          searchText: normalizeSearchText(item.payload.delta)
        });
      }

      continue;
    }

    if (item.type === "tool.execution.completed") {
      const summary = normalizePreviewText(item.payload.summary || `${item.payload.toolName} completed`);

      entries.push({
        kind: "tool",
        text: `${item.payload.toolName}: ${summary}`,
        searchText: normalizeSearchText(summary)
      });
      continue;
    }

    if (item.type === "runtime.error.raised") {
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
