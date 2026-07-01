import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
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
  const workspaceStateDir = resolve(workspaceRoot, ".selfme");
  const userStateRoot = resolve(process.env.SELFME_HOME || homedir(), ".selfme");
  const workspaceStateKey = buildWorkspaceStateKey(workspaceRoot);
  const appConfigDir = resolve(userStateRoot, "workspaces", workspaceStateKey);
  const runtimeDir = resolve(appConfigDir, "runtime");
  const packageJson = JSON.parse(await readFile(resolve(cliRoot, "package.json"), "utf8")) as { version?: string };

  await mkdir(appConfigDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const bus = new EventBus();
  const settings = new SettingsStore(resolve(appConfigDir, "settings.json"));
  const transcriptStore = new TranscriptStore(resolve(runtimeDir, "transcripts.jsonl"));
  const logStore = new LogStore(resolve(runtimeDir, "tool-logs.jsonl"));

  const startupNotices = await prepareWorkspaceState({
    workspaceRoot,
    workspaceStateDir,
    userStateRoot,
    appConfigDir,
    runtimeDir
  });

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
    bus,
    runtime,
    renderer,
    terminal,
    transcriptStore,
    sessionId: session.sessionId,
    startupNotices
  });
}

function buildWorkspaceStateKey(workspaceRoot: string) {
  const normalized = resolve(workspaceRoot);
  const label = normalized
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "workspace";
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return `${label}-${hash}`;
}

async function prepareWorkspaceState(input: {
  workspaceRoot: string;
  workspaceStateDir: string;
  userStateRoot: string;
  appConfigDir: string;
  runtimeDir: string;
}) {
  const notices: Array<{ title: string; content: string }> = [];
  const workspaceSettings = resolve(input.workspaceStateDir, "settings.json");
  const workspaceRuntimeDir = resolve(input.workspaceStateDir, "runtime");
  const userSettings = resolve(input.appConfigDir, "settings.json");
  const userTranscript = resolve(input.runtimeDir, "transcripts.jsonl");
  const userToolLogs = resolve(input.runtimeDir, "tool-logs.jsonl");

  if (!(await pathExists(userSettings)) && (await pathExists(workspaceSettings))) {
    await copyFile(workspaceSettings, userSettings);
    notices.push({
      title: "Config Migrated",
      content: `Moved settings from ${workspaceSettings} to ${userSettings}. SelfMe now stores workspace state under ${input.userStateRoot}.`
    });
  }

  if (!(await pathExists(userTranscript))) {
    const oldTranscript = resolve(workspaceRuntimeDir, "transcripts.jsonl");

    if (await pathExists(oldTranscript)) {
      await copyFile(oldTranscript, userTranscript);
      notices.push({
        title: "Transcript Migrated",
        content: `Copied transcript history from ${oldTranscript} to ${userTranscript}.`
      });
    }
  }

  if (!(await pathExists(userToolLogs))) {
    const oldToolLogs = resolve(workspaceRuntimeDir, "tool-logs.jsonl");

    if (await pathExists(oldToolLogs)) {
      await copyFile(oldToolLogs, userToolLogs);
      notices.push({
        title: "Tool Logs Migrated",
        content: `Copied tool logs from ${oldToolLogs} to ${userToolLogs}.`
      });
    }
  }

  notices.push(...inspectWorkspaceGitSafety(input.workspaceRoot, input.workspaceStateDir));

  return notices;
}

function inspectWorkspaceGitSafety(workspaceRoot: string, workspaceStateDir: string) {
  const notices: Array<{ title: string; content: string }> = [];
  const workspaceSettingsPath = ".selfme/settings.json";
  const workspaceRuntimePath = ".selfme/runtime";
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], workspaceRoot);

  if (!gitRoot.ok) {
    return notices;
  }

  const trackedSettings = runGit(["ls-files", "--error-unmatch", workspaceSettingsPath], workspaceRoot).ok;
  const trackedRuntime = runGit(["ls-files", "--error-unmatch", workspaceRuntimePath], workspaceRoot).ok;

  if (trackedSettings || trackedRuntime) {
    notices.push({
      title: "Git Safety",
      content: `Tracked workspace state detected under ${workspaceStateDir}. Remove .selfme from git tracking before committing any further changes.`
    });
    return notices;
  }

  const ignoredSettings = runGit(["check-ignore", "-q", workspaceSettingsPath], workspaceRoot).ok;
  const ignoredRuntime = runGit(["check-ignore", "-q", workspaceRuntimePath], workspaceRoot).ok;

  if (!ignoredSettings || !ignoredRuntime) {
    notices.push({
      title: "Git Safety",
      content: `Workspace .selfme is not fully ignored by git in ${gitRoot.output || workspaceRoot}. Add .selfme/settings.json and .selfme/runtime to .gitignore to avoid accidental leaks.`
    });
  }

  return notices;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  return {
    ok: result.status === 0,
    output: result.stdout.trim()
  };
}
