import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { EventBus } from "./event-bus.js";
import { AppLifecycle } from "./lifecycle.js";
import { EditorController } from "../editor/composer.js";
import { createDefaultSessionRecord } from "../runtime/context.js";
import { AgentRuntime } from "../runtime/agent.js";
import { TerminalEventLoop } from "../terminal/event-loop.js";
import { TerminalRenderer } from "../terminal/renderer.js";
import { SettingsStore } from "../storage/settings.js";
import { TranscriptStore } from "../storage/transcripts.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { LocalProvider } from "../providers/local.js";
import { OpenAIProvider } from "../providers/openai.js";
import { InMemoryToolRegistry } from "../tools/registry.js";

export async function bootstrapApp() {
  const appRoot = process.cwd();
  const appConfigDir = resolve(appRoot, ".selfme");
  const runtimeDir = resolve(appRoot, ".selfme", "runtime");
  const packageJson = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8")) as { version?: string };

  await mkdir(appConfigDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const bus = new EventBus();
  const settings = new SettingsStore(resolve(appConfigDir, "settings.json"));
  const transcriptStore = new TranscriptStore(resolve(runtimeDir, "transcripts.jsonl"));
  await settings.ensureInitialized();
  const appSettings = await settings.read();
  const session = createDefaultSessionRecord(appRoot, packageJson.version ?? "0.0.0");
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
  const tools = new InMemoryToolRegistry();
  const runtime = new AgentRuntime({
    bus,
    provider,
    tools,
    session,
    transcriptStore
  });
  const renderer = new TerminalRenderer({
    bus,
    settings,
    session
  });
  const editor = new EditorController();
  const terminal = new TerminalEventLoop({
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
    transcriptStore
  });
}
