import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { EventBus } from "./event-bus.js";
import { AppLifecycle } from "./lifecycle.js";
import { EditorController } from "../editor/composer.js";
import { createDefaultSessionRecord, createResumedSessionRecord } from "../runtime/context.js";
import { AgentRuntime } from "../runtime/agent.js";
import { CheckpointStore } from "../storage/checkpoints.js";
import { TerminalEventLoop } from "../terminal/event-loop.js";
import { TerminalRenderer } from "../terminal/renderer.js";
import { TerminalPanelController } from "../terminal/panel-controller.js";
import { LogStore } from "../storage/logs.js";
import { SessionStore } from "../storage/sessions.js";
import { SettingsStore } from "../storage/settings.js";
import { TranscriptStore } from "../storage/transcripts.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { LocalProvider } from "../providers/local.js";
import { OpenAIProvider } from "../providers/openai.js";
import { InMemoryToolRegistry } from "../tools/registry.js";
import type { SessionCheckpoint } from "../types/checkpoint.js";

export async function bootstrapApp(input: {
  forceNewSession?: boolean;
  sessionId?: string;
} = {}) {
  const appRoot = process.cwd();
  const appConfigDir = resolve(appRoot, ".selfme");
  const runtimeDir = resolve(appRoot, ".selfme", "runtime");
  const packageJson = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8")) as { version?: string };

  await mkdir(appConfigDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const bus = new EventBus();
  const settings = new SettingsStore(resolve(appConfigDir, "settings.json"));
  const transcriptStore = new TranscriptStore(resolve(runtimeDir, "transcripts.jsonl"));
  const logStore = new LogStore(resolve(runtimeDir, "tool-logs.jsonl"));
  const sessionStore = new SessionStore(resolve(runtimeDir, "sessions.json"));
  const checkpointStore = new CheckpointStore(resolve(runtimeDir, "checkpoints.json"));
  await settings.ensureInitialized();
  await logStore.ensureInitialized();
  await sessionStore.ensureInitialized();
  await checkpointStore.ensureInitialized();
  const appSettings = await settings.read();
  if (input.forceNewSession && input.sessionId) {
    throw new Error("Cannot use --new and --session together.");
  }

  const latestSession = await sessionStore.getLatest();
  const selectedSession = input.forceNewSession
    ? undefined
    : input.sessionId
      ? await sessionStore.resolve(input.sessionId)
      : undefined;

  if (input.sessionId && !selectedSession) {
    throw new Error(`Unknown session id: ${input.sessionId}`);
  }

  const resumedSession = Boolean(selectedSession);
  const startupMode = input.forceNewSession
    ? "new"
    : input.sessionId
      ? "resume-selected"
      : "new";
  const session = selectedSession
    ? createResumedSessionRecord({
        previous: selectedSession,
        cwd: appRoot,
        version: packageJson.version ?? "0.0.0"
      })
    : createDefaultSessionRecord(appRoot, packageJson.version ?? "0.0.0");
  const provider = appSettings.provider === "openai" && appSettings.baseUrl && appSettings.apiKey
    ? new OpenAIProvider({
        baseUrl: appSettings.baseUrl,
        apiKey: appSettings.apiKey,
        model: appSettings.model
      })
    : appSettings.provider === "anthropic" && appSettings.baseUrl && appSettings.apiKey
      ? new AnthropicProvider({
          baseUrl: appSettings.baseUrl,
          apiKey: appSettings.apiKey,
          model: appSettings.model
        })
      : new LocalProvider();
  session.model = appSettings.model;
  const restoredEvents = resumedSession
    ? await transcriptStore.readEventsBySession(session.sessionId)
    : [];
  const latestCheckpoint = latestSession
    ? await checkpointStore.getLatest(latestSession.sessionId)
    : undefined;
  await sessionStore.upsert(session);
  const tools = new InMemoryToolRegistry();
  const panel = new TerminalPanelController();
  const runtime = new AgentRuntime({
    bus,
    provider,
    tools,
    session,
    transcriptStore,
    logStore,
    checkpointStore,
    sessionStore
  });
  const renderer = new TerminalRenderer({
    panel,
    bus,
    settings,
    session,
    restoredEvents,
    resumedSession,
    startupMode,
    latestSessionHint: buildLatestSessionHint(latestSession, latestCheckpoint, session.sessionId)
  });
  const editor = new EditorController();
  const terminal = new TerminalEventLoop({
    panel,
    bus,
    editor,
    sessionId: session.sessionId
  });

  return new AppLifecycle({
    bus,
    runtime,
    renderer,
    terminal,
    settings,
    transcriptStore,
    sessionStore,
    checkpointStore,
    session
  });
}

function buildLatestSessionHint(
  latestSession: {
    sessionId: string;
    title: string;
    model: string;
  } | undefined,
  latestCheckpoint: SessionCheckpoint | undefined,
  currentSessionId: string
) {
  if (!latestSession || latestSession.sessionId === currentSessionId) {
    return undefined;
  }

  const hasPendingApproval = Boolean(latestCheckpoint?.pendingApproval);
  const latestTaskState = latestCheckpoint?.latestTask?.state;
  const hasOpenTask = Boolean(
    latestTaskState &&
    latestTaskState !== "completed" &&
    latestTaskState !== "failed" &&
    latestTaskState !== "cancelled"
  );

  if (!hasPendingApproval && !hasOpenTask) {
    return undefined;
  }

  const parts = [
    `Recent session: ${latestSession.title}`,
    `${latestSession.model} · ${latestSession.sessionId.slice(0, 8)}`,
    `Resume: selfme --session ${latestSession.sessionId.slice(0, 8)}`,
    "Browse: /sessions"
  ];

  if (hasPendingApproval && latestCheckpoint?.pendingApproval) {
    parts.splice(2, 0, `Pending approval: ${latestCheckpoint.pendingApproval.reason}`);
    return parts.join("\n");
  }

  if (hasOpenTask && latestCheckpoint?.latestTask) {
    parts.splice(2, 0, `Open task: ${latestCheckpoint.latestTask.title} · ${latestCheckpoint.latestTask.state}`);
    return parts.join("\n");
  }

  return parts.join("\n");
}
