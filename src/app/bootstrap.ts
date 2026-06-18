import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "./event-bus.js";
import { AppLifecycle } from "./lifecycle.js";
import { EditorController } from "../editor/composer.js";
import { createDefaultSessionRecord } from "../runtime/context.js";
import { AgentRuntime } from "../runtime/agent.js";
import { TerminalEventLoop } from "../terminal/event-loop.js";
import { LinearTerminalRenderer } from "../terminal/linear-renderer.js";
import { TerminalPanelController } from "../terminal/panel-controller.js";
import { LogStore } from "../storage/logs.js";
import { SettingsStore } from "../storage/settings.js";
import { TranscriptStore } from "../storage/transcripts.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { LocalProvider } from "../providers/local.js";
import { OpenAIProvider } from "../providers/openai.js";
import { InMemoryToolRegistry } from "../tools/registry.js";

export async function bootstrapApp() {
  const workspaceRoot = process.env.SELFME_WORKSPACE_ROOT || process.env.INIT_CWD || process.cwd();
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appConfigDir = resolve(workspaceRoot, ".selfme");
  const runtimeDir = resolve(workspaceRoot, ".selfme", "runtime");
  const packageJson = JSON.parse(await readFile(resolve(cliRoot, "package.json"), "utf8")) as { version?: string };

  await mkdir(appConfigDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const bus = new EventBus();
  const settings = new SettingsStore(resolve(appConfigDir, "settings.json"));
  const transcriptStore = new TranscriptStore(resolve(runtimeDir, "transcripts.jsonl"));
  const logStore = new LogStore(resolve(runtimeDir, "tool-logs.jsonl"));

  await settings.ensureInitialized();
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const appSettings = await settings.read();
  const session = createDefaultSessionRecord(workspaceRoot, packageJson.version ?? "0.0.0");
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

  session.model = appSettings.model || provider.name;

  const tools = new InMemoryToolRegistry();
  const panel = new TerminalPanelController();
  const runtime = new AgentRuntime({
    bus,
    provider,
    tools,
    session,
    transcriptStore,
    logStore
  });
  const renderer = new LinearTerminalRenderer({
    panel,
    bus,
    session
  });
  const editor = new EditorController();
  const terminal = new TerminalEventLoop({
    panel,
    bus,
    editor,
    renderer,
    sessionId: session.sessionId
  });

  return new AppLifecycle({
    runtime,
    renderer,
    terminal,
    transcriptStore
  });
}
