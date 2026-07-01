import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../app/event-bus.js";
import { EditorController } from "../editor/composer.js";
import type { ProviderClient, ProviderStreamChunk, ProviderStreamInput } from "../providers/base.js";
import { AgentRuntime } from "../runtime/agent.js";
import { getIncompleteSlashCommandNotice, parseToolCommand } from "../runtime/commands.js";
import { createDefaultSessionRecord } from "../runtime/context.js";
import { buildContextMessages } from "../runtime/context-compaction.js";
import { formatToolSummaryLine } from "../terminal/tool-message.js";
import {
  createAssistantCompletedEvent,
  createAssistantDeltaEvent,
  createRuntimeInterruptRequestedEvent,
  createTerminalCommandInvokedEvent,
  createToolExecutionCompletedEvent,
  createUserMessageSubmittedEvent
} from "../runtime/events.js";
import { LogStore } from "../storage/logs.js";
import { TranscriptStore } from "../storage/transcripts.js";
import { TerminalEventLoop } from "../terminal/event-loop.js";
import { TerminalPanelController } from "../terminal/panel-controller.js";
import { InMemoryToolRegistry } from "../tools/registry.js";
import type { RuntimeEvent, TaskStateChangedEvent } from "../types/events.js";

const VERSION = "2026.7.1";

class RegressionProvider implements ProviderClient {
  readonly name = "regression-provider";

  async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
    const output = resolveProviderResponse(input.content);

    for (const delta of chunkText(output, output.startsWith("<tool_call>") ? 400 : 24)) {
      yield { delta };
    }
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-regression-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "config"), { recursive: true });
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "src", "lib"), { recursive: true });
  await mkdir(join(workspace, "src", "api"), { recursive: true });
  await mkdir(join(workspace, "src", "data"), { recursive: true });
  await mkdir(join(workspace, "src", "docs"), { recursive: true });
  await mkdir(join(workspace, "src", "reports"), { recursive: true });
  await mkdir(join(workspace, "src", "shared"), { recursive: true });
  await mkdir(join(workspace, "src", "templates"), { recursive: true });
  await mkdir(join(workspace, "src", "web"), { recursive: true });
  await mkdir(join(workspace, "node-todo"), { recursive: true });
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new RegressionProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const approvals: string[] = [];
  const approvalDecisions: Array<"approve" | "deny"> = [];
  bus.on("approval.requested", (event) => {
    approvals.push(event.payload.approvalId);
    const decision = approvalDecisions.shift() ?? "approve";
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/${decision} ${event.payload.approvalId}`
    }));
  });

  await writeFile(join(workspace, "greet.mjs"), 'console.log("Hello");\n', "utf8");
  await writeFile(join(workspace, "app.config.json"), '{\n  "name": "SelfMe",\n  "port": 3000\n}\n', "utf8");
  await writeFile(join(workspace, "serve.mjs"), 'import config from "./app.conf.json" with { type: "json" };\nconsole.log(`${config.name} on ${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`name=${config.name}`);\nconsole.log(`port=${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "failure-stop-report.mjs"), 'import config from "./app.conf.json" with { type: "json" };\nconsole.log(`${config.name}:${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "converge-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}:${config.port}`);\nconsole.log("done");\n', "utf8");
  await writeFile(join(workspace, "converge-question-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}:${config.port}`);\nconsole.log("done");\n', "utf8");
  await writeFile(join(workspace, "premature-edit-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "retry-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "stubborn-report.mjs"), 'import config from "./app.conf.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "stubborn-question-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "stubborn-proposal-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "anchored-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`name=${config.name}`);\nconsole.log(`port=${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "explain-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`name=${config.name}`);\nconsole.log(`port=${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "vague-finish-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "question-finish-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "history-heavy-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "failure-recap-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "unrelated-anchor-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(join(workspace, "over-verify-report.mjs"), 'import config from "./app.config.json" with { type: "json" };\nconsole.log(`${config.name}-${config.port}`);\n', "utf8");
  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "description": "Simple todo app",\n  "main": "app.js",\n  "scripts": {\n    "start": "node app.js"\n  },\n  "dependencies": {\n    "ejs": "^3.1.10",\n    "express": "^4.19.2"\n  }\n}\n',
    "utf8"
  );
  await writeFile(join(workspace, "node-todo", "app.js"), 'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n', "utf8");
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-setup.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-exact.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready!");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(workspace, "smoke-a.mjs"), 'console.log("warmup");\n', "utf8");
  await writeFile(join(workspace, "dashboard.mjs"), 'import config from "./app.config.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst total = readFileSync("numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(`${config.name} total=${total}`);\n', "utf8");
  await writeFile(join(workspace, "config", "theme.json"), '{\n  "name": "SelfMe",\n  "env": "local"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "profile.json"), '{\n  "product": "SelfMe",\n  "channel": "local"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "runtime.json"), '{\n  "product": "SelfMe",\n  "stage": "dev",\n  "region": "cn"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "service.json"), '{\n  "name": "SelfMe",\n  "surface": "api",\n  "version": "v1"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "endpoint.json"), '{\n  "product": "SelfMe",\n  "host": "127.0.0.1",\n  "port": 3000\n}\n', "utf8");
  await writeFile(join(workspace, "config", "release.json"), '{\n  "name": "SelfMe",\n  "channel": "docs"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "badge.json"), '{\n  "name": "SelfMe",\n  "mode": "stable"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "portal.json"), '{\n  "name": "SelfMe",\n  "surface": "portal",\n  "region": "cn"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "audit.json"), '{\n  "name": "SelfMe",\n  "level": "audit",\n  "region": "cn"\n}\n', "utf8");
  await writeFile(join(workspace, "config", "report.json"), '{\n  "name": "SelfMe",\n  "column": "status"\n}\n', "utf8");
  await writeFile(join(workspace, "src", "banner.mjs"), 'import theme from "../config/themes.json" with { type: "json" };\nconsole.log(`${theme.name}-${theme.env}`);\n', "utf8");
  await writeFile(join(workspace, "src", "runner.mjs"), 'import profile from "../config/profile.json" with { type: "json" };\nimport { renderLabel } from "./libs/render-label.mjs";\nconsole.log(renderLabel(profile));\n', "utf8");
  await writeFile(join(workspace, "src", "runner-stage.mjs"), 'import profile from "../config/profile.json" with { type: "json" };\nimport { renderStageLabel } from "./libs/render-stage-label.mjs";\nconsole.log(renderStageLabel(profile));\n', "utf8");
  await writeFile(join(workspace, "src", "console.mjs"), 'import runtime from "../config/runtime.json" with { type: "json" };\nimport { formatRuntime } from "./lib/format-runtme.mjs";\nconsole.log(formatRuntime(runtime));\n', "utf8");
  await writeFile(join(workspace, "src", "console-explain.mjs"), 'import runtime from "../config/runtime.json" with { type: "json" };\nimport { formatRuntimeExplain } from "./lib/format-runtim-explain.mjs";\nconsole.log(formatRuntimeExplain(runtime));\n', "utf8");
  await writeFile(join(workspace, "src", "service.mjs"), 'import service from "../config/service.json" with { type: "json" };\nimport { renderService } from "./libs/render-service.mjs";\nconsole.log(renderService(service));\n', "utf8");
  await writeFile(join(workspace, "src", "service-stubborn.mjs"), 'import service from "../config/service.json" with { type: "json" };\nimport { renderServiceStubborn } from "./libs/render-service-stubborn.mjs";\nconsole.log(renderServiceStubborn(service));\n', "utf8");
  await writeFile(join(workspace, "src", "api", "serve-endpoint.mjs"), 'import endpoint from "../../config/endpoint.json" with { type: "json" };\nimport { renderEndpoint } from "../shareds/render-endpoint.mjs";\nconsole.log(renderEndpoint(endpoint));\n', "utf8");
  await writeFile(join(workspace, "src", "docs", "show-release.mjs"), 'import release from "../../config/release.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst template = readFileSync(new URL("../templats/release-label.txt", import.meta.url), "utf8").trim();\nconsole.log(template.replace("{name}", release.name).replace("{channel}", release.channel));\n', "utf8");
  await writeFile(join(workspace, "src", "docs", "show-badge.mjs"), 'import badge from "../../config/badge.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst template = readFileSync(new URL("../templates/badge-label.txt", import.meta.url), "utf8").trim();\nconsole.log(`${template.replace("{name}", badge.name).replace("{mode}", badge.mode)} ready`);\n', "utf8");
  await writeFile(join(workspace, "src", "reports", "show-status.mjs"), 'import report from "../../config/report.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst firstStatus = readFileSync(new URL("../datas/status-lines.csv", import.meta.url), "utf8").trim().split("\\n")[0];\nconsole.log(`${report.name}|${firstStatus}`);\n', "utf8");
  await writeFile(join(workspace, "src", "shared", "render-portal.mjs"), 'export function renderPortal(portal) {\n  return `${portal.name} ${portal.surface}-${portal.region}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "web", "show-portal.mjs"), 'import portal from "../../config/portal.json" with { type: "json" };\nimport { renderPortal } from "../shared/render-portal.mjs";\nconsole.log(renderPortal(portal));\n', "utf8");
  await writeFile(join(workspace, "src", "shared", "render-audit.mjs"), 'export function renderAudit(audit) {\n  return `${audit.name}:${audit.level}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "web", "show-audit.mjs"), 'import audit from "../../config/audit.json" with { type: "json" };\nimport { renderAudit } from "../shared/render-audit.mjs";\nconsole.log(`${renderAudit(audit)} ${audit.region}`);\n', "utf8");
  await writeFile(join(workspace, "src", "lib", "format-runtime.mjs"), 'export function formatRuntime(runtime) {\n  return `${runtime.product}:${runtime.stage}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "lib", "format-runtime-explain.mjs"), 'export function formatRuntimeExplain(runtime) {\n  return `${runtime.product}:${runtime.stage}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "lib", "render-service-stubborn.mjs"), 'export function renderServiceStubborn(service) {\n  return `${service.name} ${service.surface}-${service.version}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "lib", "render-health.mjs"), 'export function renderHeath(config) {\n  return `${config.name}-${config.port}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "healthcheck.mjs"), 'import config from "../app.config.json" with { type: "json" };\nimport { renderHealth } from "./lib/render-health.mjs";\nconsole.log(renderHealth(config));\n', "utf8");
  await writeFile(join(workspace, "src", "preview.mjs"), 'import theme from "./config/theme.json" with { type: "json" };\nconsole.log(`${theme.name} ${theme.env}`);\n', "utf8");
  await writeFile(join(workspace, "src", "bridge-helper.mjs"), 'export function bridgeStatus() {\n  return "-ready";\n}\n', "utf8");
  await writeFile(join(workspace, "src", "bridge.mjs"), 'import { bridgeStatus } from "./bridge-helperr.mjs";\nconsole.log(`SelfMe${bridgeStatus()}`);\n', "utf8");
  await writeFile(join(workspace, "src", "bridge-switch-helper.mjs"), 'export function bridgeState() {\n  return "-ready";\n}\n', "utf8");
  await writeFile(join(workspace, "src", "bridge-switch.mjs"), 'import { bridgeStatus } from "./bridge-switch-helperr.mjs";\nconsole.log(`SelfMe${bridgeStatus()}`);\n', "utf8");
  await writeFile(join(workspace, "show-runtime-chain.mjs"), 'import runtime from "./config/runtime.json" with { type: "json" };\nimport { renderRuntimeLabel } from "./render-runtime-labl.mjs";\nimport { renderRegionLabel } from "./render-region-label.mjs";\nconsole.log(`${renderRuntimeLabel(runtime)} ${renderRegionLabel(runtime)}`);\n', "utf8");
  await writeFile(join(workspace, "deep-runtime-chain.mjs"), 'import runtime from "./config/runtime.json" with { type: "json" };\nimport { renderRuntimeCore } from "./render-runtime-cor.mjs";\nimport { renderRuntimeRegion } from "./render-runtime-region.mjs";\nimport { renderRuntimeSuffix } from "./render-runtime-suffix.mjs";\nconsole.log(`${renderRuntimeCore(runtime)} ${renderRuntimeRegion(runtime)} ${renderRuntimeSuffix(runtime)}`);\n', "utf8");
  await writeFile(join(workspace, "src", "runner-stage-echo.mjs"), 'import profile from "../config/profile.json" with { type: "json" };\nimport { renderStageEcho } from "./libs/render-stage-echo.mjs";\nconsole.log(renderStageEcho(profile));\n', "utf8");
  await writeFile(join(workspace, "src", "runner-stage-progress.mjs"), 'import profile from "../config/profile.json" with { type: "json" };\nimport { renderStageProgress } from "./libs/render-stage-progress.mjs";\nconsole.log(renderStageProgress(profile));\n', "utf8");
  await writeFile(
    join(workspace, "catalog.txt"),
    [
      ...Array.from({ length: 1600 }, (_, index) => `item-${index + 1}=${index + 1}`),
      "name=SelfMe",
      "channel=release",
      "port=3000"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(workspace, "status.mjs"), 'console.log("pending");\n', "utf8");

  console.log("task: fix greet.mjs");
  const codingResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: 'Fix greet.mjs so it prints "Hello, SelfMe!" and verify by running it.'
  });

  const greetContent = await readFile(join(workspace, "greet.mjs"), "utf8");
  assert.equal(greetContent, 'console.log("Hello, SelfMe!");\n');
  assert.match(codingResult.assistantText, /Hello, SelfMe!/);
  assert.ok(
    codingResult.toolSummaries.some((summary) => summary.startsWith("node greet.mjs · completed")),
    "expected shell verification summary"
  );

  console.log("task: create checklist.md");
  const checklistResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Create checklist.md with exactly three bullet points: buy milk, ship cli, test tools. Then verify the file."
  });

  const checklistContent = await readFile(join(workspace, "checklist.md"), "utf8");
  assert.equal(checklistContent, "- buy milk\n- ship cli\n- test tools\n");
  assert.match(checklistResult.assistantText, /checklist\.md/i);
  assert.ok(
    checklistResult.toolSummaries.some((summary) => summary.startsWith("checklist.md:1-3")),
    "expected file verification summary"
  );

  console.log("task: recover from shell verification failure");
  const repairAfterFailureResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: 'Create math.mjs so running `node math.mjs` prints exactly `42`. Verify it and fix any errors you hit before finishing.'
  });

  const mathContent = await readFile(join(workspace, "math.mjs"), "utf8");
  assert.equal(mathContent, 'console.log(42);\n');
  assert.match(repairAfterFailureResult.assistantText, /42/);
  assert.ok(
    repairAfterFailureResult.toolSummaries.some((summary) => summary.startsWith("node math.mjs · failed (1)")),
    "expected failed shell verification before repair"
  );
  assert.ok(
    repairAfterFailureResult.toolSummaries.some((summary) => summary.startsWith("node math.mjs · completed")),
    "expected successful shell verification after repair"
  );

  console.log("task: complete multi-step file and shell chain");
  const approvalsBeforeMultiStepChain = approvals.length;
  const multiStepChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Create numbers.txt with three lines: 4, 5, 6. Then create total.mjs so running `node total.mjs` prints exactly `15`. Verify it and fix any errors before finishing."
  });

  const numbersContent = await readFile(join(workspace, "numbers.txt"), "utf8");
  const totalContent = await readFile(join(workspace, "total.mjs"), "utf8");
  assert.equal(numbersContent, "4\n5\n6\n");
  assert.match(totalContent, /numbers\.txt/);
  assert.match(totalContent, /reduce/);
  assert.match(multiStepChainResult.assistantText, /15/);
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("numbers.txt · created")),
    "expected source data file to be created"
  );
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("total.mjs · created")),
    "expected script file to be created"
  );
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("node total.mjs · failed (1)")),
    "expected failed verification before repair"
  );
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("total.mjs:1-4")),
    "expected file read during repair"
  );
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("total.mjs:1-4 · updated")),
    "expected script edit during repair"
  );
  assert.ok(
    multiStepChainResult.toolSummaries.some((summary) => summary.startsWith("node total.mjs · completed")),
    "expected successful verification after repair"
  );
  assert.equal(
    approvals.length - approvalsBeforeMultiStepChain,
    1,
    "expected one task-scoped approval to cover all writes and edits in the multi-step chain"
  );

  console.log("task: keep task-scoped approval limited to requested files");
  const approvalsBeforeScopedWriteChain = approvals.length;
  const scopedWriteChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: 'Fix greet.mjs so it prints exactly "Scoped". Verify it.'
  });

  const greetScopedContent = await readFile(join(workspace, "greet.mjs"), "utf8");
  const rogueContent = await readFile(join(workspace, "rogue.txt"), "utf8");
  assert.equal(greetScopedContent, 'console.log("Scoped");\n');
  assert.equal(rogueContent, "hidden\n");
  assert.match(scopedWriteChainResult.assistantText, /Scoped/);
  assert.equal(
    approvals.length - approvalsBeforeScopedWriteChain,
    2,
    "expected unrelated write in the same task to require a second approval"
  );
  await writeFile(join(workspace, "greet.mjs"), 'console.log("Hello, SelfMe!");\n', "utf8");

  console.log("task: complete cross-file config and script chain");
  const crossFileChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, then create print-config.mjs so running `node print-config.mjs` prints exactly `SelfMe:3000`. Verify it and fix any errors before finishing."
  });

  const printConfigContent = await readFile(join(workspace, "print-config.mjs"), "utf8");
  assert.match(printConfigContent, /app\.config\.json/);
  assert.match(printConfigContent, /config\.name/);
  assert.match(printConfigContent, /config\.port/);
  assert.match(crossFileChainResult.assistantText, /SelfMe:3000/);
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config file read before script creation"
  );
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("print-config.mjs · created")),
    "expected script file to be created"
  );
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("node print-config.mjs · failed (1)")),
    "expected failed verification before repair"
  );
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("print-config.mjs:1-3")),
    "expected script read during repair"
  );
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("print-config.mjs:1-3 · updated")),
    "expected script edit during repair"
  );
  assert.ok(
    crossFileChainResult.toolSummaries.some((summary) => summary.startsWith("node print-config.mjs · completed")),
    "expected successful verification after repair"
  );

  console.log("task: treat affirmative follow-up as approval to execute the previous proposal");
  const proposalOnlyResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read node-todo/app.js and tell me what you want to improve next, but do not modify anything yet."
  });

  assert.match(proposalOnlyResult.assistantText, /node-todo\/app\.js/);
  assert.match(proposalOnlyResult.assistantText, /(next step|I can|如果你愿意)/i);
  assert.doesNotMatch(proposalOnlyResult.assistantText, /\n/);
  assert.doesNotMatch(proposalOnlyResult.assistantText, /also/i);

  const approvedProposalResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "可以"
  });

  const approvedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(approvedTodoAppContent, /process\.env\.PORT/);
  assert.match(approvedProposalResult.assistantText, /node-todo\/app\.js/);
  assert.doesNotMatch(approvedProposalResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    approvedProposalResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-6")),
    "expected approved follow-up to read the proposed file"
  );
  assert.ok(
    approvedProposalResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected approved follow-up to execute the proposed edit"
  );

  const repeatedProposalOnlyResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read node-todo/app.js and tell me what you want to improve next, but do not modify anything yet."
  });

  assert.match(repeatedProposalOnlyResult.assistantText, /node-todo\/app\.js/);

  const repeatedContinueResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "继续 继续 干"
  });

  assert.match(repeatedContinueResult.assistantText, /node-todo\/app\.js/);
  assert.ok(
    repeatedContinueResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-6")),
    "expected repeated continue follow-up to execute the proposed file read"
  );
  assert.ok(
    repeatedContinueResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected repeated continue follow-up to execute the proposed edit"
  );

  console.log("task: anchor a vague rewrite follow-up to the most recently inspected project");
  const rewriteFollowUpResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "你能帮我重新写个项目吗"
  });

  const rewriteFollowUpAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(rewriteFollowUpAppContent, /process\.env\.PORT/);
  assert.match(rewriteFollowUpResult.assistantText, /process\.env\.PORT|node-todo\/app\.js/i);
  assert.ok(
    rewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected vague rewrite follow-up to anchor to the recently inspected project entry"
  );
  assert.ok(
    rewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected vague rewrite follow-up to continue into a concrete work file"
  );
  assert.ok(
    rewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected vague rewrite follow-up to perform a concrete edit"
  );

  console.log("task: execute a broader approved project rewrite proposal instead of stopping at the plan");
  const rewriteProposalResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。"
  });

  assert.match(rewriteProposalResult.assistantText, /node-todo/i);
  assert.match(rewriteProposalResult.assistantText, /app\.js/i);
  assert.match(rewriteProposalResult.assistantText, /views\/index\.ejs/i);
  assert.match(rewriteProposalResult.assistantText, /package\.json/i);
  assert.ok(
    rewriteProposalResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected rewrite proposal flow to start from a workspace listing"
  );
  assert.ok(
    rewriteProposalResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected rewrite proposal flow to inspect the package entry before proposing the rewrite"
  );

  const approvedRewriteResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "可以"
  });

  const approvedRewriteAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const approvedRewriteViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  const approvedRewritePackageContent = await readFile(join(workspace, "node-todo", "package.json"), "utf8");
  assert.match(approvedRewriteAppContent, /process\.env\.PORT/);
  assert.match(approvedRewriteViewContent, /maxlength="100"/);
  assert.match(approvedRewritePackageContent, /"dev": "node app\.js"/);
  assert.match(approvedRewriteResult.assistantText, /node-todo/i);
  assert.doesNotMatch(approvedRewriteResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected approved rewrite flow to read app.js"
  );
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected approved rewrite flow to edit app.js"
  );
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected approved rewrite flow to continue into views/index.ejs"
  );
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected approved rewrite flow to edit views/index.ejs"
  );
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected approved rewrite flow to read package.json before editing scripts"
  );
  assert.ok(
    approvedRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:5-7 · updated")),
    "expected approved rewrite flow to edit package.json scripts"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "description": "Simple todo app",\n  "main": "app.js",\n  "scripts": {\n    "start": "node app.js"\n  },\n  "dependencies": {\n    "ejs": "^3.1.10",\n    "express": "^4.19.2"\n  }\n}\n',
    "utf8"
  );

  console.log("task: execute the latest rewrite proposal when the user repeats a broad rewrite follow-up");
  const rewriteProposalRepeatResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。"
  });

  assert.match(rewriteProposalRepeatResult.assistantText, /app\.js/i);
  assert.match(rewriteProposalRepeatResult.assistantText, /views\/index\.ejs/i);
  assert.match(rewriteProposalRepeatResult.assistantText, /package\.json/i);

  const proposalDrivenRewriteFollowUpResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "你能帮我重新写个项目吗"
  });

  const proposalDrivenRewriteAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const proposalDrivenRewriteViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  const proposalDrivenRewritePackageContent = await readFile(join(workspace, "node-todo", "package.json"), "utf8");
  assert.match(proposalDrivenRewriteAppContent, /process\.env\.PORT/);
  assert.match(proposalDrivenRewriteViewContent, /maxlength="100"/);
  assert.match(proposalDrivenRewritePackageContent, /"dev": "node app\.js"/);
  assert.match(proposalDrivenRewriteFollowUpResult.assistantText, /node-todo/i);
  assert.doesNotMatch(proposalDrivenRewriteFollowUpResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    proposalDrivenRewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected broad rewrite follow-up to execute the rewrite proposal from app.js"
  );
  assert.ok(
    proposalDrivenRewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected broad rewrite follow-up to continue into views/index.ejs"
  );
  assert.ok(
    proposalDrivenRewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected broad rewrite follow-up to continue into package.json"
  );
  assert.ok(
    proposalDrivenRewriteFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:5-7 · updated")),
    "expected broad rewrite follow-up to complete the package.json rewrite step"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-exact.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready!");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  console.log("task: execute a proposal-driven rewrite through exact verification and latest failure-point repair");
  const rewriteProposalWithVerificationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果重写 node-todo，并运行 `node node-todo/verify-exact.mjs` 验证直到输出 exactly `ready`，你会怎么做。"
  });

  assert.match(rewriteProposalWithVerificationResult.assistantText, /app\.js/i);
  assert.match(rewriteProposalWithVerificationResult.assistantText, /views\/index\.ejs/i);
  assert.match(rewriteProposalWithVerificationResult.assistantText, /verify-exact\.mjs/i);

  const proposalDrivenVerificationRewriteResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "你能帮我重新写个项目吗"
  });

  const proposalDrivenVerificationAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const proposalDrivenVerificationViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  const proposalDrivenVerificationVerifierContent = await readFile(join(workspace, "node-todo", "verify-exact.mjs"), "utf8");
  assert.match(proposalDrivenVerificationAppContent, /process\.env\.PORT/);
  assert.match(proposalDrivenVerificationViewContent, /maxlength="100"/);
  assert.match(proposalDrivenVerificationVerifierContent, /console\.log\("ready"\)/);
  assert.match(proposalDrivenVerificationRewriteResult.assistantText, /ready/);
  assert.doesNotMatch(proposalDrivenVerificationRewriteResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    proposalDrivenVerificationRewriteResult.toolSummaries.filter((summary) => summary.startsWith("node node-todo/verify-exact.mjs · completed")).length >= 3,
    "expected proposal-driven rewrite follow-up to verify after app.js, after views/index.ejs, and after repairing verify-exact.mjs"
  );
  assert.ok(
    proposalDrivenVerificationRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected proposal-driven rewrite follow-up to finish the requested view edit before chasing the verifier"
  );
  assert.ok(
    proposalDrivenVerificationRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-exact.mjs:1-14")),
    "expected proposal-driven rewrite follow-up to inspect the verifier after the near-miss exact output"
  );
  assert.ok(
    proposalDrivenVerificationRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-exact.mjs:7-7 · updated")),
    "expected proposal-driven rewrite follow-up to repair verify-exact.mjs as the latest failure point"
  );

  console.log("task: allow extended coding task to continue beyond six tool steps");
  const extendedBudgetResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/runtime.json, then create render-runtime-label.mjs and render-region-label.mjs and repair existing show-runtime-chain.mjs so running `node show-runtime-chain.mjs` prints exactly `SelfMe dev cn`. Verify it before finishing."
  });

  const runtimeLabelContent = await readFile(join(workspace, "render-runtime-label.mjs"), "utf8");
  const regionLabelContent = await readFile(join(workspace, "render-region-label.mjs"), "utf8");
  const runtimeChainContent = await readFile(join(workspace, "show-runtime-chain.mjs"), "utf8");
  assert.match(runtimeLabelContent, /runtime\.product/);
  assert.match(regionLabelContent, /runtime\.region/);
  assert.match(runtimeChainContent, /render-runtime-label\.mjs/);
  assert.match(extendedBudgetResult.assistantText, /SelfMe dev cn/);
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => /^config\/runtime\.json:1-\d+$/.test(summary)),
    "expected runtime config read"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-label.mjs · created")),
    "expected runtime helper creation"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-region-label.mjs · created")),
    "expected region helper creation"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("node show-runtime-chain.mjs · failed (1)")),
    "expected failing runtime chain verification before repair"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("show-runtime-chain.mjs:1-4")),
    "expected runtime chain file read"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("show-runtime-chain.mjs:2-2 · updated")),
    "expected runtime chain import repair"
  );
  assert.ok(
    extendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("node show-runtime-chain.mjs · completed")),
    "expected successful extended-budget verification"
  );

  console.log("task: allow deeper exact-output repair chains to continue beyond ten tool steps");
  const deepExtendedBudgetResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/runtime.json, then create render-runtime-core.mjs, render-runtime-region.mjs, and render-runtime-suffix.mjs, and repair existing deep-runtime-chain.mjs so running `node deep-runtime-chain.mjs` prints exactly `SelfMe dev cn stable`. Verify it and keep fixing until exact."
  });

  const deepRuntimeChainContent = await readFile(join(workspace, "deep-runtime-chain.mjs"), "utf8");
  const runtimeCoreContent = await readFile(join(workspace, "render-runtime-core.mjs"), "utf8");
  const runtimeRegionContent = await readFile(join(workspace, "render-runtime-region.mjs"), "utf8");
  const runtimeSuffixContent = await readFile(join(workspace, "render-runtime-suffix.mjs"), "utf8");
  assert.match(runtimeCoreContent, /runtime\.product/);
  assert.match(runtimeCoreContent, /runtime\.stage/);
  assert.match(runtimeRegionContent, /runtime\.region/);
  assert.match(runtimeSuffixContent, /stable/);
  assert.doesNotMatch(runtimeSuffixContent, /-stable/);
  assert.match(deepRuntimeChainContent, /render-runtime-core\.mjs/);
  assert.match(deepExtendedBudgetResult.assistantText, /SelfMe dev cn stable/);
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => /^config\/runtime\.json:1-\d+$/.test(summary)),
    "expected deep chain to start from runtime config"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-core.mjs · created")),
    "expected deep chain core helper creation"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-region.mjs · created")),
    "expected deep chain region helper creation"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-suffix.mjs · created")),
    "expected deep chain suffix helper creation"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("node deep-runtime-chain.mjs · failed (1)")),
    "expected deep chain import failure before repair"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("deep-runtime-chain.mjs:1-5")),
    "expected deep chain file read after import failure"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("deep-runtime-chain.mjs:2-2 · updated")),
    "expected deep chain import repair"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-suffix.mjs:1-3")),
    "expected suffix helper read after near-miss verification"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.some((summary) => summary.startsWith("render-runtime-suffix.mjs:2-2 · updated")),
    "expected suffix helper tightening after near-miss verification"
  );
  assert.ok(
    deepExtendedBudgetResult.toolSummaries.filter((summary) => summary.startsWith("node deep-runtime-chain.mjs · completed")).length >= 2,
    "expected deep chain to survive a near-miss verification and keep tightening"
  );

  console.log("task: start working after model emits an initial plan-only reply");
  const initialPlanOnlyResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, then create startup-report.mjs so running `node startup-report.mjs` prints exactly `SelfMe:3000`. Verify it before finishing."
  });

  const startupReportContent = await readFile(join(workspace, "startup-report.mjs"), "utf8");
  assert.match(startupReportContent, /app\.config\.json/);
  assert.match(initialPlanOnlyResult.assistantText, /SelfMe:3000/);
  assert.deepEqual(initialPlanOnlyResult.assistantTurns, [
    "Created startup-report.mjs and verified it prints exactly SelfMe:3000."
  ]);
  assert.ok(
    initialPlanOnlyResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected startup config read after initial plan-only reply"
  );
  assert.ok(
    initialPlanOnlyResult.toolSummaries.some((summary) => summary.startsWith("startup-report.mjs · created")),
    "expected startup report creation after initial plan-only reply"
  );
  assert.ok(
    initialPlanOnlyResult.toolSummaries.some((summary) => summary.startsWith("node startup-report.mjs · completed")),
    "expected startup report verification"
  );

  console.log("task: continue after model emits a progress-only status update");
  const delayedContinuationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, then create delayed-report.mjs so running `node delayed-report.mjs` prints exactly `SelfMe:3000`. Verify it before finishing."
  });

  const delayedReportContent = await readFile(join(workspace, "delayed-report.mjs"), "utf8");
  assert.match(delayedReportContent, /app\.config\.json/);
  assert.match(delayedContinuationResult.assistantText, /SelfMe:3000/);
  assert.deepEqual(delayedContinuationResult.assistantTurns, [
    "Created delayed-report.mjs and verified it prints exactly SelfMe:3000."
  ]);
  assert.ok(
    delayedContinuationResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before delayed report creation"
  );
  assert.ok(
    delayedContinuationResult.toolSummaries.some((summary) => summary.startsWith("delayed-report.mjs · created")),
    "expected delayed report creation after progress-only reply"
  );
  assert.ok(
    delayedContinuationResult.toolSummaries.some((summary) => summary.startsWith("node delayed-report.mjs · completed")),
    "expected delayed report verification"
  );

  console.log("task: continue after a stage summary that still has concrete work left");
  const stageSummaryContinuationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/profile.json, then create src/lib/render-stage-label.mjs and repair existing src/runner-stage.mjs so running `node src/runner-stage.mjs` prints exactly `SelfMe [stage]`. Verify it and keep fixing until exact."
  });

  const stageLabelContent = await readFile(join(workspace, "src", "lib", "render-stage-label.mjs"), "utf8");
  const runnerStageContent = await readFile(join(workspace, "src", "runner-stage.mjs"), "utf8");
  assert.match(stageLabelContent, /renderStageLabel/);
  assert.match(stageLabelContent, /profile\.product/);
  assert.match(stageLabelContent, /\[stage\]/);
  assert.match(runnerStageContent, /\.\/lib\/render-stage-label\.mjs/);
  assert.match(stageSummaryContinuationResult.assistantText, /SelfMe \[stage\]/);
  assert.deepEqual(stageSummaryContinuationResult.assistantTurns, [
    "Created src/lib/render-stage-label.mjs. Next I will run runner-stage, fix any import issue, and verify the final output.",
    "Created src/lib/render-stage-label.mjs, repaired src/runner-stage.mjs, and confirmed it prints exactly SelfMe [stage]."
  ]);
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("config/profile.json:1-4")),
    "expected stage-summary chain to start from the profile config"
  );
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-stage-label.mjs · created")),
    "expected helper creation before the stage summary"
  );
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("node src/runner-stage.mjs · failed (1)")),
    "expected runner-stage verification failure after the stage summary"
  );
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage.mjs:1-3")),
    "expected runner-stage file read after the stage summary"
  );
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage.mjs:2-2 · updated")),
    "expected runner-stage repair after the stage summary"
  );
  assert.ok(
    stageSummaryContinuationResult.toolSummaries.some((summary) => summary.startsWith("node src/runner-stage.mjs · completed")),
    "expected final runner-stage verification after the stage summary"
  );

  console.log("task: suppress duplicate deferred stage summaries while continuing the same repair chain");
  const duplicateStageSummaryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/profile.json, then create src/lib/render-stage-echo.mjs and repair existing src/runner-stage-echo.mjs so running `node src/runner-stage-echo.mjs` prints exactly `SelfMe [echo]`. Verify it and keep fixing until exact."
  });

  const stageEchoContent = await readFile(join(workspace, "src", "lib", "render-stage-echo.mjs"), "utf8");
  const runnerStageEchoContent = await readFile(join(workspace, "src", "runner-stage-echo.mjs"), "utf8");
  assert.match(stageEchoContent, /renderStageEcho/);
  assert.match(stageEchoContent, /\[echo\]/);
  assert.match(runnerStageEchoContent, /\.\/lib\/render-stage-echo\.mjs/);
  assert.match(duplicateStageSummaryResult.assistantText, /SelfMe \[echo\]/);
  assert.deepEqual(duplicateStageSummaryResult.assistantTurns, [
    "Created src/lib/render-stage-echo.mjs. Next I will run runner-stage-echo, fix any import issue, and verify the final output.",
    "Created src/lib/render-stage-echo.mjs, repaired src/runner-stage-echo.mjs, and confirmed it prints exactly SelfMe [echo]."
  ]);
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("config/profile.json:1-4")),
    "expected duplicate-stage chain to start from the profile config"
  );
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-stage-echo.mjs · created")),
    "expected duplicate-stage helper creation"
  );
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("node src/runner-stage-echo.mjs · failed (1)")),
    "expected duplicate-stage verification failure before repair"
  );
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage-echo.mjs:1-3")),
    "expected duplicate-stage runner file read"
  );
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage-echo.mjs:2-2 · updated")),
    "expected duplicate-stage runner repair"
  );
  assert.ok(
    duplicateStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("node src/runner-stage-echo.mjs · completed")),
    "expected duplicate-stage final verification"
  );

  console.log("task: preserve distinct deferred stage summaries across one longer repair chain");
  const multiStageSummaryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/profile.json, then create src/lib/render-stage-progress.mjs and repair existing src/runner-stage-progress.mjs so running `node src/runner-stage-progress.mjs` prints exactly `SelfMe [local]`. Verify it and keep fixing until exact."
  });

  const stageProgressContent = await readFile(join(workspace, "src", "lib", "render-stage-progress.mjs"), "utf8");
  const runnerStageProgressContent = await readFile(join(workspace, "src", "runner-stage-progress.mjs"), "utf8");
  assert.match(stageProgressContent, /renderStageProgress/);
  assert.match(stageProgressContent, /\[local\]/);
  assert.match(runnerStageProgressContent, /\.\/lib\/render-stage-progress\.mjs/);
  assert.match(multiStageSummaryResult.assistantText, /SelfMe \[local\]/);
  assert.deepEqual(multiStageSummaryResult.assistantTurns, [
    "Created src/lib/render-stage-progress.mjs. Next I will run runner-stage-progress, fix any import issue, and verify the current output.",
    "Repaired src/runner-stage-progress.mjs import. Next I will rerun it and tighten the helper output if it is still not exact.",
    "Repaired src/lib/render-stage-progress.mjs and confirmed src/runner-stage-progress.mjs now prints exactly SelfMe [local]."
  ]);
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("config/profile.json:1-4")),
    "expected multi-stage chain to start from the profile config"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-stage-progress.mjs · created")),
    "expected multi-stage helper creation"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("node src/runner-stage-progress.mjs · failed (1)")),
    "expected first multi-stage verification failure"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage-progress.mjs:1-3")),
    "expected runner-stage-progress file read after first stage summary"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/runner-stage-progress.mjs:2-2 · updated")),
    "expected runner-stage-progress import repair"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-stage-progress.mjs:1-3")),
    "expected helper reread after inexact successful run"
  );
  assert.ok(
    multiStageSummaryResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-stage-progress.mjs:2-2 · updated")),
    "expected helper output tightening after inexact successful run"
  );
  assert.equal(
    multiStageSummaryResult.toolSummaries.filter((summary) => summary.startsWith("node src/runner-stage-progress.mjs · completed")).length,
    2,
    "expected one inexact successful run plus one final exact verification"
  );

  console.log("task: break out of repeated identical verification results");
  const repeatedVerificationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and repair existing retry-report.mjs so running `node retry-report.mjs` prints exactly `SelfMe:3000`. Keep working until the output is exact."
  });

  const retryReportContent = await readFile(join(workspace, "retry-report.mjs"), "utf8");
  assert.match(retryReportContent, /config\.name/);
  assert.match(retryReportContent, /config\.port/);
  assert.match(repeatedVerificationResult.assistantText, /SelfMe:3000/);
  assert.ok(
    repeatedVerificationResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before repeated verification loop"
  );
  assert.ok(
    repeatedVerificationResult.toolSummaries.filter((summary) => summary.startsWith("node retry-report.mjs · completed")).length >= 2,
    "expected repeated verification attempts before runtime forced a different action"
  );
  assert.ok(
    repeatedVerificationResult.toolSummaries.some((summary) => summary.startsWith("retry-report.mjs:1-2")),
    "expected targeted file read after repeated identical verification"
  );
  assert.ok(
    repeatedVerificationResult.toolSummaries.some((summary) => summary.startsWith("retry-report.mjs:2-2 · updated")),
    "expected retry report repair after repeated identical verification"
  );

  console.log("task: prefer the anchored working file instead of rereading config again");
  const anchoredWorkingFileResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, then repair existing anchored-report.mjs so running `node anchored-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const anchoredReportContent = await readFile(join(workspace, "anchored-report.mjs"), "utf8");
  assert.match(anchoredReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(anchoredWorkingFileResult.assistantText, /SelfMe:3000/);
  assert.equal(
    anchoredWorkingFileResult.toolSummaries.filter((summary) => summary.startsWith("app.config.json:1-4")).length,
    1,
    "expected anchored repair flow to avoid rereading app.config.json once the working file is known"
  );
  assert.ok(
    anchoredWorkingFileResult.toolSummaries.filter((summary) => summary.startsWith("anchored-report.mjs:1-20")).length >= 1,
    "expected anchored repair flow to inspect the working file before tightening it"
  );
  assert.ok(
    anchoredWorkingFileResult.toolSummaries.some((summary) => summary.startsWith("anchored-report.mjs:1-3 · updated")),
    "expected anchored report repair edit"
  );
  assert.ok(
    anchoredWorkingFileResult.toolSummaries.filter((summary) => summary.startsWith("node anchored-report.mjs · completed")).length >= 2,
    "expected anchored report verification before and after repair"
  );

  console.log("task: continue repairing after a failure-only assistant reply");
  const failureRecoveryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix failure-stop-report.mjs so running `node failure-stop-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(failureRecoveryResult.assistantText, /SelfMe:3000/);
  assert.ok(
    failureRecoveryResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before failure recovery task"
  );
  assert.ok(
    failureRecoveryResult.toolSummaries.some((summary) => summary.startsWith("node failure-stop-report.mjs · failed (1)")),
    "expected failed verification before runtime forced continued repair"
  );
  assert.ok(
    failureRecoveryResult.toolSummaries.some((summary) =>
      summary.startsWith("failure-stop-report.mjs:1-2 · updated")
      || summary.startsWith("failure-stop-report.mjs:1-3 · updated")
    ),
    "expected repair edit after failure-only assistant reply"
  );

  console.log("task: keep repairing across a failure and then a near-miss verification");
  const stubbornRecoveryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix stubborn-report.mjs so running `node stubborn-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const stubbornReportContent = await readFile(join(workspace, "stubborn-report.mjs"), "utf8");
  assert.match(stubbornReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(stubbornRecoveryResult.assistantText, /SelfMe:3000/);
  assert.ok(
    stubbornRecoveryResult.toolSummaries.some((summary) => summary.startsWith("node stubborn-report.mjs · failed (1)")),
    "expected stubborn chain to start from a failed verification"
  );
  assert.ok(
    stubbornRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-report.mjs:1-2")),
    "expected stubborn chain file read after the failed verification"
  );
  assert.ok(
    stubbornRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-report.mjs:1-2 · updated")),
    "expected stubborn chain first repair edit"
  );
  assert.ok(
    stubbornRecoveryResult.toolSummaries.filter((summary) => summary.startsWith("node stubborn-report.mjs · completed")).length >= 2,
    "expected stubborn chain to survive a near-miss verification and keep tightening"
  );
  assert.ok(
    stubbornRecoveryResult.toolSummaries.filter((summary) => summary.startsWith("stubborn-report.mjs:1-2 · updated")).length >= 2,
    "expected stubborn chain to perform a second repair after the near-miss output"
  );

  console.log("task: continue after a blocking question on a successful but still inexact verification");
  const stubbornQuestionRecoveryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix stubborn-question-report.mjs so running `node stubborn-question-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const stubbornQuestionReportContent = await readFile(join(workspace, "stubborn-question-report.mjs"), "utf8");
  assert.match(stubbornQuestionReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(stubbornQuestionRecoveryResult.assistantText, /SelfMe:3000/);
  assert.ok(
    stubbornQuestionRecoveryResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before stubborn-question task"
  );
  assert.ok(
    stubbornQuestionRecoveryResult.toolSummaries.filter((summary) => summary.startsWith("node stubborn-question-report.mjs · completed")).length >= 2,
    "expected one inexact successful run plus one final exact verification"
  );
  assert.ok(
    stubbornQuestionRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-question-report.mjs:1-2")),
    "expected targeted file read after the blocking question on inexact output"
  );
  assert.ok(
    stubbornQuestionRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-question-report.mjs:2-2 · updated")),
    "expected edit after the blocking question on inexact output"
  );

  console.log("task: continue after a broad blocking proposal on a successful but still inexact verification");
  const stubbornProposalRecoveryResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix stubborn-proposal-report.mjs so running `node stubborn-proposal-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const stubbornProposalReportContent = await readFile(join(workspace, "stubborn-proposal-report.mjs"), "utf8");
  assert.match(stubbornProposalReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(stubbornProposalRecoveryResult.assistantText, /SelfMe:3000/);
  assert.ok(
    stubbornProposalRecoveryResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before stubborn-proposal task"
  );
  assert.ok(
    stubbornProposalRecoveryResult.toolSummaries.filter((summary) => summary.startsWith("node stubborn-proposal-report.mjs · completed")).length >= 2,
    "expected one inexact successful run plus one final exact verification for broad proposal case"
  );
  assert.ok(
    stubbornProposalRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-proposal-report.mjs:1-2")),
    "expected targeted file read after the broad blocking proposal"
  );
  assert.ok(
    stubbornProposalRecoveryResult.toolSummaries.some((summary) => summary.startsWith("stubborn-proposal-report.mjs:2-2 · updated")),
    "expected edit after the broad blocking proposal"
  );

  console.log("task: continue after an explanation-only assistant reply during execution");
  const executionConvergenceResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix converge-report.mjs so running `node converge-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(executionConvergenceResult.assistantText, /SelfMe:3000/);
  assert.equal(
    executionConvergenceResult.toolSummaries.filter((summary) => summary.startsWith("app.config.json:1-4")).length,
    1,
    "expected execution convergence flow to avoid rereading app.config.json after the working file is known"
  );
  assert.ok(
    executionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before execution convergence task"
  );
  assert.ok(
    executionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("converge-report.mjs:1-3")),
    "expected file read before explanation-only reply"
  );
  assert.ok(
    executionConvergenceResult.toolSummaries.some((summary) =>
      summary.startsWith("converge-report.mjs:1-2 · updated")
      || summary.startsWith("converge-report.mjs:1-3 · updated")
    ),
    "expected repair edit after explanation-only assistant reply"
  );
  assert.ok(
    executionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("node converge-report.mjs · completed")),
    "expected execution convergence flow to return straight to verification after the forced edit"
  );

  console.log("task: continue after a blocking question even though the working file is already known");
  const executionQuestionConvergenceResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix converge-question-report.mjs so running `node converge-question-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const convergeQuestionReportContent = await readFile(join(workspace, "converge-question-report.mjs"), "utf8");
  assert.match(convergeQuestionReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(executionQuestionConvergenceResult.assistantText, /SelfMe:3000/);
  assert.ok(
    executionQuestionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before blocking-question execution task"
  );
  assert.ok(
    executionQuestionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("converge-question-report.mjs:1-3")),
    "expected target file read before the blocking question"
  );
  assert.ok(
    executionQuestionConvergenceResult.toolSummaries.some((summary) =>
      summary.startsWith("converge-question-report.mjs:1-2 · updated")
      || summary.startsWith("converge-question-report.mjs:1-3 · updated")
    ),
    "expected runtime to pull the blocking question back into a concrete edit"
  );
  assert.ok(
    executionQuestionConvergenceResult.toolSummaries.some((summary) => summary.startsWith("node converge-question-report.mjs · completed")),
    "expected blocking-question execution flow to still complete verification"
  );

  console.log("task: continue from a known working file instead of stopping at explanation");
  const workingFileContinuationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix explain-report.mjs so running `node explain-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const explainReportContent = await readFile(join(workspace, "explain-report.mjs"), "utf8");
  assert.match(explainReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(workingFileContinuationResult.assistantText, /SelfMe:3000/);
  assert.equal(
    workingFileContinuationResult.toolSummaries.filter((summary) => summary.startsWith("app.config.json:1-4")).length,
    1,
    "expected working-file continuation flow to avoid rereading app.config.json after the target file is known"
  );
  assert.ok(
    workingFileContinuationResult.toolSummaries.some((summary) => summary.startsWith("explain-report.mjs:1-3")),
    "expected target working file read before explanation-only reply"
  );
  assert.ok(
    workingFileContinuationResult.toolSummaries.some((summary) => summary.startsWith("explain-report.mjs:1-3 · updated")),
    "expected direct repair edit after explanation-only working-file reply"
  );
  assert.ok(
    workingFileContinuationResult.toolSummaries.some((summary) => summary.startsWith("node explain-report.mjs · completed")),
    "expected verification after the forced working-file edit"
  );

  console.log("task: continue project inspection after directory listing");
  const projectInspectionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目"
  });

  assert.match(projectInspectionResult.assistantText, /node-todo/i);
  assert.doesNotMatch(projectInspectionResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    projectInspectionResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected initial workspace listing"
  );
  assert.ok(
    projectInspectionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected project inspection to continue into a concrete project entry"
  );

  console.log("task: inspect a whole project directly from the first user request");
  const directWholeProjectInspectionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "你能一次性都帮我看完整个项目吗"
  });

  assert.match(directWholeProjectInspectionResult.assistantText, /node-todo/i);
  assert.match(directWholeProjectInspectionResult.assistantText, /app\.js/i);
  assert.doesNotMatch(directWholeProjectInspectionResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    directWholeProjectInspectionResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected direct whole-project inspection to start from a workspace listing"
  );
  assert.ok(
    directWholeProjectInspectionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected direct whole-project inspection to read the project entry"
  );
  assert.ok(
    directWholeProjectInspectionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected direct whole-project inspection to continue into a core implementation file"
  );

  console.log("task: continue a broad whole-project follow-up from the recent inspection context");
  const wholeProjectInspectionFollowUpResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "不能一次性都帮我看完了 整个项目"
  });

  assert.match(wholeProjectInspectionFollowUpResult.assistantText, /node-todo/i);
  assert.match(wholeProjectInspectionFollowUpResult.assistantText, /app\.js/i);
  assert.doesNotMatch(wholeProjectInspectionFollowUpResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    wholeProjectInspectionFollowUpResult.toolSummaries.filter((summary) => summary.startsWith("node-todo/package.json:1-13")).length,
    1,
    "expected whole-project follow-up to anchor back to the recent project entry once"
  );
  assert.ok(
    wholeProjectInspectionFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected whole-project follow-up to continue into a core implementation file"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );

  console.log("task: anchor a vague optimization follow-up to the most recently inspected project");
  const vagueOptimizationFollowUpResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "帮我优化下"
  });

  const followUpOptimizedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(followUpOptimizedTodoAppContent, /process\.env\.PORT/);
  assert.match(vagueOptimizationFollowUpResult.assistantText, /process\.env\.PORT/);
  assert.doesNotMatch(vagueOptimizationFollowUpResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    vagueOptimizationFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected vague optimization follow-up to anchor to the recently inspected project entry"
  );
  assert.ok(
    vagueOptimizationFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected vague optimization follow-up to continue into the concrete work file"
  );
  assert.ok(
    vagueOptimizationFollowUpResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected vague optimization follow-up to complete a concrete edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );

  console.log("task: continue broad project improvement from project entry into a concrete work file");
  const broadProjectImprovementResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目然后帮我优化下"
  });

  const broadImprovedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(broadImprovedTodoAppContent, /process\.env\.PORT/);
  assert.match(broadProjectImprovementResult.assistantText, /process\.env\.PORT/);
  assert.ok(
    broadProjectImprovementResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected broad project improvement flow to start from a workspace listing"
  );
  assert.ok(
    broadProjectImprovementResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected broad project improvement flow to inspect a concrete project entry first"
  );
  assert.ok(
    broadProjectImprovementResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected broad project improvement flow to continue from project entry into a concrete work file"
  );
  assert.ok(
    broadProjectImprovementResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected broad project improvement flow to continue into a concrete edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: continue project-driven optimization across multiple concrete files");
  const projectDrivenMultiTargetResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。"
  });

  const projectDrivenMultiTargetAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const projectDrivenMultiTargetViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(projectDrivenMultiTargetAppContent, /process\.env\.PORT/);
  assert.match(projectDrivenMultiTargetViewContent, /maxlength="100"/);
  assert.match(projectDrivenMultiTargetResult.assistantText, /process\.env\.PORT/);
  assert.match(projectDrivenMultiTargetResult.assistantText, /maxlength/i);
  assert.ok(
    projectDrivenMultiTargetResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected project-driven multi-target flow to start from a workspace listing"
  );
  assert.equal(
    projectDrivenMultiTargetResult.toolSummaries.filter((summary) => summary.startsWith("node-todo/package.json:1-13")).length,
    1,
    "expected project-driven multi-target flow to inspect the package entry once"
  );
  assert.ok(
    projectDrivenMultiTargetResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected project-driven multi-target flow to reach app.js first"
  );
  assert.ok(
    projectDrivenMultiTargetResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected project-driven multi-target flow to edit app.js"
  );
  assert.ok(
    projectDrivenMultiTargetResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected project-driven multi-target flow to continue into the view file"
  );
  assert.ok(
    projectDrivenMultiTargetResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected project-driven multi-target flow to edit the view file after app.js"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: pull a blocking question after the first edit in a multi-target project rewrite back into execution");
  const projectDrivenQuestionAfterFirstEditResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。"
  });

  const projectDrivenQuestionAfterFirstEditAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const projectDrivenQuestionAfterFirstEditViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(projectDrivenQuestionAfterFirstEditAppContent, /process\.env\.PORT/);
  assert.match(projectDrivenQuestionAfterFirstEditViewContent, /maxlength="100"/);
  assert.ok(
    projectDrivenQuestionAfterFirstEditResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected multi-target question flow to complete the first edit"
  );
  assert.ok(
    projectDrivenQuestionAfterFirstEditResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected multi-target question flow to continue into the second file after the blocking question"
  );
  assert.ok(
    projectDrivenQuestionAfterFirstEditResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected multi-target question flow to complete the second file after the blocking question"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "description": "Simple todo app",\n  "main": "app.js",\n  "scripts": {\n    "start": "node app.js"\n  },\n  "dependencies": {\n    "ejs": "^3.1.10",\n    "express": "^4.19.2"\n  }\n}\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-setup.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  console.log("task: allow broader multi-file project rewrites to continue beyond six tool steps even without explicit verification");
  const projectDrivenWideRewriteResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，再给 node-todo/package.json 加上 dev script，再把 node-todo/verify-setup.mjs 里的 ready 改成 ready-ok。"
  });

  const wideRewriteAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const wideRewriteViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  const wideRewritePackageContent = await readFile(join(workspace, "node-todo", "package.json"), "utf8");
  const wideRewriteVerifyContent = await readFile(join(workspace, "node-todo", "verify-setup.mjs"), "utf8");
  assert.match(wideRewriteAppContent, /process\.env\.PORT/);
  assert.match(wideRewriteViewContent, /maxlength="100"/);
  assert.match(wideRewritePackageContent, /"dev": "node app\.js"/);
  assert.match(wideRewriteVerifyContent, /console\.log\("ready-ok"\)/);
  assert.match(projectDrivenWideRewriteResult.assistantText, /ready-ok|verify-setup\.mjs/i);
  assert.ok(
    projectDrivenWideRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:5-7 · updated")),
    "expected wider multi-file rewrite to still reach package.json"
  );
  assert.ok(
    projectDrivenWideRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-setup.mjs:1-13")),
    "expected wider multi-file rewrite to continue into the fourth concrete file"
  );
  assert.ok(
    projectDrivenWideRewriteResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-setup.mjs:7-7 · updated")),
    "expected wider multi-file rewrite to complete the fourth concrete edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: continue project-driven optimization through verification before final completion");
  const projectDrivenVerificationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。"
  });

  const projectDrivenVerifiedAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const projectDrivenVerifiedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(projectDrivenVerifiedAppContent, /process\.env\.PORT/);
  assert.match(projectDrivenVerifiedViewContent, /maxlength="100"/);
  assert.match(projectDrivenVerificationResult.assistantText, /ready/);
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.some((summary) => summary.startsWith("pwd && ls -la && find . -maxdepth 2 -type f")),
    "expected project-driven verification flow to start from a workspace listing"
  );
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    "expected project-driven verification flow to inspect the package entry"
  );
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected project-driven verification flow to edit app.js"
  );
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.filter((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")).length >= 2,
    "expected project-driven verification flow to verify before and after the second file edit"
  );
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected project-driven verification flow to continue into the second file after the first verification near-miss"
  );
  assert.ok(
    projectDrivenVerificationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected project-driven verification flow to finish the second file before final verification"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: pull a blocking question in a project verification chain back into execution even without a direct-execution cue");
  const projectVerificationQuestionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。"
  });

  const projectVerificationQuestionAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const projectVerificationQuestionViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(projectVerificationQuestionAppContent, /process\.env\.PORT/);
  assert.match(projectVerificationQuestionViewContent, /maxlength="100"/);
  assert.match(projectVerificationQuestionResult.assistantText, /ready/);
  assert.ok(
    projectVerificationQuestionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected project verification question flow to continue into the pending view file after the blocking question"
  );
  assert.ok(
    projectVerificationQuestionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected project verification question flow to complete the pending view edit"
  );
  assert.ok(
    projectVerificationQuestionResult.toolSummaries.filter((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")).length >= 2,
    "expected project verification question flow to rerun verification after the resumed edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-exact.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready!");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  console.log("task: follow the latest failure point when final exact verification shifts into the verifier itself");
  const projectDrivenVerifierShiftResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-exact.mjs` 验证，直到输出 exactly `ready`。"
  });

  const projectDrivenVerifierShiftAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const projectDrivenVerifierShiftViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  const projectDrivenVerifierShiftVerifyContent = await readFile(join(workspace, "node-todo", "verify-exact.mjs"), "utf8");
  assert.match(projectDrivenVerifierShiftAppContent, /process\.env\.PORT/);
  assert.match(projectDrivenVerifierShiftViewContent, /maxlength="100"/);
  assert.match(projectDrivenVerifierShiftVerifyContent, /console\.log\("ready"\)/);
  assert.match(projectDrivenVerifierShiftResult.assistantText, /ready/);
  assert.ok(
    projectDrivenVerifierShiftResult.toolSummaries.filter((summary) => summary.startsWith("node node-todo/verify-exact.mjs · completed")).length >= 3,
    "expected verifier-shift flow to verify after app.js, after views/index.ejs, and after repairing the verifier"
  );
  assert.ok(
    projectDrivenVerifierShiftResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected verifier-shift flow to finish the second requested file before chasing the verifier"
  );
  assert.ok(
    projectDrivenVerifierShiftResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-exact.mjs:1-14")),
    "expected verifier-shift flow to inspect the verifier after the near-miss exact output"
  );
  assert.ok(
    projectDrivenVerifierShiftResult.toolSummaries.some((summary) => summary.startsWith("node-todo/verify-exact.mjs:7-7 · updated")),
    "expected verifier-shift flow to repair the verifier as the latest failure point"
  );

  console.log("task: prefer the recent editable working file for a vague optimization follow-up");
  const recentWorkingFileOptimizationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "帮我优化下"
  });

  const recentWorkingFileOptimizedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(recentWorkingFileOptimizedTodoAppContent, /process\.env\.PORT/);
  assert.match(recentWorkingFileOptimizationResult.assistantText, /process\.env\.PORT/);
  assert.equal(
    recentWorkingFileOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    false,
    "expected recent-working-file optimization follow-up to skip re-reading the package entry"
  );
  assert.ok(
    recentWorkingFileOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected recent-working-file optimization follow-up to jump straight to the latest editable working file"
  );
  assert.ok(
    recentWorkingFileOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected recent-working-file optimization follow-up to complete a concrete edit"
  );

  console.log("task: prefer the recent editable working file for a vague inspection follow-up");
  const recentWorkingFileInspectionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "帮我看看"
  });

  assert.match(recentWorkingFileInspectionResult.assistantText, /node-todo\/app\.js|process\.env\.PORT|端口/i);
  assert.equal(
    recentWorkingFileInspectionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-13")),
    false,
    "expected vague inspection follow-up to skip re-reading the package entry"
  );
  assert.ok(
    recentWorkingFileInspectionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected vague inspection follow-up to jump straight to the latest editable working file"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );

  console.log("task: continue optimization work after initial file inspection");
  const optimizationContinuationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read node-todo/app.js and improve it by making the port configuration use process.env.PORT. Do the change directly."
  });

  const optimizedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(optimizedTodoAppContent, /process\.env\.PORT/);
  assert.match(optimizationContinuationResult.assistantText, /process\.env\.PORT/);
  assert.ok(
    optimizationContinuationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected initial file inspection before optimization"
  );
  assert.ok(
    optimizationContinuationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected optimization task to continue into an edit instead of stopping at a suggestion"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );

  console.log("task: continue after an explanation-only reply for a non-verify mutation task");
  const explanationOnlyOptimizationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly."
  });

  const refactoredTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(refactoredTodoAppContent, /process\.env\.PORT/);
  assert.match(explanationOnlyOptimizationResult.assistantText, /process\.env\.PORT/);
  assert.ok(
    explanationOnlyOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected file inspection before non-verify mutation refactor"
  );
  assert.ok(
    explanationOnlyOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected explanation-only optimization reply to be pulled forward into a concrete edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: continue explicit multi-target optimization after a completion-sounding first edit reply");
  const prematureMultiTargetCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly, and do not stop after only one file."
  });

  const prematureMultiTargetAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const prematureMultiTargetViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(prematureMultiTargetAppContent, /process\.env\.PORT/);
  assert.match(prematureMultiTargetViewContent, /maxlength="100"/);
  assert.match(prematureMultiTargetCompletionResult.assistantText, /process\.env\.PORT/);
  assert.match(prematureMultiTargetCompletionResult.assistantText, /maxlength/i);
  assert.ok(
    prematureMultiTargetCompletionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected premature multi-target completion flow to edit app.js first"
  );
  assert.ok(
    prematureMultiTargetCompletionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected premature multi-target completion flow to continue into the second explicit file"
  );
  assert.ok(
    prematureMultiTargetCompletionResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected premature multi-target completion flow to finish the second explicit edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: continue explicit multi-target optimization after the first successful edit");
  const multiTargetOptimizationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly."
  });

  const multiTargetAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const multiTargetViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(multiTargetAppContent, /process\.env\.PORT/);
  assert.match(multiTargetViewContent, /maxlength="100"/);
  assert.match(multiTargetOptimizationResult.assistantText, /process\.env\.PORT/);
  assert.match(multiTargetOptimizationResult.assistantText, /maxlength/i);
  assert.ok(
    multiTargetOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected multi-target optimization to inspect app.js first"
  );
  assert.ok(
    multiTargetOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected multi-target optimization to update app.js"
  );
  assert.ok(
    multiTargetOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "expected multi-target optimization to continue into the template file"
  );
  assert.ok(
    multiTargetOptimizationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "expected multi-target optimization to edit the template after the first successful edit"
  );

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );

  console.log("task: continue after an unnecessary confirmation question on a direct mutation task");
  const unnecessaryConfirmationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly and do not ask for confirmation first."
  });

  const confirmedTodoAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  assert.match(confirmedTodoAppContent, /process\.env\.PORT/);
  assert.match(unnecessaryConfirmationResult.assistantText, /process\.env\.PORT/);
  assert.ok(
    unnecessaryConfirmationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-20")),
    "expected file inspection before unnecessary-confirmation recovery"
  );
  assert.ok(
    unnecessaryConfirmationResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:3-3 · updated")),
    "expected direct mutation task to continue into an edit instead of stopping at a confirmation question"
  );

  console.log("task: continue after a completion-sounding reply before verification");
  const prematureEditCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix premature-edit-report.mjs so running `node premature-edit-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(prematureEditCompletionResult.assistantText, /SelfMe:3000/);
  assert.ok(
    prematureEditCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before premature edit completion task"
  );
  assert.ok(
    prematureEditCompletionResult.toolSummaries.some((summary) => summary.startsWith("premature-edit-report.mjs:1-2")),
    "expected target file read before edit"
  );
  assert.ok(
    prematureEditCompletionResult.toolSummaries.some((summary) => summary.startsWith("premature-edit-report.mjs:2-2 · updated")),
    "expected edit before completion-sounding reply"
  );
  assert.ok(
    prematureEditCompletionResult.toolSummaries.some((summary) => summary.startsWith("node premature-edit-report.mjs · completed")),
    "expected verification to continue after completion-sounding reply"
  );

  console.log("task: tighten a vague final reply after the task is actually complete");
  const vagueCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix vague-finish-report.mjs so running `node vague-finish-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(vagueCompletionResult.assistantText, /SelfMe:3000/);
  assert.ok(
    vagueCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before vague completion task"
  );
  assert.ok(
    vagueCompletionResult.toolSummaries.some((summary) => summary.startsWith("vague-finish-report.mjs:1-2")),
    "expected file read before vague completion task"
  );
  assert.ok(
    vagueCompletionResult.toolSummaries.some((summary) => summary.startsWith("vague-finish-report.mjs:2-2 · updated")),
    "expected repair edit before vague completion reply"
  );
  assert.ok(
    vagueCompletionResult.toolSummaries.some((summary) => summary.startsWith("node vague-finish-report.mjs · completed")),
    "expected successful verification before vague completion reply"
  );

  console.log("task: tighten a blocking-question final reply after the task is actually complete");
  const questionCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix question-finish-report.mjs so running `node question-finish-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(questionCompletionResult.assistantText, /SelfMe:3000/);
  assert.doesNotMatch(questionCompletionResult.assistantText, /\?\s*$/);
  assert.ok(
    questionCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before question completion task"
  );
  assert.ok(
    questionCompletionResult.toolSummaries.some((summary) => summary.startsWith("question-finish-report.mjs:1-2")),
    "expected file read before question completion task"
  );
  assert.ok(
    questionCompletionResult.toolSummaries.some((summary) => summary.startsWith("question-finish-report.mjs:2-2 · updated")),
    "expected repair edit before question completion reply"
  );
  assert.ok(
    questionCompletionResult.toolSummaries.some((summary) => summary.startsWith("node question-finish-report.mjs · completed")),
    "expected successful verification before question completion reply"
  );

  console.log("task: tighten a process-heavy final reply after the task is actually complete");
  const historyHeavyCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix history-heavy-report.mjs so running `node history-heavy-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(historyHeavyCompletionResult.assistantText, /SelfMe:3000/);
  assert.ok(historyHeavyCompletionResult.assistantText.length < 160, "expected tightened completion reply to stay short");
  assert.doesNotMatch(historyHeavyCompletionResult.assistantText, /\b(first|then|earlier|failed|wrong)\b/i);
  assert.ok(
    historyHeavyCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before history-heavy completion task"
  );
  assert.ok(
    historyHeavyCompletionResult.toolSummaries.some((summary) => summary.startsWith("history-heavy-report.mjs:1-2")),
    "expected file read before history-heavy completion task"
  );
  assert.ok(
    historyHeavyCompletionResult.toolSummaries.some((summary) => summary.startsWith("history-heavy-report.mjs:2-2 · updated")),
    "expected repair edit before history-heavy completion reply"
  );
  assert.ok(
    historyHeavyCompletionResult.toolSummaries.some((summary) => summary.startsWith("node history-heavy-report.mjs · completed")),
    "expected successful verification before history-heavy completion reply"
  );

  console.log("task: tighten a short failure-recap final reply after the task is actually complete");
  const failureRecapCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix failure-recap-report.mjs so running `node failure-recap-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(failureRecapCompletionResult.assistantText, /SelfMe:3000/);
  assert.ok(failureRecapCompletionResult.assistantText.length < 140, "expected tightened failure-recap reply to stay short");
  assert.doesNotMatch(failureRecapCompletionResult.assistantText, /\b(earlier|failed|wrong|before)\b/i);
  assert.ok(
    failureRecapCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before failure-recap completion task"
  );
  assert.ok(
    failureRecapCompletionResult.toolSummaries.some((summary) => summary.startsWith("failure-recap-report.mjs:1-2")),
    "expected file read before failure-recap completion task"
  );
  assert.ok(
    failureRecapCompletionResult.toolSummaries.some((summary) => summary.startsWith("failure-recap-report.mjs:2-2 · updated")),
    "expected repair edit before failure-recap completion reply"
  );
  assert.ok(
    failureRecapCompletionResult.toolSummaries.some((summary) => summary.startsWith("node failure-recap-report.mjs · completed")),
    "expected successful verification before failure-recap completion reply"
  );

  console.log("task: tighten a final reply that drifts back to an unrelated old file");
  const unrelatedAnchorCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix unrelated-anchor-report.mjs so running `node unrelated-anchor-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  assert.match(unrelatedAnchorCompletionResult.assistantText, /SelfMe:3000/);
  assert.doesNotMatch(unrelatedAnchorCompletionResult.assistantText, /serve\.mjs/i);
  assert.ok(
    unrelatedAnchorCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before unrelated-anchor completion task"
  );
  assert.ok(
    unrelatedAnchorCompletionResult.toolSummaries.some((summary) => summary.startsWith("unrelated-anchor-report.mjs:1-2")),
    "expected file read before unrelated-anchor completion task"
  );
  assert.ok(
    unrelatedAnchorCompletionResult.toolSummaries.some((summary) => summary.startsWith("unrelated-anchor-report.mjs:2-2 · updated")),
    "expected repair edit before unrelated-anchor completion reply"
  );
  assert.ok(
    unrelatedAnchorCompletionResult.toolSummaries.some((summary) => summary.startsWith("node unrelated-anchor-report.mjs · completed")),
    "expected successful verification before unrelated-anchor completion reply"
  );

  console.log("task: refuse extra tool execution after the task is already complete");
  const overVerifyCompletionResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix over-verify-report.mjs so running `node over-verify-report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const overVerifyReportContent = await readFile(join(workspace, "over-verify-report.mjs"), "utf8");
  assert.match(overVerifyReportContent, /config\.name:\$\{config\.port\}/);
  assert.match(overVerifyCompletionResult.assistantText, /SelfMe:3000/);
  assert.ok(
    overVerifyCompletionResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read before over-verify completion task"
  );
  assert.ok(
    overVerifyCompletionResult.toolSummaries.some((summary) => summary.startsWith("over-verify-report.mjs:1-2")),
    "expected file read before over-verify completion task"
  );
  assert.ok(
    overVerifyCompletionResult.toolSummaries.some((summary) => summary.startsWith("over-verify-report.mjs:1-2 · updated")),
    "expected repair edit before terminal completion"
  );
  assert.equal(
    overVerifyCompletionResult.toolSummaries.filter((summary) => summary.startsWith("node over-verify-report.mjs · completed")).length,
    1,
    "expected runtime to suppress the extra post-success verification tool call"
  );

  console.log("task: debug existing program from shell failure");
  const shellFirstDebugResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run `node src/healthcheck.mjs`, fix the existing files so it prints exactly `SelfMe:3000`, and keep verifying until it is correct."
  });

  const renderHealthContent = await readFile(join(workspace, "src", "lib", "render-health.mjs"), "utf8");
  const healthcheckContent = await readFile(join(workspace, "src", "healthcheck.mjs"), "utf8");
  assert.match(renderHealthContent, /export function renderHealth/);
  assert.match(renderHealthContent, /config\.name\}:\$\{config\.port/);
  assert.match(healthcheckContent, /renderHealth/);
  assert.match(shellFirstDebugResult.assistantText, /SelfMe:3000/);
  assert.ok(
    shellFirstDebugResult.toolSummaries.some((summary) => summary.startsWith("node src/healthcheck.mjs · failed (1)")),
    "expected initial shell-first failure"
  );
  assert.ok(
    shellFirstDebugResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-health.mjs:1-3")),
    "expected helper file read during debugging"
  );
  assert.ok(
    shellFirstDebugResult.toolSummaries.some((summary) =>
      summary.startsWith("src/lib/render-health.mjs:1-2 · updated")
      || summary.startsWith("src/lib/render-health.mjs:2-2 · updated")
    ),
    "expected helper file edit during debugging"
  );
  assert.ok(
    shellFirstDebugResult.toolSummaries.filter((summary) => summary.startsWith("node src/healthcheck.mjs · completed")).length >= 2,
    "expected repeated verification while tightening final output"
  );

  console.log("task: extend task-scoped approval to discovered helper files");
  const approvalsBeforeBridgeChain = approvals.length;
  const bridgeHelperChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run `node src/bridge.mjs`, fix the existing files so it prints exactly `SelfMe:ready`, and keep verifying until it is correct."
  });

  const bridgeContent = await readFile(join(workspace, "src", "bridge.mjs"), "utf8");
  const bridgeHelperContent = await readFile(join(workspace, "src", "bridge-helper.mjs"), "utf8");
  assert.match(bridgeContent, /bridge-helper\.mjs/);
  assert.match(bridgeHelperContent, /return ":ready"/);
  assert.match(bridgeHelperChainResult.assistantText, /SelfMe:ready/);
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("node src/bridge.mjs · failed (1)")),
    "expected initial bridge failure"
  );
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge.mjs:1-2")),
    "expected bridge file read"
  );
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge.mjs:1-1 · updated")),
    "expected bridge import fix"
  );
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge-helper.mjs:1-3")),
    "expected helper file read after bridge rerun"
  );
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge-helper.mjs:2-2 · updated")),
    "expected helper file edit"
  );
  assert.ok(
    bridgeHelperChainResult.toolSummaries.some((summary) => summary.startsWith("node src/bridge.mjs · completed")),
    "expected successful bridge verification"
  );
  assert.equal(
    approvals.length - approvalsBeforeBridgeChain,
    1,
    "expected one approval to cover requested file and later discovered helper file in the same task"
  );

  console.log("task: follow the latest failure point instead of going back to the earlier one");
  const bridgeSwitchChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run `node src/bridge-switch.mjs`, fix the existing files so it prints exactly `SelfMe:ready`, and keep verifying until it is correct."
  });

  const bridgeSwitchContent = await readFile(join(workspace, "src", "bridge-switch.mjs"), "utf8");
  const bridgeSwitchHelperContent = await readFile(join(workspace, "src", "bridge-switch-helper.mjs"), "utf8");
  assert.match(bridgeSwitchContent, /bridge-switch-helper\.mjs/);
  assert.match(bridgeSwitchHelperContent, /export function bridgeStatus/);
  assert.match(bridgeSwitchHelperContent, /return ":ready"/);
  assert.match(bridgeSwitchChainResult.assistantText, /SelfMe:ready/);
  assert.ok(
    bridgeSwitchChainResult.toolSummaries.some((summary) => summary.startsWith("node src/bridge-switch.mjs · failed (1)")),
    "expected bridge-switch initial failure"
  );
  assert.equal(
    bridgeSwitchChainResult.toolSummaries.filter((summary) => summary.startsWith("src/bridge-switch.mjs:1-2")).length,
    1,
    "expected bridge-switch main file to be read once at the earlier failure point"
  );
  assert.ok(
    bridgeSwitchChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge-switch.mjs:1-1 · updated")),
    "expected bridge-switch import repair"
  );
  assert.ok(
    bridgeSwitchChainResult.toolSummaries.some((summary) => summary.startsWith("src/bridge-switch-helper.mjs:1-3")),
    "expected bridge-switch helper read after the newer failure point"
  );
  assert.ok(
    bridgeSwitchChainResult.toolSummaries.filter((summary) => summary.startsWith("src/bridge-switch-helper.mjs:1-2 · updated")).length >= 2,
    "expected bridge-switch helper to be repaired twice after newer failure and near-miss output"
  );
  assert.ok(
    bridgeSwitchChainResult.toolSummaries.filter((summary) => summary.startsWith("node src/bridge-switch.mjs · completed")).length >= 2,
    "expected bridge-switch chain to keep verifying after the helper became the latest failure point"
  );

  console.log("task: repair broken import path from shell failure");
  const importPathRepairResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run `node src/preview.mjs`, repair the existing file so it prints exactly `SelfMe local`, and verify it before finishing."
  });

  const previewContent = await readFile(join(workspace, "src", "preview.mjs"), "utf8");
  assert.match(previewContent, /\.\.\/config\/theme\.json/);
  assert.match(importPathRepairResult.assistantText, /SelfMe local/);
  assert.ok(
    importPathRepairResult.toolSummaries.some((summary) => summary.startsWith("node src/preview.mjs · failed (1)")),
    "expected initial preview shell failure"
  );
  assert.ok(
    importPathRepairResult.toolSummaries.some((summary) => summary.startsWith("src/preview.mjs:1-2")),
    "expected preview file read during import repair"
  );
  assert.ok(
    importPathRepairResult.toolSummaries.some((summary) => summary.startsWith("src/preview.mjs:1-1 · updated")),
    "expected preview import-line edit"
  );
  assert.ok(
    importPathRepairResult.toolSummaries.some((summary) => summary.startsWith("node src/preview.mjs · completed")),
    "expected successful preview verification"
  );

  console.log("task: complete chinese exact-output repair chain");
  const chineseChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "读取 app.config.json，然后修复 serve.mjs，让运行 `node serve.mjs` 精确输出 `SelfMe running on 3000`。验证并在有问题时继续修好。"
  });

  const serveContent = await readFile(join(workspace, "serve.mjs"), "utf8");
  assert.match(serveContent, /app\.config\.json/);
  assert.match(serveContent, /running on/);
  assert.match(chineseChainResult.assistantText, /已修复|修好/);
  assert.match(chineseChainResult.assistantText, /SelfMe running on 3000/);
  assert.ok(
    chineseChainResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config file read in chinese chain"
  );
  assert.ok(
    chineseChainResult.toolSummaries.some((summary) => summary.startsWith("serve.mjs:1-2")),
    "expected target script read in chinese chain"
  );
  assert.ok(
    chineseChainResult.toolSummaries.some((summary) => summary.startsWith("serve.mjs:1-2 · updated")),
    "expected first script repair in chinese chain"
  );
  assert.ok(
    chineseChainResult.toolSummaries.filter((summary) => summary.startsWith("node serve.mjs · completed")).length >= 2,
    "expected two successful shell verifications in chinese chain"
  );

  console.log("task: tighten successful but noisy output");
  const noisyOutputChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json and fix report.mjs so running `node report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const reportContent = await readFile(join(workspace, "report.mjs"), "utf8");
  assert.match(reportContent, /app\.config\.json/);
  assert.match(reportContent, /config\.name/);
  assert.match(reportContent, /config\.port/);
  assert.match(noisyOutputChainResult.assistantText, /SelfMe:3000/);
  assert.ok(
    noisyOutputChainResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read in noisy-output chain"
  );
  assert.ok(
    noisyOutputChainResult.toolSummaries.some((summary) => summary.startsWith("report.mjs:1-3")),
    "expected existing report file read"
  );
  assert.ok(
    noisyOutputChainResult.toolSummaries.some((summary) => summary.startsWith("report.mjs:1-3 · updated")),
    "expected report file edit"
  );
  assert.ok(
    noisyOutputChainResult.toolSummaries.filter((summary) => summary.startsWith("node report.mjs · completed")).length >= 2,
    "expected multiple successful shell checks while tightening exact output"
  );

  console.log("task: continue on latest verification command instead of repeating warmup");
  await writeFile(
    join(workspace, "report.mjs"),
    'import config from "./app.config.json" with { type: "json" };\nconsole.log(`name=${config.name}`);\nconsole.log(`port=${config.port}`);\n',
    "utf8"
  );
  const multiCommandVerificationResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run `node smoke-a.mjs`, then fix report.mjs so running `node report.mjs` prints exactly `SelfMe:3000` on one line. Keep working until the output is exact."
  });

  const warmedReportContent = await readFile(join(workspace, "report.mjs"), "utf8");
  assert.match(warmedReportContent, /console\.log\(`\$\{config\.name\}:\$\{config\.port\}`\);/);
  assert.match(multiCommandVerificationResult.assistantText, /SelfMe:3000/);
  assert.equal(
    multiCommandVerificationResult.toolSummaries.filter((summary) => summary.startsWith("node smoke-a.mjs · completed")).length,
    1,
    "expected warmup command to run only once"
  );
  assert.ok(
    multiCommandVerificationResult.toolSummaries.filter((summary) => summary.startsWith("node report.mjs · completed")).length >= 2,
    "expected repeated target verification after warmup"
  );
  assert.ok(
    multiCommandVerificationResult.toolSummaries.some((summary) => summary.startsWith("report.mjs:1-3")),
    "expected targeted report read during repair"
  );
  assert.ok(
    multiCommandVerificationResult.toolSummaries.some((summary) => summary.startsWith("report.mjs:1-3 · updated")),
    "expected report edit during repair"
  );
  assert.ok(
    multiCommandVerificationResult.toolSummaries.some((summary) => summary.startsWith("node report.mjs · completed")),
    "expected successful final report verification"
  );

  console.log("task: repair existing file from two source files");
  const existingFileChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Use app.config.json and numbers.txt to repair existing dashboard.mjs so running `node dashboard.mjs` prints exactly `SelfMe:3000 total=15` on one line. Verify it and keep fixing until exact."
  });

  const dashboardContent = await readFile(join(workspace, "dashboard.mjs"), "utf8");
  assert.match(dashboardContent, /config\.port/);
  assert.match(dashboardContent, /total=/);
  assert.match(existingFileChainResult.assistantText, /SelfMe:3000 total=15/);
  assert.ok(
    existingFileChainResult.toolSummaries.some((summary) => summary.startsWith("app.config.json:1-4")),
    "expected config read in existing-file chain"
  );
  assert.ok(
    existingFileChainResult.toolSummaries.some((summary) => summary.startsWith("numbers.txt:1-3")),
    "expected numbers file read in existing-file chain"
  );
  assert.ok(
    existingFileChainResult.toolSummaries.some((summary) => summary.startsWith("dashboard.mjs:1-4")),
    "expected dashboard file read in existing-file chain"
  );
  assert.ok(
    existingFileChainResult.toolSummaries.some((summary) => summary.startsWith("dashboard.mjs:4-4 · updated")),
    "expected dashboard line edit in existing-file chain"
  );
  assert.ok(
    existingFileChainResult.toolSummaries.filter((summary) => summary.startsWith("node dashboard.mjs · completed")).length >= 2,
    "expected repeated successful shell checks while tightening dashboard output"
  );

  console.log("task: repair nested project file with semantic tightening");
  const nestedProjectRepairResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/theme.json and repair existing src/banner.mjs so running `node src/banner.mjs` prints exactly `SelfMe local`. Verify it and keep fixing until exact."
  });

  const bannerContent = await readFile(join(workspace, "src", "banner.mjs"), "utf8");
  assert.match(bannerContent, /config\/theme\.json/);
  assert.match(bannerContent, /theme\.name\} \$\{theme\.env/);
  assert.match(nestedProjectRepairResult.assistantText, /SelfMe local/);
  assert.ok(
    nestedProjectRepairResult.toolSummaries.some((summary) => summary.startsWith("config/theme.json:1-4")),
    "expected nested config file read"
  );
  assert.ok(
    nestedProjectRepairResult.toolSummaries.some((summary) => summary.startsWith("src/banner.mjs:1-2")),
    "expected existing nested script read"
  );
  assert.ok(
    nestedProjectRepairResult.toolSummaries.filter((summary) => summary.startsWith("src/banner.mjs:1-2 · updated")).length >= 2,
    "expected two edits while tightening nested script output"
  );
  assert.ok(
    nestedProjectRepairResult.toolSummaries.filter((summary) => summary.startsWith("node src/banner.mjs · completed")).length >= 2,
    "expected multiple successful shell verifications while tightening nested script output"
  );

  console.log("task: create nested helper and repair existing import chain");
  const nestedHelperChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/profile.json, then create src/lib/render-label.mjs and repair existing src/runner.mjs so running `node src/runner.mjs` prints exactly `SelfMe [local]`. Verify it and keep fixing until exact."
  });

  const renderLabelContent = await readFile(join(workspace, "src", "lib", "render-label.mjs"), "utf8");
  const runnerContent = await readFile(join(workspace, "src", "runner.mjs"), "utf8");
  assert.match(renderLabelContent, /profile\.product\} \[\$\{profile\.channel\}\]/);
  assert.match(runnerContent, /\.\/lib\/render-label\.mjs/);
  assert.match(nestedHelperChainResult.assistantText, /SelfMe \[local\]/);
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("config/profile.json:1-4")),
    "expected profile config read"
  );
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-label.mjs · created")),
    "expected helper module creation"
  );
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("node src/runner.mjs · failed (1)")),
    "expected failed verification before runner repair"
  );
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/runner.mjs:1-3")),
    "expected runner file read during repair"
  );
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("src/runner.mjs:2-2 · updated")),
    "expected runner import-line edit"
  );
  assert.ok(
    nestedHelperChainResult.toolSummaries.some((summary) => summary.startsWith("node src/runner.mjs · completed")),
    "expected successful nested runner verification"
  );

  console.log("task: repair two existing files from one config source");
  const dualExistingFileChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/runtime.json and repair existing src/lib/format-runtime.mjs plus src/console.mjs so running `node src/console.mjs` prints exactly `SelfMe dev (cn)`. Verify it before finishing."
  });

  const formatRuntimeContent = await readFile(join(workspace, "src", "lib", "format-runtime.mjs"), "utf8");
  const consoleContent = await readFile(join(workspace, "src", "console.mjs"), "utf8");
  assert.match(formatRuntimeContent, /runtime\.product\} \$\{runtime\.stage\} \(\$\{runtime\.region\}\)/);
  assert.match(consoleContent, /\.\/lib\/format-runtime\.mjs/);
  assert.match(dualExistingFileChainResult.assistantText, /SelfMe dev \(cn\)/);
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => /^config\/runtime\.json:1-\d+$/.test(summary)),
    "expected runtime config read"
  );
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => summary.startsWith("src/console.mjs:1-3")),
    "expected console file read"
  );
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/format-runtime.mjs:1-3")),
    "expected helper file read"
  );
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/format-runtime.mjs:2-2 · updated")),
    "expected helper line edit"
  );
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => summary.startsWith("src/console.mjs:2-2 · updated")),
    "expected console import-line edit"
  );
  assert.ok(
    dualExistingFileChainResult.toolSummaries.some((summary) => summary.startsWith("node src/console.mjs · completed")),
    "expected successful console verification"
  );

  console.log("task: keep working across two known files instead of stopping after each explanation");
  const dualExistingExplanationChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/runtime.json and repair existing src/lib/format-runtime-explain.mjs plus src/console-explain.mjs so running `node src/console-explain.mjs` prints exactly `SelfMe dev (cn)`. Verify it before finishing."
  });

  const formatRuntimeExplainContent = await readFile(join(workspace, "src", "lib", "format-runtime-explain.mjs"), "utf8");
  const consoleExplainContent = await readFile(join(workspace, "src", "console-explain.mjs"), "utf8");
  assert.match(formatRuntimeExplainContent, /runtime\.product\} \$\{runtime\.stage\} \(\$\{runtime\.region\}\)/);
  assert.match(consoleExplainContent, /\.\/lib\/format-runtime-explain\.mjs/);
  assert.match(dualExistingExplanationChainResult.assistantText, /SelfMe dev \(cn\)/);
  assert.deepEqual(dualExistingExplanationChainResult.assistantTurns, [
    "Repaired src/lib/format-runtime-explain.mjs and src/console-explain.mjs, then confirmed the script prints exactly SelfMe dev (cn)."
  ]);
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => /^config\/runtime\.json:1-\d+$/.test(summary)),
    "expected runtime config read in dual explanation chain"
  );
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => summary.startsWith("src/console-explain.mjs:1-3")),
    "expected console-explain file read"
  );
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/format-runtime-explain.mjs:1-3")),
    "expected helper explain file read"
  );
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/format-runtime-explain.mjs:2-2 · updated")),
    "expected helper explain edit"
  );
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => summary.startsWith("src/console-explain.mjs:2-2 · updated")),
    "expected console-explain import edit"
  );
  assert.ok(
    dualExistingExplanationChainResult.toolSummaries.some((summary) => summary.startsWith("node src/console-explain.mjs · completed")),
    "expected console-explain verification"
  );

  console.log("task: keep repairing after an early successful verification that is still not exact");
  const serviceStubbornChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/service.json and repair existing src/lib/render-service-stubborn.mjs plus src/service-stubborn.mjs so running `node src/service-stubborn.mjs` prints exactly `SelfMe api@v1`. Verify it and keep fixing until exact."
  });

  const renderServiceStubbornContent = await readFile(join(workspace, "src", "lib", "render-service-stubborn.mjs"), "utf8");
  const serviceStubbornContent = await readFile(join(workspace, "src", "service-stubborn.mjs"), "utf8");
  assert.match(renderServiceStubbornContent, /service\.name\} \$\{service\.surface\}@\$\{service\.version\}/);
  assert.match(serviceStubbornContent, /\.\/lib\/render-service-stubborn\.mjs/);
  assert.match(serviceStubbornChainResult.assistantText, /SelfMe api@v1/);
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => /^config\/service\.json:1-\d+$/.test(summary)),
    "expected service config read in stubborn chain"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => summary.startsWith("src/service-stubborn.mjs:1-3")),
    "expected stubborn entry file read"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => summary.startsWith("src/service-stubborn.mjs:2-2 · updated")),
    "expected stubborn entry import repair"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => summary.startsWith("node src/service-stubborn.mjs · completed")),
    "expected stubborn chain to reach a successful but still inexact verification"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-service-stubborn.mjs:1-3")),
    "expected stubborn helper file read after the near-miss verification"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-service-stubborn.mjs:2-2 · updated")),
    "expected stubborn helper repair after the near-miss verification"
  );
  assert.ok(
    serviceStubbornChainResult.toolSummaries.filter((summary) => summary.startsWith("node src/service-stubborn.mjs · completed")).length >= 2,
    "expected stubborn service chain to keep verifying until the exact output is reached"
  );

  console.log("task: create helper and repair existing file from config source");
  const createAndRepairChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/service.json, then create src/lib/render-service.mjs and repair existing src/service.mjs so running `node src/service.mjs` prints exactly `SelfMe api@v1`. Verify it before finishing."
  });

  const renderServiceContent = await readFile(join(workspace, "src", "lib", "render-service.mjs"), "utf8");
  const serviceContent = await readFile(join(workspace, "src", "service.mjs"), "utf8");
  assert.match(renderServiceContent, /service\.name\} \$\{service\.surface\}@\$\{service\.version\}/);
  assert.match(serviceContent, /\.\/lib\/render-service\.mjs/);
  assert.match(createAndRepairChainResult.assistantText, /SelfMe api@v1/);
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => /^config\/service\.json:1-\d+$/.test(summary)),
    "expected service config read"
  );
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/lib/render-service.mjs · created")),
    "expected service helper creation"
  );
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => summary.startsWith("node src/service.mjs · failed (1)")),
    "expected failed verification before service file repair"
  );
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/service.mjs:1-3")),
    "expected service file read during repair"
  );
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/service.mjs:2-2 · updated")),
    "expected service import-line edit"
  );
  assert.ok(
    createAndRepairChainResult.toolSummaries.some((summary) => summary.startsWith("node src/service.mjs · completed")),
    "expected successful service verification"
  );

  console.log("task: create shared helper and repair nested api entry");
  const nestedApiChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/endpoint.json, then create src/shared/render-endpoint.mjs and repair existing src/api/serve-endpoint.mjs so running `node src/api/serve-endpoint.mjs` prints exactly `SelfMe http://127.0.0.1:3000`. Verify it before finishing."
  });

  const renderEndpointContent = await readFile(join(workspace, "src", "shared", "render-endpoint.mjs"), "utf8");
  const serveEndpointContent = await readFile(join(workspace, "src", "api", "serve-endpoint.mjs"), "utf8");
  assert.match(renderEndpointContent, /service|endpoint/);
  assert.match(renderEndpointContent, /http:\/\/\$\{endpoint\.host\}:\$\{endpoint\.port\}/);
  assert.match(serveEndpointContent, /\.\.\/shared\/render-endpoint\.mjs/);
  assert.match(nestedApiChainResult.assistantText, /SelfMe http:\/\/127\.0\.0\.1:3000/);
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => /^config\/endpoint\.json:1-\d+$/.test(summary)),
    "expected endpoint config read"
  );
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => summary.startsWith("src/shared/render-endpoint.mjs · created")),
    "expected shared helper creation"
  );
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => summary.startsWith("node src/api/serve-endpoint.mjs · failed (1)")),
    "expected failed verification before api entry repair"
  );
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => summary.startsWith("src/api/serve-endpoint.mjs:1-3")),
    "expected api entry read during repair"
  );
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => summary.startsWith("src/api/serve-endpoint.mjs:2-2 · updated")),
    "expected api entry import-line edit"
  );
  assert.ok(
    nestedApiChainResult.toolSummaries.some((summary) => summary.startsWith("node src/api/serve-endpoint.mjs · completed")),
    "expected successful nested api verification"
  );

  console.log("task: create template file and repair nested docs entry");
  const templateRepairChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/release.json, then create src/templates/release-label.txt and repair existing src/docs/show-release.mjs so running `node src/docs/show-release.mjs` prints exactly `SelfMe / docs`. Verify it before finishing."
  });

  const releaseTemplateContent = await readFile(join(workspace, "src", "templates", "release-label.txt"), "utf8");
  const showReleaseContent = await readFile(join(workspace, "src", "docs", "show-release.mjs"), "utf8");
  assert.equal(releaseTemplateContent, "{name} / {channel}\n");
  assert.match(showReleaseContent, /\.\.\/templates\/release-label\.txt/);
  assert.match(templateRepairChainResult.assistantText, /SelfMe \/ docs/);
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => /^config\/release\.json:1-\d+$/.test(summary)),
    "expected release config read"
  );
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/templates/release-label.txt · created")),
    "expected template file creation"
  );
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => summary.startsWith("node src/docs/show-release.mjs · failed (1)")),
    "expected failed verification before docs entry repair"
  );
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/docs/show-release.mjs:1-4")),
    "expected docs entry read during repair"
  );
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => summary.startsWith("src/docs/show-release.mjs:3-3 · updated")),
    "expected docs template-path edit"
  );
  assert.ok(
    templateRepairChainResult.toolSummaries.some((summary) => summary.startsWith("node src/docs/show-release.mjs · completed")),
    "expected successful docs entry verification"
  );

  console.log("task: create template and tighten successful nested docs output");
  const templateTightenChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/badge.json, then create src/templates/badge-label.txt and repair existing src/docs/show-badge.mjs so running `node src/docs/show-badge.mjs` prints exactly `SelfMe [stable]`. Keep working until the output is exact."
  });

  const badgeTemplateContent = await readFile(join(workspace, "src", "templates", "badge-label.txt"), "utf8");
  const showBadgeContent = await readFile(join(workspace, "src", "docs", "show-badge.mjs"), "utf8");
  assert.equal(badgeTemplateContent, "{name} [{mode}]\n");
  assert.match(showBadgeContent, /template\.replace\("\{name\}", badge\.name\)\.replace\("\{mode\}", badge\.mode\)/);
  assert.doesNotMatch(showBadgeContent, /ready/);
  assert.match(templateTightenChainResult.assistantText, /SelfMe \[stable\]/);
  assert.ok(
    templateTightenChainResult.toolSummaries.some((summary) => /^config\/badge\.json:1-\d+$/.test(summary)),
    "expected badge config read"
  );
  assert.ok(
    templateTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/templates/badge-label.txt · created")),
    "expected badge template creation"
  );
  assert.ok(
    templateTightenChainResult.toolSummaries.filter((summary) => summary.startsWith("node src/docs/show-badge.mjs · completed")).length >= 2,
    "expected repeated successful verification while tightening badge output"
  );
  assert.ok(
    templateTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/docs/show-badge.mjs:1-4")),
    "expected badge docs entry read during repair"
  );
  assert.ok(
    templateTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/docs/show-badge.mjs:4-4 · updated")),
    "expected badge output-line edit"
  );

  console.log("task: read multiple existing files then tighten nested web output");
  const nestedWebTightenChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/portal.json and inspect existing src/web/show-portal.mjs so running `node src/web/show-portal.mjs` prints exactly `SelfMe portal:cn`. Keep working until the output is exact."
  });

  const renderPortalContent = await readFile(join(workspace, "src", "shared", "render-portal.mjs"), "utf8");
  const showPortalContent = await readFile(join(workspace, "src", "web", "show-portal.mjs"), "utf8");
  assert.match(renderPortalContent, /portal\.surface\}:\$\{portal\.region\}/);
  assert.match(showPortalContent, /\.\/shared\/render-portal\.mjs|render-portal\.mjs/);
  assert.match(nestedWebTightenChainResult.assistantText, /SelfMe portal:cn/);
  assert.ok(
    nestedWebTightenChainResult.toolSummaries.some((summary) => /^config\/portal\.json:1-\d+$/.test(summary)),
    "expected portal config read"
  );
  assert.ok(
    nestedWebTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/web/show-portal.mjs:1-3")),
    "expected portal entry read"
  );
  assert.ok(
    nestedWebTightenChainResult.toolSummaries.filter((summary) => summary.startsWith("node src/web/show-portal.mjs · completed")).length >= 2,
    "expected repeated successful portal verification while tightening output"
  );
  assert.ok(
    nestedWebTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/shared/render-portal.mjs:1-3")),
    "expected targeted helper read after initial successful shell output"
  );
  assert.ok(
    nestedWebTightenChainResult.toolSummaries.some((summary) => summary.startsWith("src/shared/render-portal.mjs:2-2 · updated")),
    "expected helper output-line edit"
  );

  console.log("task: inspect multiple files but edit only the real problem file");
  const noOverfixChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/audit.json and inspect existing src/web/show-audit.mjs so running `node src/web/show-audit.mjs` prints exactly `SelfMe:audit-cn`. Keep working until the output is exact."
  });

  const renderAuditContent = await readFile(join(workspace, "src", "shared", "render-audit.mjs"), "utf8");
  const showAuditContent = await readFile(join(workspace, "src", "web", "show-audit.mjs"), "utf8");
  assert.match(renderAuditContent, /audit\.name\}:\$\{audit\.level\}-/);
  assert.match(showAuditContent, /\$\{renderAudit\(audit\)\} \$\{audit\.region\}/);
  assert.match(noOverfixChainResult.assistantText, /SelfMe:audit-cn/);
  assert.ok(
    noOverfixChainResult.toolSummaries.some((summary) => /^config\/audit\.json:1-\d+$/.test(summary)),
    "expected audit config read"
  );
  assert.ok(
    noOverfixChainResult.toolSummaries.some((summary) => summary.startsWith("src/web/show-audit.mjs:1-3")),
    "expected audit entry read"
  );
  assert.ok(
    noOverfixChainResult.toolSummaries.filter((summary) => summary.startsWith("node src/web/show-audit.mjs · completed")).length >= 2,
    "expected repeated successful audit verification while tightening output"
  );
  assert.ok(
    noOverfixChainResult.toolSummaries.some((summary) => summary.startsWith("src/shared/render-audit.mjs:1-3")),
    "expected helper read after successful but imprecise shell output"
  );
  assert.ok(
    noOverfixChainResult.toolSummaries.some((summary) => summary.startsWith("src/shared/render-audit.mjs:2-2 · updated")),
    "expected helper line edit"
  );
  assert.equal(
    noOverfixChainResult.toolSummaries.some((summary) => summary.startsWith("src/web/show-audit.mjs:3-3 · updated")),
    false,
    "expected no overfix edit on entry file"
  );

  console.log("task: create data file and repair nested report entry");
  const reportDataChainResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read config/report.json, then create src/data/status-lines.csv and repair existing src/reports/show-status.mjs so running `node src/reports/show-status.mjs` prints exactly `SelfMe|green`. Verify it before finishing."
  });

  const statusLinesContent = await readFile(join(workspace, "src", "data", "status-lines.csv"), "utf8");
  const showStatusContent = await readFile(join(workspace, "src", "reports", "show-status.mjs"), "utf8");
  assert.equal(statusLinesContent, "green\n");
  assert.match(showStatusContent, /\.\.\/data\/status-lines\.csv/);
  assert.match(reportDataChainResult.assistantText, /SelfMe\|green/);
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => /^config\/report\.json:1-\d+$/.test(summary)),
    "expected report config read"
  );
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => summary.startsWith("src/data/status-lines.csv · created")),
    "expected status data file creation"
  );
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => summary.startsWith("node src/reports/show-status.mjs · failed (1)")),
    "expected failed verification before report entry repair"
  );
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => summary.startsWith("src/reports/show-status.mjs:1-4")),
    "expected report entry read during repair"
  );
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => summary.startsWith("src/reports/show-status.mjs:3-3 · updated")),
    "expected report data-path edit"
  );
  assert.ok(
    reportDataChainResult.toolSummaries.some((summary) => summary.startsWith("node src/reports/show-status.mjs · completed")),
    "expected successful report entry verification"
  );

  console.log("task: recover existing file after long truncated output");
  const longOutputRepairResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Inspect catalog.txt and repair existing status.mjs so running `node status.mjs` prints exactly `SelfMe release 3000`. Keep working until the output is exact."
  });

  const statusContent = await readFile(join(workspace, "status.mjs"), "utf8");
  assert.match(statusContent, /SelfMe release 3000/);
  assert.match(longOutputRepairResult.assistantText, /SelfMe release 3000/);
  assert.ok(
    longOutputRepairResult.toolSummaries.some((summary) => /^catalog\.txt:1-\d+ · truncated$/.test(summary)),
    "expected large catalog read to be truncated"
  );
  assert.ok(
    longOutputRepairResult.toolSummaries.some((summary) => summary.startsWith("tail -n 5 catalog.txt · completed")),
    "expected tail follow-up after truncated output"
  );
  assert.ok(
    longOutputRepairResult.toolSummaries.some((summary) => summary.startsWith("status.mjs:1-1")),
    "expected existing status file read"
  );
  assert.ok(
    longOutputRepairResult.toolSummaries.some((summary) => summary.startsWith("status.mjs:1-1 · updated")),
    "expected status file edit"
  );
  assert.ok(
    longOutputRepairResult.toolSummaries.some((summary) => summary.startsWith("node status.mjs · completed")),
    "expected successful status verification"
  );

  console.log("task: accept wrapped tool call payload");
  const wrappedToolCallResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Tell me the current working directory by running pwd."
  });

  assert.match(wrappedToolCallResult.assistantText, /working directory/i);
  assert.ok(
    wrappedToolCallResult.toolSummaries.some((summary) => summary.startsWith("pwd · completed")),
    "expected wrapped shell tool call to run"
  );

  console.log("task: accept repaired tool call payload");
  const repairedToolCallResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Tell me the current working directory again, but do it via your shell tool."
  });

  assert.match(repairedToolCallResult.assistantText, /working directory/i);
  assert.ok(
    repairedToolCallResult.toolSummaries.some((summary) => summary.startsWith("pwd · completed")),
    "expected repaired shell tool call to run"
  );

  console.log("task: handle missing file failure");
  const missingFileResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Check whether missing.txt exists and answer briefly."
  });

  assert.match(missingFileResult.assistantText, /missing\.txt/i);
  assert.match(missingFileResult.assistantText, /(does not exist|not exist|missing)/i);

  console.log("task: handle direct shell failure");
  const directShellFailureResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "运行 sh -lc 'echo out; echo err 1>&2; exit 1'"
  });

  assert.equal(directShellFailureResult.assistantText, "命令执行失败，退出码为 1。");
  assert.ok(
    directShellFailureResult.toolSummaries.some((summary) => summary.startsWith("sh -lc 'echo out; echo err 1>&2; exit 1' · failed (1)")),
    "expected direct shell failure summary"
  );

  console.log("task: handle direct shell success");
  const approvalsBeforeDirectShellSuccess = approvals.length;
  const directShellSuccessResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "运行 pwd"
  });

  assert.equal(directShellSuccessResult.assistantText, "当前工作目录就是这个会话的工作区目录。");
  assert.ok(
    directShellSuccessResult.toolSummaries.some((summary) => summary.startsWith("pwd · completed")),
    "expected direct shell success summary"
  );
  assert.equal(
    approvals.length,
    approvalsBeforeDirectShellSuccess,
    "expected low-risk direct shell command to avoid approval"
  );

  console.log("task: inherit chinese session language for bare direct shell failure");
  const chineseBareDirectShellFailureResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "sh -lc 'echo out; echo err 1>&2; exit 1'"
  });

  assert.equal(chineseBareDirectShellFailureResult.assistantText, "命令执行失败，退出码为 1。");
  assert.ok(
    chineseBareDirectShellFailureResult.toolSummaries.some((summary) => summary.startsWith("sh -lc 'echo out; echo err 1>&2; exit 1' · failed (1)")),
    "expected chinese bare direct shell failure summary"
  );

  console.log("task: handle english direct shell success");
  const englishDirectShellSuccessResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "run pwd"
  });

  assert.equal(englishDirectShellSuccessResult.assistantText, "The current working directory is the active workspace.");
  assert.ok(
    englishDirectShellSuccessResult.toolSummaries.some((summary) => summary.startsWith("pwd · completed")),
    "expected english direct shell success summary"
  );

  console.log("task: handle bare direct shell failure");
  const bareDirectShellFailureResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "sh -lc 'echo out; echo err 1>&2; exit 1'"
  });

  assert.equal(bareDirectShellFailureResult.assistantText, "The command failed with exit code 1.");
  assert.ok(
    bareDirectShellFailureResult.toolSummaries.some((summary) => summary.startsWith("sh -lc 'echo out; echo err 1>&2; exit 1' · failed (1)")),
    "expected bare direct shell failure summary"
  );

  console.log("task: handle denied write approval");
  approvalDecisions.push("deny");
  const deniedWriteResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Create blocked.txt with the content hidden."
  });

  await assert.rejects(readFile(join(workspace, "blocked.txt"), "utf8"));
  assert.equal(deniedWriteResult.toolSummaries.length, 0);
  assert.match(deniedWriteResult.assistantText, /(denied|couldn'?t create|not approved)/i);

  console.log("task: handle denied edit approval");
  approvalDecisions.push("deny");
  const deniedEditResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: 'Change greet.mjs so it prints "Blocked".'
  });

  const greetAfterDeniedEdit = await readFile(join(workspace, "greet.mjs"), "utf8");
  assert.equal(greetAfterDeniedEdit, 'console.log("Hello, SelfMe!");\n');
  assert.equal(deniedEditResult.toolSummaries.length, 0);
  assert.match(deniedEditResult.assistantText, /(denied|couldn'?t change|not approved)/i);

  console.log("task: handle denied shell approval");
  approvalDecisions.push("deny");
  const deniedShellResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Run rm greet.mjs."
  });

  assert.equal(deniedShellResult.toolSummaries.length, 0);
  assert.match(deniedShellResult.assistantText, /(denied|couldn'?t run|not approved)/i);
  const greetAfterDeniedShell = await readFile(join(workspace, "greet.mjs"), "utf8");
  assert.equal(greetAfterDeniedShell, 'console.log("Hello, SelfMe!");\n');

  console.log("task: allow final answer after six tool steps");
  const sixToolStepResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, and status.mjs, then answer exactly FINAL-SIX-STEPS."
  });

  assert.equal(sixToolStepResult.assistantText, "FINAL-SIX-STEPS");
  assert.deepEqual(
    sixToolStepResult.toolSummaries.filter((summary) =>
      summary.startsWith("app.config.json:")
      || summary.startsWith("greet.mjs:")
      || summary.startsWith("report.mjs:")
      || summary.startsWith("serve.mjs:")
      || summary.startsWith("dashboard.mjs:")
      || summary.startsWith("status.mjs:")
    ).length,
    6
  );

  console.log("task: fail deterministically on seventh tool step");
  const sevenToolStepResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, status.mjs, and console.mjs, then answer exactly SHOULD-NOT-HAPPEN.",
    expectedState: "failed"
  });

  assert.equal(sevenToolStepResult.assistantText, "");
  assert.ok(
    sevenToolStepResult.runtimeErrors.some((message) => message.includes("Agent stopped after 6 tool steps")),
    "expected deterministic step-limit runtime error"
  );
  assert.equal(
    sevenToolStepResult.toolSummaries.filter((summary) =>
      summary.startsWith("app.config.json:")
      || summary.startsWith("greet.mjs:")
      || summary.startsWith("report.mjs:")
      || summary.startsWith("serve.mjs:")
      || summary.startsWith("dashboard.mjs:")
      || summary.startsWith("status.mjs:")
    ).length,
    6
  );
  assert.equal(
    sevenToolStepResult.toolSummaries.some((summary) => summary.startsWith("console.mjs:")),
    false,
    "expected seventh tool request to stop before execution"
  );

  assert.ok(approvals.length >= 2, "expected at least two approvals to be auto-approved");

  await verifyHelpCommandAvailableWhileBusy();
  await verifyResumeFollowUpAfterStop();
  await verifyBareContinueResumesInterruptedTask();
  await verifyBareAffirmativeResumesInterruptedTask();
  await verifyBareAffirmativeResumesInterruptedProposalExecution();
  await verifyVagueRewriteResumesInterruptedProposalExecution();
  await verifyVagueOptimizationResumesInterruptedProposalExecution();
  await verifyResumeFollowUpAtLatestFailurePoint();
  await verifyResumeFollowUpPullsExplanationBackIntoLatestFailurePoint();
  await verifyResumeFollowUpPullsBlockingQuestionBackIntoLatestFailurePoint();
  await verifyResumeFollowUpInProjectVerificationChain();
  await verifyVagueOptimizationInProjectVerificationChain();
  await verifyVagueInspectionInProjectVerificationChain();
  await verifyResumeFollowUpInProjectStageSummaryChain();
  await verifyResumeFollowUpAfterApprovalWaitInProjectChain();
  await verifyBareAffirmativeAfterApprovalWaitInProjectChain();
  await verifyVagueOptimizationAfterApprovalWaitInProjectChain();
  await verifyNaturalLanguageApprovalShortcuts();
  verifyInterruptFallbackWhenWorkingUiLingers();
  console.log("task: verify context compaction");
  verifyContextCompaction();
  verifyContextCompactionSwitchesMainTask();
  verifyContextCompactionPrefersLatestVerificationCommand();
  verifyContextCompactionExtractsQuotedTargetOutput();
  verifyContextCompactionPreservesAssistantStageBoundaries();
  verifyContextCompactionKeepsWholeTurns();
  verifyToolSummaryFormatting();
  verifyIncompleteSlashCommandHandling();
  verifyMultilineSlashCommands();
  verifyContextCompactionClipsLongRecentTurns();

  console.log("agent regression passed");
  console.log(`workspace: ${workspace}`);
  console.log(`approvals auto-approved: ${approvals.length}`);
}

async function runAgentTask(input: {
  bus: EventBus;
  transcriptStore: TranscriptStore;
  sessionId: string;
  prompt: string;
  expectedState?: "completed" | "failed" | "cancelled";
}) {
  const beforeEvents = await input.transcriptStore.readEventsBySession(input.sessionId);
  const completedTask = waitForAssistantTaskCompletion(input.bus, input.sessionId);
  input.bus.emit(createUserMessageSubmittedEvent({
    sessionId: input.sessionId,
    content: input.prompt
  }));

  const task = await completedTask;
  const events = (await input.transcriptStore.readEventsBySession(input.sessionId)).slice(beforeEvents.length);
  const assistantText = collectAssistantText(events, task.taskId ?? "");
  const assistantTurns = collectAssistantTurns(events, task.taskId ?? "");
  const toolSummaries = events
    .filter((event): event is Extract<RuntimeEvent, { type: "tool.execution.completed" }> =>
      event.type === "tool.execution.completed" && event.taskId !== task.taskId
    )
    .map((event) => event.payload.summary);
  const runtimeErrors = events
    .filter((event): event is Extract<RuntimeEvent, { type: "runtime.error.raised" }> =>
      event.type === "runtime.error.raised" && event.taskId === task.taskId
    )
    .map((event) => event.payload.message);

  assert.equal(
    task.payload.state,
    input.expectedState ?? "completed",
    `agent task did not complete: ${task.payload.state}${runtimeErrors.length > 0 ? ` | runtime errors: ${runtimeErrors.join(" || ")}` : ""}`
  );

  return {
    taskId: task.taskId ?? "",
    assistantText,
    assistantTurns,
    toolSummaries,
    runtimeErrors
  };
}

async function verifyHelpCommandAvailableWhileBusy() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-busy-help-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class BusyHelpProvider implements ProviderClient {
    readonly name = "busy-help-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Hold busy task") {
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { delta: "done" };
        return;
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new BusyHelpProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const helpEventPromise = new Promise<Extract<RuntimeEvent, { type: "system.message.appended" }>>((resolve) => {
    const off = bus.on("system.message.appended", (event) => {
      if (event.sessionId === session.sessionId && event.payload.title === "Help") {
        off();
        resolve(event);
      }
    });
  });

  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Hold busy task"
  }));
  bus.emit(createTerminalCommandInvokedEvent({
    sessionId: session.sessionId,
    content: "/help"
  }));

  const helpEvent = await helpEventPromise;
  const task = await completionPromise;
  const events = await transcriptStore.readEventsBySession(session.sessionId);

  assert.equal(helpEvent.payload.title, "Help");
  assert.match(helpEvent.payload.content, /Commands/);
  assert.equal(task.payload.state, "completed");
  assert.ok(
    !events.some((event) => event.type === "system.message.appended" && event.payload.title === "Help"),
    "help output should stay transient while busy"
  );
  assert.ok(
    !events.some((event) => event.type === "system.message.appended" && event.payload.title === "Busy"),
    "help should not be blocked by busy state"
  );
}

async function verifyResumeFollowUpAfterStop() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class ResumeAfterStopProvider implements ProviderClient {
    readonly name = "resume-after-stop-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create resume.txt with the content keep-going.") {
        await waitForProviderDelay(input.signal, 120);
        yield {
          delta: toolCall("write", {
            path: "resume.txt",
            content: "keep-going\n"
          })
        };
        return;
      }

      if (input.content.startsWith('The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        yield {
          delta: toolCall("write", {
            path: "resume.txt",
            content: "keep-going\n"
          })
        };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        yield { delta: "Created resume.txt and continued the interrupted task." };
        return;
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeAfterStopProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const approvalDecisions: Array<"approve" | "deny"> = [];
  bus.on("approval.requested", (event) => {
    const decision = approvalDecisions.shift() ?? "approve";
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/${decision} ${event.payload.approvalId}`
    }));
  });

  const busyPromise = waitForBusyPhase(bus, session.sessionId, "assistant");
  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create resume.txt with the content keep-going."
  }));

  await busyPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await waitForAssistantTaskCompletion(bus, session.sessionId);
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.ok(
    !interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("resume.txt")
    ),
    "interrupted task should stop before creating the file"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "还能继续吗"
  });

  const resumedContent = await readFile(join(workspace, "resume.txt"), "utf8");
  assert.equal(resumedContent, "keep-going\n");
  assert.match(resumedResult.assistantText, /continued the interrupted task/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume.txt · created")),
    "resume follow-up should continue the stopped task instead of only answering the question"
  );
}

async function verifyBareContinueResumesInterruptedTask() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-bare-continue-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class BareContinueResumeProvider implements ProviderClient {
    readonly name = "bare-continue-resume-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create continue.txt with the content resumed.") {
        await waitForProviderDelay(input.signal, 120);
        yield {
          delta: toolCall("write", {
            path: "continue.txt",
            content: "resumed\n"
          })
        };
        return;
      }

      if (input.content.startsWith('The user replied "继续" and wants to continue the most recent unfinished task.')) {
        yield {
          delta: toolCall("write", {
            path: "continue.txt",
            content: "resumed\n"
          })
        };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "继续" and wants to continue the most recent unfinished task.')) {
        yield { delta: "Created continue.txt and resumed the interrupted task." };
        return;
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new BareContinueResumeProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const approvalDecisions: Array<"approve" | "deny"> = [];
  bus.on("approval.requested", (event) => {
    const decision = approvalDecisions.shift() ?? "approve";
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/${decision} ${event.payload.approvalId}`
    }));
  });

  const busyPromise = waitForBusyPhase(bus, session.sessionId, "assistant");
  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create continue.txt with the content resumed."
  }));

  await busyPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await waitForAssistantTaskCompletion(bus, session.sessionId);
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("continue.txt")
    ),
    false,
    "bare continue interruption should stop before creating the file"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "继续"
  });

  const resumedContent = await readFile(join(workspace, "continue.txt"), "utf8");
  assert.equal(resumedContent, "resumed\n");
  assert.match(resumedResult.assistantText, /resumed the interrupted task/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("continue.txt · created")),
    "bare continue should resume the interrupted task instead of falling back to acknowledgement handling"
  );
}

async function verifyBareAffirmativeResumesInterruptedTask() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-bare-affirmative-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class BareAffirmativeResumeProvider implements ProviderClient {
    readonly name = "bare-affirmative-resume-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create affirmative.txt with the content resumed.") {
        await waitForProviderDelay(input.signal, 120);
        yield {
          delta: toolCall("write", {
            path: "affirmative.txt",
            content: "resumed\n"
          })
        };
        return;
      }

      if (input.content.startsWith('The user replied "可以" and wants to continue the most recent unfinished task.')) {
        yield {
          delta: toolCall("write", {
            path: "affirmative.txt",
            content: "resumed\n"
          })
        };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "可以" and wants to continue the most recent unfinished task.')) {
        yield { delta: "Created affirmative.txt and resumed the interrupted task." };
        return;
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new BareAffirmativeResumeProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const approvalDecisions: Array<"approve" | "deny"> = [];
  bus.on("approval.requested", (event) => {
    const decision = approvalDecisions.shift() ?? "approve";
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/${decision} ${event.payload.approvalId}`
    }));
  });

  const busyPromise = waitForBusyPhase(bus, session.sessionId, "assistant");
  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create affirmative.txt with the content resumed."
  }));

  await busyPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await waitForAssistantTaskCompletion(bus, session.sessionId);
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("affirmative.txt")
    ),
    false,
    "bare affirmative interruption should stop before creating the file"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "可以"
  });

  const resumedContent = await readFile(join(workspace, "affirmative.txt"), "utf8");
  assert.equal(resumedContent, "resumed\n");
  assert.match(resumedResult.assistantText, /resumed the interrupted task/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("affirmative.txt · created")),
    "bare affirmative should resume the interrupted task when no assistant proposal is pending"
  );
}

async function verifyBareAffirmativeResumesInterruptedProposalExecution() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-bare-affirmative-proposal-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const PORT = 3000;\nconsole.log(PORT);\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<input name="title" />\n',
    "utf8"
  );

  class BareAffirmativeProposalResumeProvider implements ProviderClient {
    readonly name = "bare-affirmative-proposal-resume-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const proposalPrompt = "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。";
      const executeProposalPrompt = 'The user replied "可以" and wants you to execute the immediately previous rewrite proposal now.';
      const resumePrompt = 'The user replied "可以" and wants to continue the most recent unfinished task.';

      if (input.content === proposalPrompt) {
        yield {
          delta: [
            "If you want, I can rewrite node-todo by updating node-todo/app.js and node-todo/views/index.ejs.",
            "I would first switch node-todo/app.js to process.env.PORT, then add maxlength 100 in node-todo/views/index.ejs."
          ].join(" ")
        };
        return;
      }

      if (input.content.startsWith(executeProposalPrompt)) {
        yield {
          delta: toolCall("files", {
            path: "node-todo/app.js",
            startLine: 1,
            endLine: 2
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${executeProposalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 1,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          await waitForProviderDelay(input.signal, 300);
          yield {
            delta: toolCall("files", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1
            })
          };
          return;
        }
      }

      if (input.content.startsWith(resumePrompt)) {
        assert.match(input.content, /Original task: 看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。/);
        assert.match(input.content, /Latest tool in context: edit/);
        assert.match(input.content, /Latest tool summary in context: node-todo\/app\.js:1-1 · updated/);
        yield {
          delta: toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 1
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${resumePrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1,
              replacement: '<input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield { delta: "Completed the interrupted rewrite by continuing directly with node-todo/views/index.ejs." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new BareAffirmativeProposalResumeProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const proposalResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。"
  });
  assert.match(proposalResult.assistantText, /node-todo\/app\.js/i);
  assert.match(proposalResult.assistantText, /node-todo\/views\/index\.ejs/i);

  const firstRunCompletion = waitForAssistantTaskCompletion(bus, session.sessionId);
  const firstEditCompleted = new Promise<void>((resolve) => {
    const off = bus.on("tool.execution.completed", (event) => {
      if (event.sessionId !== session.sessionId || !event.payload.summary.startsWith("node-todo/app.js:1-1 · updated")) {
        return;
      }

      off();
      resolve();
    });
  });

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "可以"
  }));

  await firstEditCompleted;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await firstRunCompletion;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "可以"
  });

  const resumedAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedAppContent, /process\.env\.PORT/);
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-2")),
    false,
    "bare affirmative resume after proposal execution should not reread app.js from the original proposal"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-1 · updated")),
    false,
    "bare affirmative resume after proposal execution should not reapply the app.js edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1")),
    "bare affirmative resume after proposal execution should continue into the pending view file"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1 · updated")),
    "bare affirmative resume after proposal execution should finish the pending view edit"
  );
}

async function verifyVagueRewriteResumesInterruptedProposalExecution() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-vague-rewrite-proposal-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const PORT = 3000;\nconsole.log(PORT);\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<input name="title" />\n',
    "utf8"
  );

  class VagueRewriteProposalResumeProvider implements ProviderClient {
    readonly name = "vague-rewrite-proposal-resume-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const proposalPrompt = "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。";
      const executeProposalPrompt = 'The user replied "可以" and wants you to execute the immediately previous rewrite proposal now.';
      const resumePrompt = 'The user replied "你能帮我重新写个项目吗" and wants to continue the most recent unfinished task.';

      if (input.content === proposalPrompt) {
        yield {
          delta: [
            "If you want, I can rewrite node-todo by updating node-todo/app.js and node-todo/views/index.ejs.",
            "I would first switch node-todo/app.js to process.env.PORT, then add maxlength 100 in node-todo/views/index.ejs."
          ].join(" ")
        };
        return;
      }

      if (input.content.startsWith(executeProposalPrompt)) {
        yield {
          delta: toolCall("files", {
            path: "node-todo/app.js",
            startLine: 1,
            endLine: 2
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${executeProposalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 1,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          await waitForProviderDelay(input.signal, 300);
          yield {
            delta: toolCall("files", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1
            })
          };
          return;
        }
      }

      if (input.content.startsWith(resumePrompt)) {
        assert.match(input.content, /Resume that task now instead of treating this as a broad rewrite follow-up\./);
        assert.match(input.content, /Original task: 看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。/);
        assert.match(input.content, /Latest tool in context: edit/);
        assert.match(input.content, /Latest tool summary in context: node-todo\/app\.js:1-1 · updated/);
        yield {
          delta: toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 1
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${resumePrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1,
              replacement: '<input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield { delta: "Completed the interrupted rewrite by continuing directly with node-todo/views/index.ejs." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new VagueRewriteProposalResumeProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const proposalResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。"
  });
  assert.match(proposalResult.assistantText, /node-todo\/app\.js/i);
  assert.match(proposalResult.assistantText, /node-todo\/views\/index\.ejs/i);

  const firstRunCompletion = waitForAssistantTaskCompletion(bus, session.sessionId);
  const firstEditCompleted = new Promise<void>((resolve) => {
    const off = bus.on("tool.execution.completed", (event) => {
      if (event.sessionId !== session.sessionId || !event.payload.summary.startsWith("node-todo/app.js:1-1 · updated")) {
        return;
      }

      off();
      resolve();
    });
  });

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "可以"
  }));

  await firstEditCompleted;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await firstRunCompletion;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "你能帮我重新写个项目吗"
  });

  const resumedAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedAppContent, /process\.env\.PORT/);
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-2")),
    false,
    "vague rewrite resume after proposal execution should not reread app.js from the original proposal"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-1 · updated")),
    false,
    "vague rewrite resume after proposal execution should not reapply the app.js edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1")),
    "vague rewrite resume after proposal execution should continue into the pending view file"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1 · updated")),
    "vague rewrite resume after proposal execution should finish the pending view edit"
  );
}

async function verifyVagueOptimizationResumesInterruptedProposalExecution() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-vague-optimize-proposal-stop-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const PORT = 3000;\nconsole.log(PORT);\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<input name="title" />\n',
    "utf8"
  );

  class VagueOptimizeProposalResumeProvider implements ProviderClient {
    readonly name = "vague-optimize-proposal-resume-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const proposalPrompt = "看看项目，但先别改，告诉我如果优化 node-todo 你会怎么做。";
      const executeProposalPrompt = 'The user replied "可以" to approve the immediately previous proposal.';
      const resumePrompt = 'The user replied "帮我优化下" and wants to continue the most recent unfinished task.';

      if (input.content === proposalPrompt) {
        yield {
          delta: [
            "If you want, I can optimize node-todo by updating node-todo/app.js and node-todo/views/index.ejs.",
            "I would first switch node-todo/app.js to process.env.PORT, then add maxlength 100 in node-todo/views/index.ejs."
          ].join(" ")
        };
        return;
      }

      if (input.content.startsWith(executeProposalPrompt)) {
        yield {
          delta: toolCall("files", {
            path: "node-todo/app.js",
            startLine: 1,
            endLine: 2
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${executeProposalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 1,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          await waitForProviderDelay(input.signal, 300);
          yield {
            delta: toolCall("files", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1
            })
          };
          return;
        }
      }

      if (input.content.startsWith(resumePrompt)) {
        assert.match(input.content, /Resume that task now instead of treating this as a broad optimization follow-up\./);
        assert.match(input.content, /Original task: 看看项目，但先别改，告诉我如果优化 node-todo 你会怎么做。/);
        assert.match(input.content, /Latest tool in context: edit/);
        assert.match(input.content, /Latest tool summary in context: node-todo\/app\.js:1-1 · updated/);
        yield {
          delta: toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 1
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${resumePrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 1,
              endLine: 1,
              replacement: '<input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield { delta: "Completed the interrupted optimization by continuing directly with node-todo/views/index.ejs." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new VagueOptimizeProposalResumeProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  const proposalResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "看看项目，但先别改，告诉我如果优化 node-todo 你会怎么做。"
  });
  assert.match(proposalResult.assistantText, /node-todo\/app\.js/i);
  assert.match(proposalResult.assistantText, /node-todo\/views\/index\.ejs/i);

  const firstRunCompletion = waitForAssistantTaskCompletion(bus, session.sessionId);
  const firstEditCompleted = new Promise<void>((resolve) => {
    const off = bus.on("tool.execution.completed", (event) => {
      if (event.sessionId !== session.sessionId || !event.payload.summary.startsWith("node-todo/app.js:1-1 · updated")) {
        return;
      }

      off();
      resolve();
    });
  });

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "可以"
  }));

  await firstEditCompleted;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await firstRunCompletion;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "帮我优化下"
  });

  const resumedAppContent = await readFile(join(workspace, "node-todo", "app.js"), "utf8");
  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedAppContent, /process\.env\.PORT/);
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-2")),
    false,
    "vague optimize resume after proposal execution should not reread app.js from the original proposal"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-1 · updated")),
    false,
    "vague optimize resume after proposal execution should not reapply the app.js edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1")),
    "vague optimize resume after proposal execution should continue into the pending view file"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-1 · updated")),
    "vague optimize resume after proposal execution should finish the pending view edit"
  );
}

async function verifyResumeFollowUpAtLatestFailurePoint() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-failure-point-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class ResumeFailurePointProvider implements ProviderClient {
    readonly name = "resume-failure-point-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create resume-numbers.txt with three lines: 4, 5, 6. Then create resume-total.mjs so running `node resume-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.") {
        yield {
          delta: toolCall("write", {
            path: "resume-numbers.txt",
            content: "4\n5\n6\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create resume-numbers.txt with three lines: 4, 5, 6. Then create resume-total.mjs so running `node resume-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.")) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "write" && /resume-numbers\.txt/.test(summary)) {
          yield {
            delta: toolCall("write", {
              path: "resume-total.mjs",
              content: "console.log(total);\n"
            })
          };
          return;
        }

        if (toolName === "write" && /resume-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell" && /The latest tool attempt failed\./.test(input.content)) {
          yield {
            delta: toolCall("files", {
              path: "resume-total.mjs",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /resume-total\.mjs/.test(summary)) {
          await waitForProviderDelay(input.signal, 120);
          yield {
            delta: toolCall("edit", {
              path: "resume-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }
      }

      if (input.content.startsWith('The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        assert.match(input.content, /Original task: Create resume-numbers\.txt with three lines: 4, 5, 6\./);
        yield {
          delta: toolCall("edit", {
            path: "resume-total.mjs",
            startLine: 1,
            endLine: 1,
            replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
          })
        };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "edit" && /resume-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /15/);
          yield { delta: "Repaired resume-total.mjs and continued the interrupted task from the latest failure point." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeFailurePointProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  bus.on("approval.requested", (event) => {
    approvalCount += 1;
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/approve ${event.payload.approvalId}`
    }));
  });

  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);
  const fileReadPromise = waitForToolExecutionCompleted(bus, session.sessionId, (summary) => summary.startsWith("resume-total.mjs:1-1"));

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create resume-numbers.txt with three lines: 4, 5, 6. Then create resume-total.mjs so running `node resume-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing."
  }));

  await fileReadPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("resume-numbers.txt · created")
    ),
    "interrupted task should preserve the first created file before stop"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("resume-total.mjs · created")
    ),
    "interrupted task should preserve the second created file before stop"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node resume-total.mjs · failed (1)")
    ),
    "interrupted task should already have the failed verification in history"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("resume-total.mjs:1-1")
    ),
    "interrupted task should already have inspected the latest working file"
  );
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("resume-total.mjs:1-1 · updated")
    ),
    false,
    "interrupted task should stop before the repair edit is applied"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "还能继续吗"
  });

  const resumedContent = await readFile(join(workspace, "resume-total.mjs"), "utf8");
  assert.match(resumedContent, /resume-numbers\.txt/);
  assert.match(resumedContent, /reduce/);
  assert.match(resumedResult.assistantText, /latest failure point/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-numbers.txt · created")),
    false,
    "resume follow-up should not recreate the first file"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-total.mjs · created")),
    false,
    "resume follow-up should not recreate the second file"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node resume-total.mjs · failed (1)")),
    false,
    "resume follow-up should not rerun the old failing verification before repairing the known target"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-total.mjs:1-1 · updated")),
    "resume follow-up should continue directly with the pending repair edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node resume-total.mjs · completed")),
    "resume follow-up should complete the verification after the repair"
  );
  assert.equal(
    approvalCount,
    2,
    "expected one approval for the original writes and one approval for the resumed repair edit"
  );
}

async function verifyResumeFollowUpPullsExplanationBackIntoLatestFailurePoint() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-explain-point-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class ResumeExplainPointProvider implements ProviderClient {
    readonly name = "resume-explain-point-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create resume-explain-numbers.txt with three lines: 4, 5, 6. Then create resume-explain-total.mjs so running `node resume-explain-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.") {
        yield {
          delta: toolCall("write", {
            path: "resume-explain-numbers.txt",
            content: "4\n5\n6\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create resume-explain-numbers.txt with three lines: 4, 5, 6. Then create resume-explain-total.mjs so running `node resume-explain-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.")) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "write" && /resume-explain-numbers\.txt/.test(summary)) {
          yield {
            delta: toolCall("write", {
              path: "resume-explain-total.mjs",
              content: "console.log(total);\n"
            })
          };
          return;
        }

        if (toolName === "write" && /resume-explain-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-explain-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell" && /The latest tool attempt failed\./.test(input.content)) {
          yield {
            delta: toolCall("files", {
              path: "resume-explain-total.mjs",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /resume-explain-total\.mjs/.test(summary)) {
          await waitForProviderDelay(input.signal, 120);
          yield {
            delta: toolCall("edit", {
              path: "resume-explain-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-explain-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }
      }

      if (input.content.startsWith('The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        yield { delta: "resume-explain-total.mjs still needs the repair at the latest failure point." };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (/You have not started the requested work yet\./.test(input.content)) {
          assert.match(input.content, /Recent editable working file: resume-explain-total\.mjs/);
          yield {
            delta: toolCall("edit", {
              path: "resume-explain-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-explain-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }

        if (toolName === "edit" && /resume-explain-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-explain-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /15/);
          yield { delta: "Repaired resume-explain-total.mjs and continued the interrupted task from the latest failure point." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeExplainPointProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  bus.on("approval.requested", (event) => {
    approvalCount += 1;
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/approve ${event.payload.approvalId}`
    }));
  });

  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);
  const fileReadPromise = waitForToolExecutionCompleted(bus, session.sessionId, (summary) => summary.startsWith("resume-explain-total.mjs:1-1"));

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create resume-explain-numbers.txt with three lines: 4, 5, 6. Then create resume-explain-total.mjs so running `node resume-explain-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing."
  }));

  await fileReadPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "还能继续吗"
  });

  const resumedContent = await readFile(join(workspace, "resume-explain-total.mjs"), "utf8");
  assert.match(resumedContent, /resume-explain-numbers\.txt/);
  assert.match(resumedResult.assistantText, /latest failure point/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-explain-numbers.txt · created")),
    false,
    "resume explanation recovery should not recreate the first file"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-explain-total.mjs · created")),
    false,
    "resume explanation recovery should not recreate the second file"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-explain-total.mjs:1-1 · updated")),
    "resume explanation recovery should be pulled back into the pending repair edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node resume-explain-total.mjs · completed")),
    "resume explanation recovery should still complete the verification"
  );
  assert.equal(
    approvalCount,
    2,
    "expected one approval before interruption and one approval for the resumed repair edit"
  );
}

async function verifyResumeFollowUpPullsBlockingQuestionBackIntoLatestFailurePoint() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-question-point-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class ResumeQuestionPointProvider implements ProviderClient {
    readonly name = "resume-question-point-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create resume-question-numbers.txt with three lines: 4, 5, 6. Then create resume-question-total.mjs so running `node resume-question-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.") {
        yield {
          delta: toolCall("write", {
            path: "resume-question-numbers.txt",
            content: "4\n5\n6\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create resume-question-numbers.txt with three lines: 4, 5, 6. Then create resume-question-total.mjs so running `node resume-question-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.")) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "write" && /resume-question-numbers\.txt/.test(summary)) {
          yield {
            delta: toolCall("write", {
              path: "resume-question-total.mjs",
              content: "console.log(total);\n"
            })
          };
          return;
        }

        if (toolName === "write" && /resume-question-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-question-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell" && /The latest tool attempt failed\./.test(input.content)) {
          yield {
            delta: toolCall("files", {
              path: "resume-question-total.mjs",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /resume-question-total\.mjs/.test(summary)) {
          await waitForProviderDelay(input.signal, 120);
          yield {
            delta: toolCall("edit", {
              path: "resume-question-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-question-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }
      }

      if (input.content.startsWith('The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        yield { delta: "Do you want me to repair resume-question-total.mjs now?" };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (/You have not started the requested work yet\./.test(input.content)) {
          assert.match(input.content, /Recent editable working file: resume-question-total\.mjs/);
          yield {
            delta: toolCall("edit", {
              path: "resume-question-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("resume-question-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }

        if (toolName === "edit" && /resume-question-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node resume-question-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /15/);
          yield { delta: "Repaired resume-question-total.mjs and continued the interrupted task from the latest failure point." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeQuestionPointProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  bus.on("approval.requested", (event) => {
    approvalCount += 1;
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/approve ${event.payload.approvalId}`
    }));
  });

  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);
  const fileReadPromise = waitForToolExecutionCompleted(bus, session.sessionId, (summary) => summary.startsWith("resume-question-total.mjs:1-1"));

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: "Create resume-question-numbers.txt with three lines: 4, 5, 6. Then create resume-question-total.mjs so running `node resume-question-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing."
  }));

  await fileReadPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "还能继续吗"
  });

  const resumedContent = await readFile(join(workspace, "resume-question-total.mjs"), "utf8");
  assert.match(resumedContent, /resume-question-numbers\.txt/);
  assert.match(resumedResult.assistantText, /latest failure point/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-question-numbers.txt · created")),
    false,
    "resume question recovery should not recreate the first file"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-question-total.mjs · created")),
    false,
    "resume question recovery should not recreate the second file"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("resume-question-total.mjs:1-1 · updated")),
    "resume question recovery should be pulled back into the pending repair edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node resume-question-total.mjs · completed")),
    "resume question recovery should still complete the verification"
  );
  assert.equal(
    approvalCount,
    2,
    "expected one approval before interruption and one approval for the resumed repair edit"
  );
}

async function verifyResumeFollowUpInProjectVerificationChain() {
  await verifyProjectVerificationChainResume("还能继续吗");
}

async function verifyVagueOptimizationInProjectVerificationChain() {
  await verifyProjectVerificationChainResume("帮我优化下");
}

async function verifyVagueInspectionInProjectVerificationChain() {
  await verifyProjectVerificationChainResume("帮我看看");
}

async function verifyProjectVerificationChainResume(followUpPrompt: "还能继续吗" | "帮我优化下" | "帮我看看") {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-project-chain-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "node-todo"), { recursive: true });
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "node app.js"\n  }\n}\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-setup.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  class ResumeProjectChainProvider implements ProviderClient {
    readonly name = "resume-project-chain-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";

      if (input.content === originalPrompt) {
        yield {
          delta: toolCall("shell", {
            command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${originalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "shell") {
          if (/You are in the middle of a concrete project inspection request\./.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "node-todo/package.json",
                startLine: 1,
                endLine: 20
              })
            };
            return;
          }

          if (/app-only/.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "node-todo/views/index.ejs",
                startLine: 1,
                endLine: 4
              })
            };
            return;
          }

          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo verification chain after resuming from the latest failure point." };
          return;
        }

        if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
          yield {
            delta: toolCall("files", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 3,
              endLine: 3,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          await waitForProviderDelay(input.signal, 120);
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 3,
              endLine: 3,
              replacement: '  <input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }
      }

      if (/^The user replied "(还能继续吗|帮我优化下|帮我看看)" and wants to continue the most recent unfinished task\./.test(input.content)) {
        assert.match(input.content, /Original task: 看看项目，然后直接优化 node-todo/);
        if (/帮我优化下/.test(input.content)) {
          assert.match(input.content, /Resume that task now instead of treating this as a broad optimization follow-up\./);
        }
        if (/帮我看看/.test(input.content)) {
          assert.match(input.content, /Resume that task now instead of treating this as a broad inspection follow-up\./);
        }
        assert.match(input.content, /Latest tool in context: files/);
        assert.match(input.content, /Latest tool summary in context: node-todo\/views\/index\.ejs:1-4/);
        assert.match(input.content, /Interrupted pending approval: edit · node-todo\/views\/index\.ejs:3-3/);
        yield {
          delta: toolCall("edit", {
            path: "node-todo/views/index.ejs",
            startLine: 3,
            endLine: 3,
            replacement: '  <input name="title" maxlength="100" />'
          })
        };
        return;
      }

      if (/^Original user request: The user replied "(还能继续吗|帮我优化下|帮我看看)" and wants to continue the most recent unfinished task\./.test(input.content)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo verification chain after resuming from the latest failure point." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeProjectChainProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  bus.on("approval.requested", (event) => {
    approvalCount += 1;
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/approve ${event.payload.approvalId}`
    }));
  });

  const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";
  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);
  const viewReadPromise = waitForToolExecutionCompleted(bus, session.sessionId, (summary) => summary.startsWith("node-todo/views/index.ejs:1-4"));

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: originalPrompt
  }));

  await viewReadPromise;
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/app.js:3-3 · updated")
    ),
    "interrupted project task should preserve the app.js edit before stop"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node node-todo/verify-setup.mjs · completed")
    ),
    "interrupted project task should preserve the near-miss verification before stop"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/views/index.ejs:1-4")
    ),
    "interrupted project task should already know the pending view working file"
  );
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/views/index.ejs:3-3 · updated")
    ),
    false,
    "interrupted project task should stop before the pending view edit is applied"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: followUpPrompt
  });

  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.match(resumedResult.assistantText, /latest failure point/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-")),
    false,
    "resume follow-up should not restart from package.json"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-")),
    false,
    "resume follow-up should not reread app.js after the failure point already moved to the view"
  );
  assert.equal(
    resumedResult.toolSummaries.filter((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")).length,
    1,
    "resume follow-up should only run the final verification after the resumed view edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "resume follow-up should continue directly with the pending view edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")),
    "resume follow-up should finish the project verification after the resumed edit"
  );
  assert.equal(
    approvalCount,
    2,
    "expected one approval before interruption and one approval for the resumed view edit"
  );
}

async function verifyResumeFollowUpInProjectStageSummaryChain() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-project-stage-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "node-todo"), { recursive: true });
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "node app.js"\n  }\n}\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-setup.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  class ResumeProjectStageProvider implements ProviderClient {
    readonly name = "resume-project-stage-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";

      if (input.content === originalPrompt) {
        yield {
          delta: toolCall("shell", {
            command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${originalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "shell") {
          if (/You are in the middle of a concrete project inspection request\./.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "node-todo/package.json",
                startLine: 1,
                endLine: 20
              })
            };
            return;
          }

          if (/app-only/.test(input.content)) {
            if (
              /You are already inside the execution phase of a concrete task\./.test(input.content)
              || /You are still inside the same multi-step task\./.test(input.content)
            ) {
              await waitForProviderDelay(input.signal, 120);
              yield {
                delta: toolCall("files", {
                  path: "node-todo/views/index.ejs",
                  startLine: 1,
                  endLine: 4
                })
              };
              return;
            }

            yield {
              delta: [
                "我已经把 node-todo/app.js 的端口配置改成了 process.env.PORT。",
                "接下来我会继续更新 node-todo/views/index.ejs，然后重新运行 node node-todo/verify-setup.mjs 验证。"
              ].join("\n")
            };
            return;
          }

          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo stage-summary chain after resuming from the latest failure point." };
          return;
        }

        if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
          yield {
            delta: toolCall("files", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 3,
              endLine: 3,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 3,
              endLine: 3,
              replacement: '  <input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }
      }

      if (input.content.startsWith('The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        assert.match(input.content, /Original task: 看看项目，然后直接优化 node-todo/);
        yield {
          delta: toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 4
          })
        };
        return;
      }

      if (input.content.startsWith('Original user request: The user replied "还能继续吗" and wants to continue the most recent unfinished task.')) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 3,
              endLine: 3,
              replacement: '  <input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo stage-summary chain after resuming from the latest failure point." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeProjectStageProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  bus.on("approval.requested", (event) => {
    approvalCount += 1;
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: event.sessionId,
      content: `/approve ${event.payload.approvalId}`
    }));
  });

  const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";
  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);
  const firstVerifyPromise = waitForToolExecutionCompleted(bus, session.sessionId, (summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed"));

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: originalPrompt
  }));

  await firstVerifyPromise;
  await waitForBusyPhase(bus, session.sessionId, "assistant");
  await new Promise((resolve) => setTimeout(resolve, 20));
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/app.js:3-3 · updated")
    ),
    "interrupted stage-summary project task should preserve the app.js edit before stop"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node node-todo/verify-setup.mjs · completed")
    ),
    "interrupted stage-summary project task should preserve the near-miss verification before stop"
  );
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/views/index.ejs:1-4")
    ),
    false,
    "interrupted stage-summary project task should stop before reading the pending view file"
  );

  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: "还能继续吗"
  });

  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.match(resumedResult.assistantText, /latest failure point/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-")),
    false,
    "resume follow-up should not restart from package.json after a project stage summary"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-")),
    false,
    "resume follow-up should not reread app.js after the project stage summary already narrowed the next step"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    "resume follow-up should continue directly into the pending view read after the project stage summary"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "resume follow-up should complete the pending view edit after the project stage summary"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")),
    "resume follow-up should finish verification after the resumed project stage-summary edit"
  );
  assert.equal(
    approvalCount,
    2,
    "expected one approval before interruption and one approval for the resumed project stage-summary edit"
  );
}

async function verifyResumeFollowUpAfterApprovalWaitInProjectChain() {
  await verifyApprovalWaitResumeInProjectChain("还能继续吗");
}

async function verifyBareAffirmativeAfterApprovalWaitInProjectChain() {
  await verifyApprovalWaitResumeInProjectChain("可以");
}

async function verifyVagueOptimizationAfterApprovalWaitInProjectChain() {
  await verifyApprovalWaitResumeInProjectChain("帮我优化下");
}

async function verifyApprovalWaitResumeInProjectChain(followUpPrompt: "还能继续吗" | "可以" | "帮我优化下") {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-resume-project-approval-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "node-todo"), { recursive: true });
  await mkdir(join(workspace, "node-todo", "views"), { recursive: true });

  await writeFile(
    join(workspace, "node-todo", "package.json"),
    '{\n  "name": "node-todo",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "node app.js"\n  }\n}\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "app.js"),
    'const express = require("express");\nconst app = express();\nconst PORT = 3000;\napp.listen(PORT, () => {\n  console.log(`Todo app is running at http://localhost:${PORT}`);\n});\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "views", "index.ejs"),
    '<!DOCTYPE html>\n<form action="/add" method="post">\n  <input name="title" />\n</form>\n',
    "utf8"
  );
  await writeFile(
    join(workspace, "node-todo", "verify-setup.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");',
      'const view = readFileSync(new URL("./views/index.ejs", import.meta.url), "utf8");',
      'const appReady = /process\\.env\\.PORT/.test(app);',
      'const viewReady = /maxlength="100"/.test(view);',
      'if (appReady && viewReady) {',
      '  console.log("ready");',
      '} else if (appReady) {',
      '  console.log("app-only");',
      '} else if (viewReady) {',
      '  console.log("view-only");',
      '} else {',
      '  console.log("not-ready");',
      '}'
    ].join("\n") + "\n",
    "utf8"
  );

  class ResumeProjectApprovalProvider implements ProviderClient {
    readonly name = "resume-project-approval-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";

      if (input.content === originalPrompt) {
        yield {
          delta: toolCall("shell", {
            command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
          })
        };
        return;
      }

      if (input.content.startsWith(`Original user request: ${originalPrompt}`)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "shell") {
          if (/You are in the middle of a concrete project inspection request\./.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "node-todo/package.json",
                startLine: 1,
                endLine: 20
              })
            };
            return;
          }

          if (/app-only/.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "node-todo/views/index.ejs",
                startLine: 1,
                endLine: 4
              })
            };
            return;
          }

          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo approval-wait chain after resuming from the pending view edit." };
          return;
        }

        if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
          yield {
            delta: toolCall("files", {
              path: "node-todo/app.js",
              startLine: 1,
              endLine: 20
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/app.js",
              startLine: 3,
              endLine: 3,
              replacement: "const PORT = Number(process.env.PORT || 3000);"
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "node-todo/views/index.ejs",
              startLine: 3,
              endLine: 3,
              replacement: '  <input name="title" maxlength="100" />'
            })
          };
          return;
        }

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }
      }

      if (/^The user replied "(还能继续吗|可以|帮我优化下)" and wants to continue the most recent unfinished task\./.test(input.content)) {
        assert.match(input.content, /Original task: 看看项目，然后直接优化 node-todo/);
        if (/帮我优化下/.test(input.content)) {
          assert.match(input.content, /Resume that task now instead of treating this as a broad optimization follow-up\./);
        }
        assert.match(input.content, /Latest tool in context: files/);
        assert.match(input.content, /Latest tool summary in context: node-todo\/views\/index\.ejs:1-4/);
        assert.match(input.content, /Interrupted pending approval: edit · node-todo\/views\/index\.ejs:3-3/);
        yield {
          delta: toolCall("edit", {
            path: "node-todo/views/index.ejs",
            startLine: 3,
            endLine: 3,
            replacement: '  <input name="title" maxlength="100" />'
          })
        };
        return;
      }

      if (/^Original user request: The user replied "(还能继续吗|可以|帮我优化下)" and wants to continue the most recent unfinished task\./.test(input.content)) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node node-todo/verify-setup.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          assert.match(input.content, /ready/);
          yield { delta: "Completed the node-todo approval-wait chain after resuming from the pending view edit." };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new ResumeProjectApprovalProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  let approvalCount = 0;
  let heldApprovalId: string | undefined;
  let phaseTwo = false;
  const secondApprovalPromise = new Promise<Extract<RuntimeEvent, { type: "approval.requested" }>>((resolve) => {
    bus.on("approval.requested", (event) => {
      approvalCount += 1;

      if (!phaseTwo) {
        if (approvalCount === 1) {
          bus.emit(createTerminalCommandInvokedEvent({
            sessionId: event.sessionId,
            content: `/approve ${event.payload.approvalId}`
          }));
          return;
        }

        heldApprovalId = event.payload.approvalId;
        resolve(event);
        return;
      }

      bus.emit(createTerminalCommandInvokedEvent({
        sessionId: event.sessionId,
        content: `/approve ${event.payload.approvalId}`
      }));
    });
  });

  const originalPrompt = "看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。";
  const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);

  bus.emit(createUserMessageSubmittedEvent({
    sessionId: session.sessionId,
    content: originalPrompt
  }));

  const pendingApproval = await secondApprovalPromise;
  assert.equal(pendingApproval.payload.toolName, "edit");
  assert.match(JSON.stringify(pendingApproval.payload.input), /maxlength="100"/);
  bus.emit(createRuntimeInterruptRequestedEvent({
    sessionId: session.sessionId,
    reason: "cancel"
  }));

  const cancelledTask = await completionPromise;
  assert.equal(cancelledTask.payload.state, "cancelled");

  const interruptedEvents = await transcriptStore.readEventsBySession(session.sessionId);
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/views/index.ejs:1-4")
    ),
    "interrupted approval-wait task should preserve the narrowed pending view file before stop"
  );
  assert.equal(
    interruptedEvents.some((event) =>
      event.type === "tool.execution.completed" && event.payload.summary.startsWith("node-todo/views/index.ejs:3-3 · updated")
    ),
    false,
    "interrupted approval-wait task should stop before the pending approved edit is applied"
  );
  assert.ok(
    interruptedEvents.some((event) =>
      event.type === "approval.resolved"
      && event.payload.approvalId === heldApprovalId
      && !event.payload.approved
    ),
    "stopping during approval should resolve the held approval as denied for the cancelled run"
  );

  phaseTwo = true;
  const resumedResult = await runAgentTask({
    bus,
    transcriptStore,
    sessionId: session.sessionId,
    prompt: followUpPrompt
  });

  const resumedViewContent = await readFile(join(workspace, "node-todo", "views", "index.ejs"), "utf8");
  assert.match(resumedViewContent, /maxlength="100"/);
  assert.match(resumedResult.assistantText, /pending view edit/i);
  assert.doesNotMatch(resumedResult.assistantText, /^(可以|可以继续|好的|sure|okay)\b/i);
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/package.json:1-")),
    false,
    "resume after approval wait should not restart from package.json"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/app.js:1-")),
    false,
    "resume after approval wait should not reread app.js"
  );
  assert.equal(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:1-4")),
    false,
    "resume after approval wait should not reread the same view file before retrying the pending edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node-todo/views/index.ejs:3-3 · updated")),
    "resume after approval wait should continue directly with the pending view edit"
  );
  assert.ok(
    resumedResult.toolSummaries.some((summary) => summary.startsWith("node node-todo/verify-setup.mjs · completed")),
    "resume after approval wait should finish verification after the resumed edit"
  );
  assert.equal(
    approvalCount,
    3,
    "expected one approval for app.js, one denied approval at interruption, and one fresh approval for the resumed view edit"
  );
}

async function verifyNaturalLanguageApprovalShortcuts() {
  const root = await mkdtemp(join(tmpdir(), "selfme-agent-natural-approval-"));
  const workspace = join(root, "workspace");
  const transcriptPath = join(root, "transcript.jsonl");
  const logsPath = join(root, "logs.jsonl");
  await mkdir(workspace, { recursive: true });

  class NaturalApprovalProvider implements ProviderClient {
    readonly name = "natural-approval-provider";

    async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
      if (input.content === "Create natural-approved.txt with the content ok.") {
        yield {
          delta: toolCall("write", {
            path: "natural-approved.txt",
            content: "ok\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create natural-approved.txt with the content ok.")) {
        yield { delta: "Created natural-approved.txt." };
        return;
      }

      if (input.content === "Create natural-denied.txt with the content blocked.") {
        yield {
          delta: toolCall("write", {
            path: "natural-denied.txt",
            content: "blocked\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create natural-denied.txt with the content blocked.")) {
        assert.match(input.content, /The requested tool action was denied by the user\./);
        yield { delta: "Could not create natural-denied.txt because the write was not approved." };
        return;
      }

      if (input.content === "Create natural-numbers.txt with three lines: 4, 5, 6. Then create natural-total.mjs so running `node natural-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.") {
        yield {
          delta: toolCall("write", {
            path: "natural-numbers.txt",
            content: "4\n5\n6\n"
          })
        };
        return;
      }

      if (input.content.startsWith("Original user request: Create natural-numbers.txt with three lines: 4, 5, 6. Then create natural-total.mjs so running `node natural-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing.")) {
        const toolName = extractLine(input.content, "Tool:") ?? extractLine(input.content, "Latest tool:");
        const summary = extractLine(input.content, "Summary:") ?? extractLine(input.content, "Latest summary:") ?? "";

        if (toolName === "write" && /natural-numbers\.txt/.test(summary)) {
          yield {
            delta: toolCall("write", {
              path: "natural-total.mjs",
              content: "console.log(total);\n"
            })
          };
          return;
        }

        if (toolName === "write" && /natural-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node natural-total.mjs"
            })
          };
          return;
        }

        if (toolName === "shell") {
          if (/The latest tool attempt failed\./.test(input.content)) {
            yield {
              delta: toolCall("files", {
                path: "natural-total.mjs",
                startLine: 1,
                endLine: 20
              })
            };
            return;
          }

          assert.match(input.content, /15/);
          yield { delta: "Created the files, repaired natural-total.mjs after verification failed, and confirmed it now prints exactly 15." };
          return;
        }

        if (toolName === "files" && /natural-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("edit", {
              path: "natural-total.mjs",
              startLine: 1,
              endLine: 1,
              replacement: 'import { readFileSync } from "node:fs";\nconst total = readFileSync("natural-numbers.txt", "utf8").trim().split("\\n").map(Number).reduce((sum, value) => sum + value, 0);\nconsole.log(total);'
            })
          };
          return;
        }

        if (toolName === "edit" && /natural-total\.mjs/.test(summary)) {
          yield {
            delta: toolCall("shell", {
              command: "node natural-total.mjs"
            })
          };
          return;
        }
      }

      yield { delta: "ok" };
    }
  }

  const bus = new EventBus();
  const transcriptStore = new TranscriptStore(transcriptPath);
  const logStore = new LogStore(logsPath);
  await transcriptStore.ensureInitialized();
  await logStore.ensureInitialized();

  const session = createDefaultSessionRecord(workspace, VERSION);
  session.model = "regression-stub";

  const runtime = new AgentRuntime({
    bus,
    provider: new NaturalApprovalProvider(),
    tools: new InMemoryToolRegistry(),
    session,
    transcriptStore,
    logStore
  });
  await runtime.start();

  {
    const beforeEvents = await transcriptStore.readEventsBySession(session.sessionId);
    const approvalPromise = waitForApprovalRequest(bus, session.sessionId);
    const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "Create natural-approved.txt with the content ok."
    }));

    const approval = await approvalPromise;
    assert.equal(approval.payload.toolName, "write");

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "可以"
    }));

    const task = await completionPromise;
    assert.equal(task.payload.state, "completed");

    const approvedContent = await readFile(join(workspace, "natural-approved.txt"), "utf8");
    assert.equal(approvedContent, "ok\n");

    const events = (await transcriptStore.readEventsBySession(session.sessionId)).slice(beforeEvents.length);
    const assistantText = collectAssistantText(events, task.taskId ?? "");
    assert.match(assistantText, /Created natural-approved\.txt\./);
    assert.ok(
      events.some((event) =>
        event.type === "approval.resolved"
        && event.payload.approvalId === approval.payload.approvalId
        && event.payload.approved
      ),
      "expected single pending approval to accept a natural-language approval reply"
    );
  }

  {
    const beforeEvents = await transcriptStore.readEventsBySession(session.sessionId);
    const approvalPromise = waitForApprovalRequest(bus, session.sessionId);
    const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "Create natural-denied.txt with the content blocked."
    }));

    const approval = await approvalPromise;
    assert.equal(approval.payload.toolName, "write");

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "拒绝"
    }));

    const task = await completionPromise;
    assert.equal(task.payload.state, "completed");
    await assert.rejects(readFile(join(workspace, "natural-denied.txt"), "utf8"));

    const events = (await transcriptStore.readEventsBySession(session.sessionId)).slice(beforeEvents.length);
    const assistantText = collectAssistantText(events, task.taskId ?? "");
    assert.match(assistantText, /(denied|not approved)/i);
    assert.ok(
      events.some((event) =>
        event.type === "approval.resolved"
        && event.payload.approvalId === approval.payload.approvalId
        && !event.payload.approved
      ),
      "expected single pending approval to accept a natural-language denial reply"
    );
  }

  {
    const beforeEvents = await transcriptStore.readEventsBySession(session.sessionId);
    const approvalPromiseA = waitForApprovalRequest(bus, session.sessionId);
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: session.sessionId,
      content: "/write multi-a.txt\nalpha"
    }));
    const approvalA = await approvalPromiseA;

    const approvalPromiseB = waitForApprovalRequest(bus, session.sessionId);
    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: session.sessionId,
      content: "/write multi-b.txt\nbeta"
    }));
    const approvalB = await approvalPromiseB;

    const runtimeErrorPromise = waitForRuntimeError(bus, session.sessionId);
    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "可以"
    }));

    const runtimeError = await runtimeErrorPromise;
    assert.match(runtimeError.payload.message, /Multiple approvals are pending/);

    bus.emit(createTerminalCommandInvokedEvent({
      sessionId: session.sessionId,
      content: `/deny ${approvalA.payload.approvalId}`
    }));

    await assert.rejects(readFile(join(workspace, "multi-a.txt"), "utf8"));

    const createdMultiBPromise = waitForToolExecutionCompleted(
      bus,
      session.sessionId,
      (summary) => summary.startsWith("multi-b.txt · created")
    );
    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "可以"
    }));

    await createdMultiBPromise;

    const multiBContent = await readFile(join(workspace, "multi-b.txt"), "utf8");
    assert.equal(multiBContent, "beta");

    const events = (await transcriptStore.readEventsBySession(session.sessionId)).slice(beforeEvents.length);
    const resolvedApprovals = events.filter((event): event is Extract<RuntimeEvent, { type: "approval.resolved" }> =>
      event.type === "approval.resolved"
    );

    assert.equal(
      resolvedApprovals.some((event) => event.payload.approvalId === approvalA.payload.approvalId),
      true,
      "expected the explicit deny to resolve the first pending approval"
    );
    assert.equal(
      resolvedApprovals.some((event) => event.payload.approvalId === approvalB.payload.approvalId),
      true,
      "expected the later natural-language approval to resolve the remaining pending approval"
    );
    assert.equal(
      resolvedApprovals.filter((event) => event.payload.approvalId === approvalA.payload.approvalId).length,
      1,
      "expected no duplicate resolution for the first approval after the ambiguous natural-language reply"
    );
    assert.equal(
      resolvedApprovals.filter((event) => event.payload.approvalId === approvalB.payload.approvalId).length,
      1,
      "expected the second approval to resolve exactly once"
    );
  }

  {
    const beforeEvents = await transcriptStore.readEventsBySession(session.sessionId);
    const approvalPromise = waitForApprovalRequest(bus, session.sessionId);
    const completionPromise = waitForAssistantTaskCompletion(bus, session.sessionId);

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "Create natural-numbers.txt with three lines: 4, 5, 6. Then create natural-total.mjs so running `node natural-total.mjs` prints exactly `15`. Verify it and fix any errors before finishing."
    }));

    const approval = await approvalPromise;
    assert.equal(approval.payload.toolName, "write");

    bus.emit(createUserMessageSubmittedEvent({
      sessionId: session.sessionId,
      content: "可以"
    }));

    const task = await completionPromise;
    assert.equal(task.payload.state, "completed");

    const numbersContent = await readFile(join(workspace, "natural-numbers.txt"), "utf8");
    const totalContent = await readFile(join(workspace, "natural-total.mjs"), "utf8");
    assert.equal(numbersContent, "4\n5\n6\n");
    assert.match(totalContent, /natural-numbers\.txt/);
    assert.match(totalContent, /reduce/);

    const events = (await transcriptStore.readEventsBySession(session.sessionId)).slice(beforeEvents.length);
    const assistantText = collectAssistantText(events, task.taskId ?? "");
    const toolSummaries = events
      .filter((event): event is Extract<RuntimeEvent, { type: "tool.execution.completed" }> => event.type === "tool.execution.completed")
      .map((event) => event.payload.summary);

    assert.match(assistantText, /15/);
    assert.equal(
      events.filter((event) => event.type === "approval.requested").length,
      1,
      "expected a single approval before the long task continues through write, repair, and verify"
    );
    assert.ok(
      events.some((event) =>
        event.type === "approval.resolved"
        && event.payload.approvalId === approval.payload.approvalId
        && event.payload.approved
      ),
      "expected natural-language approval to unblock the long task"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("natural-numbers.txt · created")),
      "expected first approved write to run"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("natural-total.mjs · created")),
      "expected second write to continue under the same approval"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("node natural-total.mjs · failed (1)")),
      "expected verification failure after approval"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("natural-total.mjs:1-1")),
      "expected targeted file read after the verification failure"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("natural-total.mjs:1-1 · updated")),
      "expected repair edit after the verification failure"
    );
    assert.ok(
      toolSummaries.some((summary) => summary.startsWith("node natural-total.mjs · completed")),
      "expected final successful verification after repair"
    );
  }
}

function verifyInterruptFallbackWhenWorkingUiLingers() {
  const bus = new EventBus();
  const editor = new EditorController();
  const panel = new TerminalPanelController();
  const sessionId = "terminal-interrupt-fallback";
  const interruptReasons: string[] = [];
  const originalExit = process.exit;
  const existingDataListeners = process.stdin.listeners("data") as Array<(...args: any[]) => void>;

  const terminal = new TerminalEventLoop({
    bus,
    editor,
    panel,
    renderer: {
      hasInterruptibleVisualState: () => true
    } as never,
    sessionId
  });

  bus.on("runtime.interrupt.requested", (event) => {
    if (event.sessionId === sessionId) {
      interruptReasons.push(event.payload.reason);
    }
  });

  (process as typeof process & {
    exit: (code?: number) => never;
  }).exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) should not be called while interruptible UI is still visible`);
  }) as typeof process.exit;

  try {
    terminal.start();
    process.stdin.emit("data", "\u001b");
    process.stdin.emit("data", "\u0003");

    assert.deepEqual(interruptReasons, ["cancel", "quit"]);
  } finally {
    process.exit = originalExit;

    for (const listener of process.stdin.listeners("data") as Array<(...args: any[]) => void>) {
      if (!existingDataListeners.includes(listener)) {
        process.stdin.off("data", listener);
      }
    }
  }
}

function waitForAssistantTaskCompletion(bus: EventBus, sessionId: string) {
  return new Promise<TaskStateChangedEvent>((resolve) => {
    const off = bus.on("task.state.changed", (event) => {
      if (event.sessionId !== sessionId || event.payload.title !== "Respond to user input") {
        return;
      }

      if (event.payload.state === "completed" || event.payload.state === "failed" || event.payload.state === "cancelled") {
        off();
        resolve(event);
      }
    });
  });
}

function waitForBusyPhase(
  bus: EventBus,
  sessionId: string,
  phase: "assistant" | "tool" | "approval"
) {
  return new Promise<void>((resolve) => {
    const off = bus.on("runtime.busy.changed", (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      if (event.payload.active && event.payload.phase === phase) {
        off();
        resolve();
      }
    });
  });
}

function waitForApprovalRequest(bus: EventBus, sessionId: string) {
  return new Promise<Extract<RuntimeEvent, { type: "approval.requested" }>>((resolve) => {
    const off = bus.on("approval.requested", (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      off();
      resolve(event);
    });
  });
}

function waitForToolExecutionCompleted(
  bus: EventBus,
  sessionId: string,
  predicate: (summary: string) => boolean
) {
  return new Promise<Extract<RuntimeEvent, { type: "tool.execution.completed" }>>((resolve) => {
    const off = bus.on("tool.execution.completed", (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      if (!predicate(event.payload.summary)) {
        return;
      }

      off();
      resolve(event);
    });
  });
}

function waitForRuntimeError(bus: EventBus, sessionId: string) {
  return new Promise<Extract<RuntimeEvent, { type: "runtime.error.raised" }>>((resolve) => {
    const off = bus.on("runtime.error.raised", (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      off();
      resolve(event);
    });
  });
}

async function waitForProviderDelay(signal: AbortSignal | undefined, ms: number) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      const error = new Error("Provider stream aborted");
      error.name = "AbortError";
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function collectAssistantText(events: RuntimeEvent[], taskId: string) {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "assistant.delta.received" }> =>
      event.type === "assistant.delta.received" && event.taskId === taskId
    )
    .map((event) => event.payload.delta)
    .join("");
}

function collectAssistantTurns(events: RuntimeEvent[], taskId: string) {
  const turns: string[] = [];
  let current = "";

  for (const event of events) {
    if (event.taskId !== taskId) {
      continue;
    }

    if (event.type === "assistant.delta.received") {
      current += event.payload.delta;
      continue;
    }

    if (event.type === "assistant.completed") {
      if (current.trim().length > 0) {
        turns.push(current);
        current = "";
      }
    }
  }

  if (current.trim().length > 0) {
    turns.push(current);
  }

  return turns;
}

function verifyToolSummaryFormatting() {
  assert.equal(formatToolSummaryLine("files", "node-todo/app.js:1-174"), "Files · node-todo/app.js:1-174");
  assert.equal(formatToolSummaryLine("shell", "shell · pwd · completed"), "Shell · pwd · completed");
  assert.equal(formatToolSummaryLine("edit", ""), "Edit · Completed");
  assert.equal(formatToolSummaryLine("shell", "completed"), "Shell · completed");
}

function verifyContextCompaction() {
  const sessionId = "compaction-session";
  const events: RuntimeEvent[] = [];

  events.push(createTerminalCommandInvokedEvent({
    sessionId,
    content: "/help"
  }));

  for (let index = 1; index <= 5; index += 1) {
    const taskId = `older-${index}`;
    events.push(createUserMessageSubmittedEvent({
      sessionId,
      content: `Older request ${index}`
    }));
    events.push(createAssistantDeltaEvent({
      sessionId,
      taskId,
      delta: `Older answer ${index}`
    }));
    events.push(createAssistantCompletedEvent({
      sessionId,
      taskId,
      model: "regression-stub"
    }));
  }

  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-older",
    toolName: "shell",
    summary: "yes · timed out · truncated",
    rawOutput: "Y".repeat(10_000)
  }));

  for (let index = 6; index <= 9; index += 1) {
    const taskId = `recent-${index}`;
  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: index === 9
      ? "Run `node greet.mjs`, fix greet.mjs so it prints exactly `Hello, SelfMe!`, and keep verifying until it is correct."
      : `Recent request ${index}`
  }));
    events.push(createAssistantDeltaEvent({
      sessionId,
      taskId,
      delta: `Recent answer ${index}`
    }));
    events.push(createAssistantCompletedEvent({
      sessionId,
      taskId,
      model: "regression-stub"
    }));
  }

  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent",
    toolName: "files",
    summary: "checklist.md:1-3",
    rawOutput: "   1 | - buy milk\n   2 | - ship cli\n   3 | - test tools"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-2",
    toolName: "shell",
    summary: "pwd · completed",
    rawOutput: "/workspace"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-3",
    toolName: "shell",
    summary: "ls · completed",
    rawOutput: "a\nb\nc"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-4",
    toolName: "shell",
    summary: "node greet.mjs · failed (1)",
    rawOutput: "ReferenceError: greeting is not defined"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-5",
    toolName: "edit",
    summary: "greet.mjs:1-1 · updated (1 -> 1 lines)"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-6",
    toolName: "shell",
    summary: "node greet.mjs · completed",
    rawOutput: "Hello, SelfMe!"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-7",
    toolName: "files",
    summary: "notes.md:1-3",
    rawOutput: "1 | scratch\n2 | unrelated\n3 | tail"
  }));

  const messages = buildContextMessages(events);
  const merged = messages.map((message) => `${message.role}: ${message.content}`).join("\n");
  const recentUsers = messages.filter((message) => message.role === "user").map((message) => message.content);
  const recentAssistants = messages.filter((message) => message.role === "assistant").map((message) => message.content);
  const recentNotesMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent session notes:"))?.content ?? "";
  const recentCodingNotesMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent coding notes:"))?.content ?? "";
  const recentRepairThreadMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent repair thread:"))?.content ?? "";
  const recentTaskStateMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent task state:"))?.content ?? "";

  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Earlier session summary:")));
  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Recent session notes:")));
  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Recent coding notes:")));
  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Recent repair thread:")));
  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Recent task state:")));
  assert.match(merged, /yes · timed out · truncated/);
  assert.doesNotMatch(merged, /\/help/);
  assert.doesNotMatch(recentNotesMessage, /checklist\.md:1-3/);
  assert.doesNotMatch(recentNotesMessage, /pwd · completed/);
  assert.match(recentNotesMessage, /node greet\.mjs · failed \(1\)/);
  assert.match(recentNotesMessage, /greet\.mjs:1-1 · updated/);
  assert.match(recentNotesMessage, /node greet\.mjs · completed/);
  assert.match(recentCodingNotesMessage, /Read checklist\.md/);
  assert.match(recentCodingNotesMessage, /Updated greet\.mjs/);
  assert.match(recentCodingNotesMessage, /Verified with node greet\.mjs/);
  assert.doesNotMatch(recentCodingNotesMessage, /\bpwd\b/);
  assert.doesNotMatch(recentCodingNotesMessage, /\bls\b/);
  assert.match(recentRepairThreadMessage, /Last failure: node greet\.mjs · failed \(1\)/);
  assert.match(recentRepairThreadMessage, /Failure reason: ReferenceError: greeting is not defined/);
  assert.doesNotMatch(recentRepairThreadMessage, /Last read:/);
  assert.match(recentRepairThreadMessage, /Last change: Updated greet\.mjs/);
  assert.match(recentRepairThreadMessage, /Last verification: node greet\.mjs/);
  assert.match(recentRepairThreadMessage, /Last observed output: Hello, SelfMe!/);
  assert.match(recentTaskStateMessage, /Current request: Run `node greet\.mjs`, fix greet\.mjs so it prints exactly `Hello, SelfMe!`, and keep verifying until it is correct\./);
  assert.match(recentTaskStateMessage, /Target output: Hello, SelfMe!/);
  assert.match(recentTaskStateMessage, /Target verification: node greet\.mjs/);
  assert.match(recentTaskStateMessage, /Working files: greet\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /checklist\.md/);
  assert.doesNotMatch(recentTaskStateMessage, /notes\.md/);
  assert.match(recentTaskStateMessage, /Last failure: node greet\.mjs · failed \(1\)/);
  assert.match(recentTaskStateMessage, /Last observed output: Hello, SelfMe!/);
  assert.doesNotMatch(merged, /Y{100}/);
  assert.deepEqual(recentUsers, [
    "Recent request 7",
    "Recent request 8",
    "Run `node greet.mjs`, fix greet.mjs so it prints exactly `Hello, SelfMe!`, and keep verifying until it is correct."
  ]);
  assert.deepEqual(recentAssistants, ["Recent answer 7", "Recent answer 8", "Recent answer 9"]);
}

function verifyContextCompactionSwitchesMainTask() {
  const sessionId = "compaction-switch-session";
  const events: RuntimeEvent[] = [];

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Run `node greet.mjs`, fix greet.mjs so it prints exactly `Hello, SelfMe!`, and keep verifying until it is correct."
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "switch-tool-1",
    toolName: "shell",
    summary: "node greet.mjs · failed (1)",
    rawOutput: "ReferenceError: greeting is not defined"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "switch-tool-2",
    toolName: "edit",
    summary: "greet.mjs:1-1 · updated (1 -> 1 lines)"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "switch-tool-3",
    toolName: "shell",
    summary: "node greet.mjs · completed",
    rawOutput: "Hello, SelfMe!"
  }));

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Run `node report.mjs`, fix report.mjs so it prints exactly `SelfMe:3000`, and keep verifying until it is correct."
  }));

  const messages = buildContextMessages(events);
  const recentTaskStateMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent task state:"))?.content ?? "";
  const recentRepairThreadMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent repair thread:"))?.content ?? "";

  assert.match(recentTaskStateMessage, /Current request: Run `node report\.mjs`, fix report\.mjs so it prints exactly `SelfMe:3000`, and keep verifying until it is correct\./);
  assert.match(recentTaskStateMessage, /Target output: SelfMe:3000/);
  assert.match(recentTaskStateMessage, /Target verification: node report\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /greet\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /Hello, SelfMe!/);
  assert.doesNotMatch(recentTaskStateMessage, /Last failure:/);
  assert.doesNotMatch(recentTaskStateMessage, /Last observed output:/);
  assert.doesNotMatch(recentRepairThreadMessage, /greet\.mjs/);
  assert.doesNotMatch(recentRepairThreadMessage, /Hello, SelfMe!/);
}

function verifyContextCompactionPrefersLatestVerificationCommand() {
  const sessionId = "compaction-multi-command-session";
  const events: RuntimeEvent[] = [];

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Run `node smoke-a.mjs`, then fix report.mjs so running `node report.mjs` prints exactly `SelfMe:3000`, and keep verifying until it is correct."
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "multi-tool-1",
    toolName: "shell",
    summary: "node smoke-a.mjs · completed",
    rawOutput: "warmup"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "multi-tool-2",
    toolName: "shell",
    summary: "node report.mjs · failed (1)",
    rawOutput: "ReferenceError: config is not defined"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "multi-tool-3",
    toolName: "edit",
    summary: "report.mjs:1-2 · updated (2 -> 2 lines)"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "multi-tool-4",
    toolName: "shell",
    summary: "node report.mjs · completed",
    rawOutput: "SelfMe:3000"
  }));

  const messages = buildContextMessages(events);
  const recentRepairThreadMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent repair thread:"))?.content ?? "";
  const recentTaskStateMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent task state:"))?.content ?? "";

  assert.match(recentTaskStateMessage, /Target output: SelfMe:3000/);
  assert.match(recentTaskStateMessage, /Target verification: node report\.mjs/);
  assert.match(recentTaskStateMessage, /Working files: report\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /warmup/);
  assert.match(recentTaskStateMessage, /Last failure: node report\.mjs · failed \(1\)/);
  assert.match(recentTaskStateMessage, /Last observed output: SelfMe:3000/);
  assert.doesNotMatch(recentTaskStateMessage, /Target verification: node smoke-a\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /Working files: .*smoke-a\.mjs/);
  assert.doesNotMatch(recentTaskStateMessage, /Last failure: node smoke-a\.mjs/);
  assert.match(recentRepairThreadMessage, /Last failure: node report\.mjs · failed \(1\)/);
  assert.match(recentRepairThreadMessage, /Last change: Updated report\.mjs/);
  assert.match(recentRepairThreadMessage, /Last verification: node report\.mjs/);
  assert.match(recentRepairThreadMessage, /Last observed output: SelfMe:3000/);
  assert.doesNotMatch(recentRepairThreadMessage, /smoke-a\.mjs/);
  assert.doesNotMatch(recentRepairThreadMessage, /warmup/);
}

function verifyContextCompactionExtractsQuotedTargetOutput() {
  const sessionId = "compaction-quoted-output-session";
  const events: RuntimeEvent[] = [];

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: 'Fix greet.mjs so it prints exactly "Scoped". Verify it.'
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "quoted-tool-1",
    toolName: "edit",
    summary: "greet.mjs:1-1 · updated (1 -> 1 lines)"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "quoted-tool-2",
    toolName: "shell",
    summary: "node greet.mjs · completed",
    rawOutput: "Scoped"
  }));

  const messages = buildContextMessages(events);
  const recentTaskStateMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent task state:"))?.content ?? "";

  assert.match(recentTaskStateMessage, /Current request: Fix greet\.mjs so it prints exactly "Scoped"\. Verify it\./);
  assert.match(recentTaskStateMessage, /Target output: Scoped/);
  assert.match(recentTaskStateMessage, /Working files: greet\.mjs/);
  assert.match(recentTaskStateMessage, /Last observed output: Scoped/);
}

function verifyContextCompactionPreservesAssistantStageBoundaries() {
  const sessionId = "compaction-assistant-stages";
  const events: RuntimeEvent[] = [];

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Fix the startup script and keep working until it is correct."
  }));
  events.push(createAssistantDeltaEvent({
    sessionId,
    taskId: "stage-turn",
    delta: "I will inspect the config first."
  }));
  events.push(createAssistantCompletedEvent({
    sessionId,
    taskId: "stage-turn",
    model: "regression-stub"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "stage-tool",
    toolName: "files",
    summary: "app.config.json:1-4",
    rawOutput: '{ "name": "SelfMe", "port": 3000 }'
  }));
  events.push(createAssistantDeltaEvent({
    sessionId,
    taskId: "stage-turn",
    delta: "I found the issue and verified the final output."
  }));
  events.push(createAssistantCompletedEvent({
    sessionId,
    taskId: "stage-turn",
    model: "regression-stub"
  }));

  const messages = buildContextMessages(events);
  const recentAssistants = messages.filter((message) => message.role === "assistant").map((message) => message.content);

  assert.deepEqual(recentAssistants, [
    "I will inspect the config first.",
    "I found the issue and verified the final output."
  ]);
}

function verifyContextCompactionKeepsWholeTurns() {
  const sessionId = "compaction-pending-session";
  const events: RuntimeEvent[] = [];

  for (let index = 1; index <= 4; index += 1) {
    const taskId = `turn-${index}`;
    events.push(createUserMessageSubmittedEvent({
      sessionId,
      content: `Request ${index}`
    }));
    events.push(createAssistantDeltaEvent({
      sessionId,
      taskId,
      delta: `Answer ${index}`
    }));
    events.push(createAssistantCompletedEvent({
      sessionId,
      taskId,
      model: "regression-stub"
    }));
  }

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Request 5"
  }));

  const messages = buildContextMessages(events);
  const recentUsers = messages.filter((message) => message.role === "user").map((message) => message.content);
  const recentAssistants = messages.filter((message) => message.role === "assistant").map((message) => message.content);

  assert.deepEqual(recentUsers, ["Request 3", "Request 4", "Request 5"]);
  assert.deepEqual(recentAssistants, ["Answer 3", "Answer 4"]);
}

function verifyIncompleteSlashCommandHandling() {
  assert.equal(
    getIncompleteSlashCommandNotice("/help extra")?.message,
    "Command does not take additional input: /help"
  );
  assert.equal(
    getIncompleteSlashCommandNotice("/stop now")?.message,
    "Command does not take additional input: /stop"
  );
  assert.equal(
    getIncompleteSlashCommandNotice("/read")?.message,
    "Command requires more input: /read <path[:start-end]> [--max-bytes N]"
  );
  assert.equal(
    getIncompleteSlashCommandNotice("/shell ")?.message,
    "Command requires more input: /shell <command>"
  );
  assert.equal(
    getIncompleteSlashCommandNotice("/approve")?.message,
    "Command requires an approval id: /approve <approval-id>"
  );
  assert.equal(getIncompleteSlashCommandNotice("/help"), undefined);
  assert.equal(getIncompleteSlashCommandNotice("/shell echo hi"), undefined);
  assert.equal(
    getIncompleteSlashCommandNotice("/write\nhello")?.message,
    "Command requires more input: /write <path>"
  );
}

function verifyMultilineSlashCommands() {
  assert.deepEqual(parseToolCommand("/write note.txt\nalpha\nbeta"), {
    toolName: "write",
    input: {
      path: "note.txt",
      content: "alpha\nbeta"
    }
  });

  assert.deepEqual(parseToolCommand("/edit note.txt:2-3\nSELFME"), {
    toolName: "edit",
    input: {
      path: "note.txt",
      startLine: 2,
      endLine: 3,
      replacement: "SELFME"
    }
  });
}

function verifyContextCompactionClipsLongRecentTurns() {
  const sessionId = "compaction-long-recent-session";
  const events: RuntimeEvent[] = [];
  const longUser = `Explain this file carefully: ${"U".repeat(1800)}`;
  const longAssistant = `Result: ${"A".repeat(1800)}`;

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Older request"
  }));
  events.push(createAssistantDeltaEvent({
    sessionId,
    taskId: "older-turn",
    delta: "Older answer"
  }));
  events.push(createAssistantCompletedEvent({
    sessionId,
    taskId: "older-turn",
    model: "regression-stub"
  }));

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Recent request 1"
  }));
  events.push(createAssistantDeltaEvent({
    sessionId,
    taskId: "recent-turn-1",
    delta: "Recent answer 1"
  }));
  events.push(createAssistantCompletedEvent({
    sessionId,
    taskId: "recent-turn-1",
    model: "regression-stub"
  }));

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: longUser
  }));
  events.push(createAssistantDeltaEvent({
    sessionId,
    taskId: "recent-turn-2",
    delta: longAssistant
  }));
  events.push(createAssistantCompletedEvent({
    sessionId,
    taskId: "recent-turn-2",
    model: "regression-stub"
  }));

  events.push(createUserMessageSubmittedEvent({
    sessionId,
    content: "Recent request 3"
  }));

  const messages = buildContextMessages(events);
  const recentUsers = messages.filter((message) => message.role === "user").map((message) => message.content);
  const recentAssistants = messages.filter((message) => message.role === "assistant").map((message) => message.content);
  const clippedUser = recentUsers[1] ?? "";
  const clippedAssistant = recentAssistants[1] ?? "";

  assert.equal(recentUsers.length, 3);
  assert.equal(recentAssistants.length, 2);
  assert.ok(clippedUser.length <= 1400, "expected recent user content to be clipped");
  assert.ok(clippedAssistant.length <= 1200, "expected recent assistant content to be clipped");
  assert.ok(clippedUser.endsWith("..."), "expected clipped recent user content to end with ellipsis");
  assert.ok(clippedAssistant.endsWith("..."), "expected clipped recent assistant content to end with ellipsis");
  assert.doesNotMatch(clippedUser, /U{1500}/);
  assert.doesNotMatch(clippedAssistant, /A{1500}/);
}

function resolveProviderResponse(content: string) {
  if (content.startsWith('Fix greet.mjs so it prints "Hello, SelfMe!"')) {
    return toolCall("files", {
      path: "greet.mjs",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith('Fix greet.mjs so it prints exactly "Scoped". Verify it.')) {
    return toolCall("edit", {
      path: "greet.mjs",
      startLine: 1,
      endLine: 1,
      replacement: 'console.log("Scoped");'
    });
  }

  if (content.startsWith("Create checklist.md with exactly three bullet points")) {
    return toolCall("write", {
      path: "checklist.md",
      content: "- buy milk\n- ship cli\n- test tools\n"
    });
  }

  if (content.startsWith("Create math.mjs so running `node math.mjs` prints exactly `42`.")) {
    return toolCall("write", {
      path: "math.mjs",
      content: "console.log(answer);\n"
    });
  }

  if (content.startsWith("Create numbers.txt with three lines: 4, 5, 6.")) {
    return toolCall("write", {
      path: "numbers.txt",
      content: "4\n5\n6\n"
    });
  }

  if (content.startsWith("Read node-todo/app.js and tell me what you want to improve next")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read node-todo/app.js and improve it by making the port configuration use process.env.PORT. Do the change directly.")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly.")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly and do not ask for confirmation first.")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly.")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly, and do not stop after only one file.")) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content === "看看项目") {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content === "你能一次性都帮我看完整个项目吗") {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content === "看看项目然后帮我优化下") {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content === "看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。") {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content === "看看项目，但先别改，告诉我如果重写 node-todo，并运行 `node node-todo/verify-exact.mjs` 验证直到输出 exactly `ready`，你会怎么做。") {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，再给 node-todo/package.json 加上 dev script，再把 node-todo/verify-setup.mjs 里的 ready 改成 ready-ok。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith("看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-exact.mjs` 验证，直到输出 exactly `ready`。")) {
    return toolCall("shell", {
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
    });
  }

  if (content.startsWith('The user replied "帮我优化下" and wants you to optimize the most recently inspected project or file now.')) {
    if (/Recent editable working file: node-todo\/app\.js/.test(content)) {
      return toolCall("files", {
        path: "node-todo/app.js",
        startLine: 1,
        endLine: 20
      });
    }

    return toolCall("files", {
      path: "node-todo/package.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith('The user replied "你能帮我重新写个项目吗" and wants you to rewrite the most recently inspected project or file now.')) {
    if (/Recent editable working file: node-todo\/app\.js/.test(content)) {
      return toolCall("files", {
        path: "node-todo/app.js",
        startLine: 1,
        endLine: 20
      });
    }

    return toolCall("files", {
      path: "node-todo/package.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (/^The user replied ".+" and wants you to inspect the most recently active whole project now\./.test(content)) {
    return toolCall("files", {
      path: "node-todo/package.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (/^The user replied ".+" and wants you to inspect the most recently active project or file now\./.test(content)) {
    if (/Recent editable working file: node-todo\/app\.js/.test(content)) {
      return toolCall("files", {
        path: "node-todo/app.js",
        startLine: 1,
        endLine: 20
      });
    }

    return toolCall("files", {
      path: "node-todo/package.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (/^The user replied ".+" and wants you to execute the immediately previous rewrite proposal now\./.test(content)) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("The user asked for only the next step, not a broad plan.")) {
    return "Next step I can directly modify node-todo/app.js and first improve the port configuration.";
  }

  if (content.includes("The user asked for only the next step, not a broad plan.")) {
    return "Next step I can directly modify node-todo/app.js and first improve the port configuration.";
  }

  if (/^The user replied ".+" to approve the immediately previous proposal\./.test(content)) {
    return toolCall("files", {
      path: "node-todo/app.js",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json, then create print-config.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json, then create startup-report.mjs")) {
    return "I will inspect the config first, then create and verify the script.";
  }

  if (content.startsWith("Read app.config.json and fix converge-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix vague-finish-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and repair existing retry-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix stubborn-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix stubborn-question-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix stubborn-proposal-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json, then repair existing anchored-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix explain-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix failure-stop-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix premature-edit-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix over-verify-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix question-finish-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix history-heavy-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix failure-recap-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix unrelated-anchor-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/runtime.json, then create render-runtime-label.mjs and render-region-label.mjs and repair existing show-runtime-chain.mjs")) {
    return toolCall("files", {
      path: "config/runtime.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/runtime.json, then create render-runtime-core.mjs, render-runtime-region.mjs, and render-runtime-suffix.mjs, and repair existing deep-runtime-chain.mjs")) {
    return toolCall("files", {
      path: "config/runtime.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json, then create delayed-report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Run `node src/healthcheck.mjs`, fix the existing files so it prints exactly `SelfMe:3000`")) {
    return toolCall("shell", {
      command: "node src/healthcheck.mjs"
    });
  }

  if (content.startsWith("Run `node src/bridge.mjs`, fix the existing files so it prints exactly `SelfMe:ready`")) {
    return toolCall("shell", {
      command: "node src/bridge.mjs"
    });
  }

  if (content.startsWith("Run `node src/bridge-switch.mjs`, fix the existing files so it prints exactly `SelfMe:ready`")) {
    return toolCall("shell", {
      command: "node src/bridge-switch.mjs"
    });
  }

  if (content.startsWith("Run `node src/preview.mjs`, repair the existing file so it prints exactly `SelfMe local`")) {
    return toolCall("shell", {
      command: "node src/preview.mjs"
    });
  }

  if (content.startsWith("读取 app.config.json，然后修复 serve.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json and fix report.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Run `node smoke-a.mjs`, then fix report.mjs so running `node report.mjs` prints exactly `SelfMe:3000` on one line.")) {
    return toolCall("shell", {
      command: "node smoke-a.mjs"
    });
  }

  if (content.startsWith("Use app.config.json and numbers.txt to repair existing dashboard.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Inspect catalog.txt and repair existing status.mjs")) {
    return toolCall("files", {
      path: "catalog.txt",
      startLine: 1,
      endLine: 2000
    });
  }

  if (content.startsWith("Read config/theme.json and repair existing src/banner.mjs")) {
    return toolCall("files", {
      path: "config/theme.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/profile.json, then create src/lib/render-label.mjs and repair existing src/runner.mjs")) {
    return toolCall("files", {
      path: "config/profile.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/profile.json, then create src/lib/render-stage-label.mjs and repair existing src/runner-stage.mjs")) {
    return toolCall("files", {
      path: "config/profile.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/profile.json, then create src/lib/render-stage-echo.mjs and repair existing src/runner-stage-echo.mjs")) {
    return toolCall("files", {
      path: "config/profile.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/profile.json, then create src/lib/render-stage-progress.mjs and repair existing src/runner-stage-progress.mjs")) {
    return toolCall("files", {
      path: "config/profile.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/runtime.json and repair existing src/lib/format-runtime.mjs plus src/console.mjs")) {
    return toolCall("files", {
      path: "config/runtime.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/runtime.json and repair existing src/lib/format-runtime-explain.mjs plus src/console-explain.mjs")) {
    return toolCall("files", {
      path: "config/runtime.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/service.json and repair existing src/lib/render-service-stubborn.mjs plus src/service-stubborn.mjs")) {
    return toolCall("files", {
      path: "config/service.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/service.json, then create src/lib/render-service.mjs and repair existing src/service.mjs")) {
    return toolCall("files", {
      path: "config/service.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/endpoint.json, then create src/shared/render-endpoint.mjs and repair existing src/api/serve-endpoint.mjs")) {
    return toolCall("files", {
      path: "config/endpoint.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/release.json, then create src/templates/release-label.txt and repair existing src/docs/show-release.mjs")) {
    return toolCall("files", {
      path: "config/release.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/badge.json, then create src/templates/badge-label.txt and repair existing src/docs/show-badge.mjs")) {
    return toolCall("files", {
      path: "config/badge.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/portal.json and inspect existing src/web/show-portal.mjs")) {
    return toolCall("files", {
      path: "config/portal.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/audit.json and inspect existing src/web/show-audit.mjs")) {
    return toolCall("files", {
      path: "config/audit.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read config/report.json, then create src/data/status-lines.csv and repair existing src/reports/show-status.mjs")) {
    return toolCall("files", {
      path: "config/report.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Check whether missing.txt exists and answer briefly.")) {
    return toolCall("files", {
      path: "missing.txt",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Tell me the current working directory by running pwd.")) {
    return [
      "I'll check.",
      "<tool_call>",
      "```json",
      JSON.stringify({
        tool: "shell",
        input: {
          command: "pwd"
        }
      }),
      "```",
      "</tool_call>"
    ].join("\n");
  }

  if (content.startsWith("Tell me the current working directory again, but do it via your shell tool.")) {
    return [
      "Sure.",
      "<tool_call>",
      "{“tool”:“shell”,“input”:{“command”:“pwd”}};"
    ].join("\n");
  }

  if (content.startsWith("运行 sh -lc 'echo out; echo err 1>&2; exit 1'")) {
    return toolCall("shell", {
      command: "sh -lc 'echo out; echo err 1>&2; exit 1'"
    });
  }

  if (content.startsWith("运行 pwd")) {
    return toolCall("shell", {
      command: "pwd"
    });
  }

  if (content.startsWith("run pwd")) {
    return toolCall("shell", {
      command: "pwd"
    });
  }

  if (content.startsWith("sh -lc 'echo out; echo err 1>&2; exit 1'")) {
    return toolCall("shell", {
      command: "sh -lc 'echo out; echo err 1>&2; exit 1'"
    });
  }

  if (content.startsWith("Run ls.")) {
    return toolCall("shell", {
      command: "ls"
    });
  }

  if (content.startsWith("Run rm greet.mjs.")) {
    return toolCall("shell", {
      command: "rm greet.mjs"
    });
  }

  if (content.startsWith("Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, and status.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, status.mjs, and console.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
    });
  }

  if (content.startsWith("Create blocked.txt with the content hidden.")) {
    return toolCall("write", {
      path: "blocked.txt",
      content: "hidden\n"
    });
  }

  if (content.startsWith('Change greet.mjs so it prints "Blocked".')) {
    return toolCall("edit", {
      path: "greet.mjs",
      startLine: 1,
      endLine: 1,
      replacement: 'console.log("Blocked");'
    });
  }

  if (content.startsWith('Original user request: Fix greet.mjs so it prints exactly "Scoped". Verify it.')) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "edit" && /greet\.mjs/.test(summary)) {
      return toolCall("write", {
        path: "rogue.txt",
        content: "hidden\n"
      });
    }

    if (toolName === "write" && /rogue\.txt/.test(summary)) {
      return toolCall("shell", {
        command: "node greet.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /Scoped/);
      return 'Fixed greet.mjs, kept the unrelated write behind its own approval, and verified it prints Scoped.';
    }
  }

  if (content.startsWith("Original user request: Read node-todo/app.js and tell me what you want to improve next")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return [
        "I reviewed node-todo/app.js.",
        "Next step I can improve the port configuration.",
        "I can also add stronger error handling after that."
      ].join("\n");
    }
  }

  if (content.startsWith("Original user request: Read node-todo/app.js and improve it by making the port configuration use process.env.PORT. Do the change directly.")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      if (/Your previous assistant message was only a progress update, not a completed result\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "I reviewed node-todo/app.js. Next I will update the port configuration to use process.env.PORT.";
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "Updated node-todo/app.js so the port configuration now uses process.env.PORT.";
    }
  }

  if (content.startsWith("Original user request: Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly.")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "node-todo/app.js hardcodes the port; switching it to process.env.PORT will make the app deploy more cleanly.";
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "Refactored node-todo/app.js so the port configuration now uses process.env.PORT.";
    }
  }

  if (content.startsWith("Original user request: Refactor node-todo/app.js so the port configuration uses process.env.PORT. Make the change directly and do not ask for confirmation first.")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "I can update the port configuration to use process.env.PORT now. Do you want me to make that change?";
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "Refactored node-todo/app.js so the port configuration now uses process.env.PORT.";
    }
  }

  if (content.startsWith("Original user request: Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly.")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return [
        "I updated node-todo/app.js so the port configuration now uses process.env.PORT.",
        "Next I can update node-todo/views/index.ejs so the title input has maxlength 100."
      ].join("\n");
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return "I optimized node-todo/app.js to use process.env.PORT and updated node-todo/views/index.ejs so the title input now has maxlength 100.";
    }
  }

  if (content.startsWith("Original user request: Optimize node-todo by updating node-todo/app.js to use process.env.PORT and updating node-todo/views/index.ejs so the title input has maxlength 100. Do the changes directly, and do not stop after only one file.")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return "I optimized node-todo/app.js so the port configuration now uses process.env.PORT.";
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return "I optimized node-todo/app.js to use process.env.PORT and updated node-todo/views/index.ejs so the title input now has maxlength 100.";
    }
  }

  if (/^Original user request: The user replied ".+" to approve the immediately previous proposal\./.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (/rewrite node-todo by updating app\.js, views\/index\.ejs, and package\.json/i.test(content)) {
      if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: 'const PORT = Number(process.env.PORT || 3000);'
        });
      }

      if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
        return toolCall("edit", {
          path: "node-todo/views/index.ejs",
          startLine: 3,
          endLine: 3,
          replacement: '  <input name="title" maxlength="100" />'
        });
      }

      if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 13
        });
      }

      if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
        return toolCall("edit", {
          path: "node-todo/package.json",
          startLine: 5,
          endLine: 7,
          replacement: [
            '  "scripts": {',
            '    "start": "node app.js",',
            '    "dev": "node app.js"',
            "  },"
          ].join("\n")
        });
      }

      if (toolName === "edit" && /node-todo\/package\.json/.test(summary)) {
        return "I rewrote the approved node-todo surface: app.js now uses process.env.PORT, views/index.ejs now limits the title input, and package.json now includes a dev script.";
      }
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: 'const PORT = Number(process.env.PORT || 3000);'
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/Your previous reply was too thin for an approval or continue follow-up\./.test(content)) {
        return "I updated node-todo/app.js and improved the port configuration in the approved next step.";
      }

      return "已继续，node-todo/app.js 已更新。";
    }
  }

  if (content.startsWith("Original user request: Fix greet.mjs")) {
    const toolName = extractLine(content, "Tool:");

    if (toolName === "files") {
      assert.match(content, /console\.log\("Hello"\);/);
      return toolCall("edit", {
        path: "greet.mjs",
        startLine: 1,
        endLine: 1,
        replacement: 'console.log("Hello, SelfMe!");'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node greet.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /Hello, SelfMe!/);
      return "Fixed greet.mjs and verified it prints Hello, SelfMe!.";
    }
  }

  if (content.startsWith("Original user request: Create checklist.md")) {
    const toolName = extractLine(content, "Tool:");

    if (toolName === "write") {
      return toolCall("files", {
        path: "checklist.md",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files") {
      assert.match(content, /- buy milk/);
      assert.match(content, /- ship cli/);
      assert.match(content, /- test tools/);
      return "Created checklist.md and verified the three requested items are present.";
    }
  }

  if (content.startsWith("Original user request: Create math.mjs")) {
    const toolName = extractLine(content, "Tool:");

    if (toolName === "write") {
      return toolCall("shell", {
        command: "node math.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /ReferenceError|failed \(1\)|exit code 1/i);
        return toolCall("edit", {
          path: "math.mjs",
          startLine: 1,
          endLine: 1,
          replacement: "console.log(42);"
        });
      }

      assert.match(content, /42/);
      return "Created math.mjs, repaired the failed verification, and confirmed it prints 42.";
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node math.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Create numbers.txt with three lines: 4, 5, 6.")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "write" && /numbers\.txt/.test(summary)) {
      return toolCall("write", {
        path: "total.mjs",
        content: [
          'import { readFileSync } from "node:fs";',
          "",
          'const values = readFileSync("nums.txt", "utf8").trim().split("\\n").map(Number);',
          "console.log(values.reduce((sum, value) => sum + value, 0));",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /total\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node total.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /nums\.txt|ENOENT|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "total.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /15/);
      return "Created numbers.txt and total.mjs, repaired the verification failure, and confirmed the script prints 15.";
    }

    if (toolName === "files") {
      assert.match(content, /nums\.txt/);
      return toolCall("edit", {
        path: "total.mjs",
        startLine: 1,
        endLine: 4,
        replacement: [
          'import { readFileSync } from "node:fs";',
          "",
          'const values = readFileSync("numbers.txt", "utf8").trim().split("\\n").map(Number);',
          "console.log(values.reduce((sum, value) => sum + value, 0));"
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node total.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json, then create print-config.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"port": 3000/);
      return toolCall("write", {
        path: "print-config.mjs",
        content: [
          'import config from "./app.conf.json" with { type: "json" };',
          "",
          'console.log(`${config.name}:${config.port}`);',
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /print-config\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node print-config.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /app\.conf\.json|ENOENT|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "print-config.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe:3000/);
      return "Read app.config.json, repaired the script, and confirmed it prints SelfMe:3000.";
    }

    if (toolName === "files" && /print-config\.mjs/.test(summary)) {
      assert.match(content, /app\.conf\.json/);
      return toolCall("edit", {
        path: "print-config.mjs",
        startLine: 1,
        endLine: 3,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          "",
          'console.log(`${config.name}:${config.port}`);'
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node print-config.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/runtime.json, then create render-runtime-label.mjs and render-region-label.mjs and repair existing show-runtime-chain.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/runtime\.json/.test(summary)) {
      assert.match(content, /"product": "SelfMe"/);
      assert.match(content, /"stage": "dev"/);
      assert.match(content, /"region": "cn"/);
      return toolCall("write", {
        path: "render-runtime-label.mjs",
        content: [
          "export function renderRuntimeLabel(runtime) {",
          '  return `${runtime.product} ${runtime.stage}`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /render-runtime-label\.mjs/.test(summary)) {
      return toolCall("write", {
        path: "render-region-label.mjs",
        content: [
          "export function renderRegionLabel(runtime) {",
          "  return runtime.region;",
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /render-region-label\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node show-runtime-chain.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-runtime-labl\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "show-runtime-chain.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe dev cn/);
      return "Created both helper files, repaired show-runtime-chain.mjs, and verified it now prints exactly SelfMe dev cn.";
    }

    if (toolName === "files" && /show-runtime-chain\.mjs/.test(summary)) {
      assert.match(content, /render-runtime-labl\.mjs/);
      return toolCall("edit", {
        path: "show-runtime-chain.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderRuntimeLabel } from "./render-runtime-label.mjs";'
      });
    }

    if (toolName === "edit" && /show-runtime-chain\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node show-runtime-chain.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/runtime.json, then create render-runtime-core.mjs, render-runtime-region.mjs, and render-runtime-suffix.mjs, and repair existing deep-runtime-chain.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/runtime\.json/.test(summary)) {
      return toolCall("write", {
        path: "render-runtime-core.mjs",
        content: [
          "export function renderRuntimeCore(runtime) {",
          '  return `${runtime.product} ${runtime.stage}`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /render-runtime-core\.mjs/.test(summary)) {
      return toolCall("write", {
        path: "render-runtime-region.mjs",
        content: [
          "export function renderRuntimeRegion(runtime) {",
          "  return runtime.region;",
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /render-runtime-region\.mjs/.test(summary)) {
      return toolCall("write", {
        path: "render-runtime-suffix.mjs",
        content: [
          "export function renderRuntimeSuffix() {",
          '  return "-stable";',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /render-runtime-suffix\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node deep-runtime-chain.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-runtime-cor\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "deep-runtime-chain.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe dev cn -stable/.test(content)) {
        return toolCall("files", {
          path: "render-runtime-suffix.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe dev cn stable/);
      return "Created the deep runtime helpers, repaired deep-runtime-chain.mjs, and verified it now prints exactly SelfMe dev cn stable.";
    }

    if (toolName === "files" && /deep-runtime-chain\.mjs/.test(summary)) {
      assert.match(content, /render-runtime-cor\.mjs/);
      return toolCall("edit", {
        path: "deep-runtime-chain.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderRuntimeCore } from "./render-runtime-core.mjs";'
      });
    }

    if (toolName === "edit" && /deep-runtime-chain\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node deep-runtime-chain.mjs"
      });
    }

    if (toolName === "files" && /render-runtime-suffix\.mjs/.test(summary)) {
      assert.match(content, /-stable/);
      return toolCall("edit", {
        path: "render-runtime-suffix.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return "stable";'
      });
    }

    if (toolName === "edit" && /render-runtime-suffix\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node deep-runtime-chain.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json, then repair existing anchored-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "anchored-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /anchored-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node anchored-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/Your previous assistant message was only a progress update, not a completed result\./.test(content)) {
        assert.match(content, /Working file anchor: anchored-report\.mjs/);
        assert.match(content, /anchored working file anchored-report\.mjs/i);
        return toolCall("edit", {
          path: "anchored-report.mjs",
          startLine: 1,
          endLine: 3,
          replacement: [
            'import config from "./app.config.json" with { type: "json" };',
            'console.log(`${config.name}:${config.port}`);'
          ].join("\n")
        });
      }

      if (/name=SelfMe/.test(content) && /port=3000/.test(content)) {
        return "I should reread app.config.json before changing anything.";
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired anchored-report.mjs and verified it now prints exactly SelfMe:3000.";
    }

    if (toolName === "edit" && /anchored-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node anchored-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix explain-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "explain-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /explain-report\.mjs/.test(summary)) {
      return "The mismatch is already clear in explain-report.mjs, because it still prints two separate lines instead of one exact output.";
    }

    if (toolName === "edit" && /explain-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node explain-report.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Repaired explain-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (/You are already inside the execution phase of a concrete task\./.test(content)) {
      assert.match(content, /Working file anchor: explain-report\.mjs/);
      return toolCall("edit", {
        path: "explain-report.mjs",
        startLine: 1,
        endLine: 3,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);'
        ].join("\n")
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and repair existing retry-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("shell", {
        command: "node retry-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result repeated without progress\./.test(content)) {
        return toolCall("files", {
          path: "retry-report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe-3000/.test(content)) {
        return toolCall("shell", {
          command: "node retry-report.mjs"
        });
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired retry-report.mjs and verified it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /retry-report\.mjs/.test(summary)) {
      assert.match(content, /\$\{config\.name\}-\$\{config\.port\}/);
      return toolCall("edit", {
        path: "retry-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /retry-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node retry-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix stubborn-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/A single failed tool result does not complete this task\./.test(content)) {
        return toolCall("files", {
          path: "stubborn-report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/The latest tool result repeated without progress\./.test(content)) {
        return toolCall("edit", {
          path: "stubborn-report.mjs",
          startLine: 2,
          endLine: 2,
          replacement: 'console.log(`${config.name}:${config.port}`);'
        });
      }

      if (/The latest tool attempt failed\./.test(content)) {
        return "The import path is wrong, so the task is still failing and needs a targeted file repair.";
      }

      if (/SelfMe-3000/.test(content)) {
        return "The script runs now, but the output is still not exact because it prints SelfMe-3000 instead of SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired stubborn-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /stubborn-report\.mjs/.test(summary)) {
      if (/app\.conf\.json/.test(content)) {
        return toolCall("edit", {
          path: "stubborn-report.mjs",
          startLine: 1,
          endLine: 1,
          replacement: 'import config from "./app.config.json" with { type: "json" };'
        });
      }

      return toolCall("edit", {
        path: "stubborn-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /stubborn-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix stubborn-question-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-question-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("files", {
          path: "stubborn-question-report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe-3000/.test(content)) {
        return "Do you want me to update stubborn-question-report.mjs now?";
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired stubborn-question-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /stubborn-question-report\.mjs/.test(summary)) {
      assert.match(content, /\$\{config\.name\}-\$\{config\.port\}/);
      return toolCall("edit", {
        path: "stubborn-question-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /stubborn-question-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-question-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix stubborn-proposal-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-proposal-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("files", {
          path: "stubborn-proposal-report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe-3000/.test(content)) {
        return [
          "I can keep this task moving in two different ways from here, and both are viable depending on how cautious you want the next step to be.",
          "1. I can read stubborn-proposal-report.mjs now, patch the output line directly, and then rerun verification once the concrete file change is in place.",
          "2. I can first do another broader inspection pass, revisit the surrounding config and script context one more time, and only after that decide whether the output line should be changed or whether another part of the flow should be adjusted.",
          "Which option would you like me to take before I continue?"
        ].join("\n");
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired stubborn-proposal-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /stubborn-proposal-report\.mjs/.test(summary)) {
      assert.match(content, /\$\{config\.name\}-\$\{config\.port\}/);
      return toolCall("edit", {
        path: "stubborn-proposal-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /stubborn-proposal-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node stubborn-proposal-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix failure-stop-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("shell", {
        command: "node failure-stop-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/A single failed tool result does not complete this task\./.test(content)) {
        return toolCall("files", {
          path: "failure-stop-report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/The latest tool attempt failed\./.test(content)) {
        return "The command failed because the config import path is wrong, so the task is not finished yet.";
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired failure-stop-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /failure-stop-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "failure-stop-report.mjs",
        startLine: 1,
        endLine: 2,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);'
        ].join("\n")
      });
    }

    if (toolName === "edit" && /failure-stop-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node failure-stop-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix converge-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "converge-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /converge-report\.mjs/.test(summary)) {
      return "The problem is in converge-report.mjs: it still prints an extra line instead of one exact output.";
    }

    if (toolName === "edit" && /converge-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node converge-report.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Repaired converge-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }

    if (/You are already inside the execution phase of a concrete task\./.test(content)) {
      return toolCall("edit", {
        path: "converge-report.mjs",
        startLine: 1,
        endLine: 3,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);'
        ].join("\n")
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix converge-question-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "converge-question-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /converge-question-report\.mjs/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "converge-question-report.mjs",
          startLine: 1,
          endLine: 3,
          replacement: [
            'import config from "./app.config.json" with { type: "json" };',
            'console.log(`${config.name}:${config.port}`);'
          ].join("\n")
        });
      }

      return "Do you want me to edit converge-question-report.mjs now?";
    }

    if (toolName === "edit" && /converge-question-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node converge-question-report.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Repaired converge-question-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }
  }

  if (/^Original user request: 看看项目(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "可以继续。当前工作区里有 docs/plan.md、crawler_project.py、game.py 和 node-todo，你想让我先看哪个？";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      return "我先看了工作区列表，然后继续读了 node-todo/package.json；当前最像可继续分析的项目是 node-todo。";
    }
  }

  if (/^Original user request: 你能一次性都帮我看完整个项目吗(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表，当前最像完整项目的是 node-todo。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a whole-project inspection request\./.test(content)) {
        assert.match(content, /Likely inspection file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "我已经读了 node-todo/package.json，接下来会继续看核心实现。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return "我已经继续看了 node-todo 的核心实现 app.js；当前这个项目是一个小型 Express todo 应用。";
    }
  }

  if (/^Original user request: The user replied "不能一次性都帮我看完了 整个项目" and wants you to inspect the most recently active whole project now\.(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a whole-project inspection request\./.test(content)) {
        assert.match(content, /Likely inspection file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "我已经回到 node-todo 的项目入口，接下来会继续看核心实现。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return "我已经继续看了 node-todo 的核心实现 app.js；当前这个项目是一个小型 Express todo 应用。";
    }
  }

  if (/^Original user request: 看看项目，但先别改，告诉我如果重写 node-todo 你会怎么做。(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。当前最像值得重写的项目是 node-todo。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      return "Next step I can rewrite node-todo by updating app.js, views/index.ejs, and package.json so the app uses process.env.PORT, the title input gets maxlength 100, and the project gains a dev script.";
    }
  }

  if (/^Original user request: 看看项目，但先别改，告诉我如果重写 node-todo，并运行 `node node-todo\/verify-exact\.mjs` 验证直到输出 exactly `ready`，你会怎么做。(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。当前最像值得重写并验证的项目是 node-todo。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      return "Next step I can rewrite node-todo by updating app.js and views/index.ejs, then run node node-todo/verify-exact.mjs until it prints exactly ready, repairing the verifier too if the latest exact-output gap shifts there.";
    }
  }

  if (/^Original user request: 看看项目然后帮我优化下(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。当前最像要继续看的项目是 node-todo，你想让我先从哪个文件开始？";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。下一步我可以继续看看 app.js。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "node-todo/app.js 里把端口写死了，先改成 process.env.PORT 会更稳。";
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "我已经优化了 node-todo/app.js，现在端口配置改成了 process.env.PORT。";
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return [
        "我已经把 node-todo/app.js 的端口配置改成 process.env.PORT。",
        "下一步我会继续更新 node-todo/views/index.ejs，给 title input 加上 maxlength 100。"
      ].join("\n");
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return "我已经完成这轮项目优化：node-todo/app.js 改成了 process.env.PORT，node-todo/views/index.ejs 的 title input 也加上了 maxlength 100。";
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return "Do you want me to keep going and update node-todo/views/index.ejs now?";
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return "我已经完成这轮项目优化：node-todo/app.js 改成了 process.env.PORT，node-todo/views/index.ejs 的 title input 也加上了 maxlength 100。";
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，再给 node-todo/package.json 加上 dev script，再把 node-todo/verify-setup.mjs 里的 ready 改成 ready-ok。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("files", {
        path: "node-todo/views/index.ejs",
        startLine: 1,
        endLine: 4
      });
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("files", {
        path: "node-todo/package.json",
        startLine: 1,
        endLine: 13
      });
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/node-todo\/views\/index\.ejs:3-3 · updated/.test(content)) {
        return toolCall("edit", {
          path: "node-todo/package.json",
          startLine: 5,
          endLine: 7,
          replacement: '  "scripts": {\n    "start": "node app.js",\n    "dev": "node app.js"\n  },'
        });
      }

      return "node-todo/package.json 还需要继续更新 scripts。";
    }

    if (toolName === "edit" && /node-todo\/package\.json/.test(summary)) {
      return toolCall("files", {
        path: "node-todo/verify-setup.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /node-todo\/verify-setup\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/verify-setup.mjs",
        startLine: 7,
        endLine: 7,
        replacement: '  console.log("ready-ok");'
      });
    }

    if (toolName === "edit" && /node-todo\/verify-setup\.mjs/.test(summary)) {
      return "我已经完成这轮更宽的多文件项目改造，四个目标文件都已更新。";
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      if (/app-only/.test(content)) {
        if (/You are already inside the execution phase of a concrete task\./.test(content)) {
          return toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 4
          });
        }

        return [
          "我已经把 node-todo/app.js 的端口配置改成了 process.env.PORT。",
          "接下来我会继续更新 node-todo/views/index.ejs，然后重新运行 node node-todo/verify-setup.mjs 验证。"
        ].join("\n");
      }

      if (/pwd && ls -la && find \. -maxdepth 2 -type f/.test(summary)) {
        return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
      }

      assert.match(content, /ready/);
      return "我已经完成这轮项目优化，并重新运行 node node-todo/verify-setup.mjs 验证通过，最终输出是 ready。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-setup.mjs"
      });
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-setup.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-setup.mjs` 验证，直到输出 exactly `ready`。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      if (/app-only/.test(content)) {
        if (/You are already inside the execution phase of a concrete task\./.test(content)) {
          return toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 4
          });
        }

        return "Do you want me to keep going and update node-todo/views/index.ejs now?";
      }

      if (/pwd && ls -la && find \. -maxdepth 2 -type f/.test(summary)) {
        return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
      }

      assert.match(content, /ready/);
      return "我已经完成这轮项目优化，并重新运行 node node-todo/verify-setup.mjs 验证通过，最终输出是 ready。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-setup.mjs"
      });
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-setup.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: 看看项目，然后直接优化 node-todo：把 node-todo/app.js 的端口改成 process.env.PORT，再给 node-todo/views/index.ejs 的 title input 加上 maxlength 100，并运行 `node node-todo/verify-exact.mjs` 验证，直到输出 exactly `ready`。")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "shell") {
      if (/You are in the middle of a concrete project inspection request\./.test(content)) {
        assert.match(content, /Likely project entry: node-todo\/package\.json/);
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 20
        });
      }

      if (/app-only/.test(content)) {
        if (/You are already inside the execution phase of a concrete task\./.test(content)) {
          return toolCall("files", {
            path: "node-todo/views/index.ejs",
            startLine: 1,
            endLine: 4
          });
        }

        return [
          "我已经把 node-todo/app.js 的端口配置改成了 process.env.PORT。",
          "接下来我会继续更新 node-todo/views/index.ejs，然后重新运行 node node-todo/verify-exact.mjs 验证。"
        ].join("\n");
      }

      if (/ready!/.test(content)) {
        if (/The latest tool result does not satisfy the task yet, so your previous reply cannot end the task\./.test(content)) {
          return toolCall("files", {
            path: "node-todo/verify-exact.mjs",
            startLine: 1,
            endLine: 20
          });
        }

        return "我已经完成这轮项目优化：node-todo/app.js 和 node-todo/views/index.ejs 都改好了。";
      }

      if (/pwd && ls -la && find \. -maxdepth 2 -type f/.test(summary)) {
        return "我先看了工作区列表。node-todo 是当前最像要继续处理的项目。";
      }

      assert.match(content, /ready/);
      return "我已经完成这轮项目优化，并重新运行 node node-todo/verify-exact.mjs 验证通过，最终输出是 ready。";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo 看起来是个小型 Express 项目。我先从 app.js 开始。";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }

    if (toolName === "files" && /node-todo\/verify-exact\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/verify-exact.mjs",
        startLine: 7,
        endLine: 7,
        replacement: '  console.log("ready");'
      });
    }

    if (toolName === "edit" && /node-todo\/verify-exact\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }
  }

  if (content.startsWith('Original user request: The user replied "帮我优化下" and wants you to optimize the most recently inspected project or file now.')) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary) && /Recent editable working file: node-todo\/app\.js/.test(content)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "node-todo/app.js is still the best anchor here, and the next useful improvement is to switch the port configuration to process.env.PORT.";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo looks like the right target. Next I can inspect app.js.";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("edit", {
          path: "node-todo/app.js",
          startLine: 3,
          endLine: 3,
          replacement: "const PORT = Number(process.env.PORT || 3000);"
        });
      }

      return "node-todo/app.js hardcodes the port, so switching it to process.env.PORT is the most useful first improvement.";
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "I optimized node-todo/app.js and changed the port configuration to use process.env.PORT.";
    }
  }

  if (content.startsWith('Original user request: The user replied "你能帮我重新写个项目吗" and wants you to rewrite the most recently inspected project or file now.')) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary) && /Recent editable working file: node-todo\/app\.js/.test(content)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      assert.match(content, /Likely working file: node-todo\/app\.js/);
      return toolCall("files", {
        path: "node-todo/app.js",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return "I started the rewrite by updating node-todo/app.js so the port configuration now uses process.env.PORT.";
    }
  }

  if (
    /^Original user request: The user replied ".+" and wants you to execute the immediately previous rewrite proposal now\.(?:\n|$)/.test(content)
    && /verify-exact\.mjs/.test(content)
  ) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }

    if (toolName === "shell" && /app-only/.test(content)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return "I updated node-todo/app.js and will continue with views/index.ejs before verifying again.";
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }

    if (toolName === "shell" && /ready!/.test(content)) {
      if (/The latest tool result does not satisfy the task yet, so your previous reply cannot end the task\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/verify-exact.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      return "I finished the rewrite of node-todo/app.js and node-todo/views/index.ejs.";
    }

    if (toolName === "files" && /node-todo\/verify-exact\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/verify-exact.mjs",
        startLine: 7,
        endLine: 7,
        replacement: '  console.log("ready");'
      });
    }

    if (toolName === "edit" && /node-todo\/verify-exact\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node node-todo/verify-exact.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /ready/);
      return "I completed the rewrite proposal and reran node node-todo/verify-exact.mjs until the final output was exactly ready.";
    }
  }

  if (/^Original user request: The user replied ".+" and wants you to execute the immediately previous rewrite proposal now\.(?:\n|$)/.test(content)) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/app.js",
        startLine: 3,
        endLine: 3,
        replacement: "const PORT = Number(process.env.PORT || 3000);"
      });
    }

    if (toolName === "edit" && /node-todo\/app\.js/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/views/index.ejs",
          startLine: 1,
          endLine: 4
        });
      }

      return "I updated node-todo/app.js and will continue the rest of the rewrite proposal.";
    }

    if (toolName === "files" && /node-todo\/views\/index\.ejs/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/views/index.ejs",
        startLine: 3,
        endLine: 3,
        replacement: '  <input name="title" maxlength="100" />'
      });
    }

    if (toolName === "edit" && /node-todo\/views\/index\.ejs/.test(summary)) {
      if (/The original request contains multiple concrete file changes\./.test(content)) {
        return toolCall("files", {
          path: "node-todo/package.json",
          startLine: 1,
          endLine: 13
        });
      }

      return "I updated node-todo/views/index.ejs and will continue the remaining rewrite step.";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      return toolCall("edit", {
        path: "node-todo/package.json",
        startLine: 5,
        endLine: 7,
        replacement: '  "scripts": {\n    "start": "node app.js",\n    "dev": "node app.js"\n  },'
      });
    }

    if (toolName === "edit" && /node-todo\/package\.json/.test(summary)) {
      return "I completed the rewrite proposal across node-todo/app.js, node-todo/views/index.ejs, and node-todo/package.json.";
    }
  }

  if (content.startsWith('Original user request: The user replied "帮我看看" and wants you to inspect the most recently active project or file now.')) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /node-todo\/app\.js/.test(summary) && /Recent editable working file: node-todo\/app\.js/.test(content)) {
      return "node-todo/app.js is still the active working file. The main issue here is that the port configuration should move to process.env.PORT instead of staying hardcoded.";
    }

    if (toolName === "files" && /node-todo\/package\.json/.test(summary)) {
      if (/You are in the middle of a project improvement task\./.test(content)) {
        assert.match(content, /Likely working file: node-todo\/app\.js/);
        return toolCall("files", {
          path: "node-todo/app.js",
          startLine: 1,
          endLine: 20
        });
      }

      return "node-todo still looks like the most relevant project target. Next I can inspect app.js.";
    }

    if (toolName === "files" && /node-todo\/app\.js/.test(summary)) {
      return "node-todo/app.js is the main working file here, and the most obvious issue is that it hardcodes the port instead of using process.env.PORT.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix premature-edit-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "premature-edit-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /premature-edit-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "premature-edit-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /premature-edit-report\.mjs/.test(summary)) {
      if (/The latest tool result does not satisfy the task yet/.test(content)) {
        return toolCall("shell", {
          command: "node premature-edit-report.mjs"
        });
      }

      return "Updated premature-edit-report.mjs.";
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Repaired premature-edit-report.mjs and confirmed it now prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix over-verify-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "over-verify-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /over-verify-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "over-verify-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /over-verify-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node over-verify-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired over-verify-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return toolCall("shell", {
        command: "node over-verify-report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix question-finish-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "question-finish-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /question-finish-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "question-finish-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /question-finish-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node question-finish-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired question-finish-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return "Do you want me to explain the change?";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix history-heavy-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "history-heavy-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /history-heavy-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "history-heavy-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /history-heavy-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node history-heavy-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired history-heavy-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return "I first found that history-heavy-report.mjs still used the old dash format, then I updated the output line, and after that I reran node history-heavy-report.mjs to confirm the final result. Earlier the format was wrong, but now it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix failure-recap-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "failure-recap-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /failure-recap-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "failure-recap-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /failure-recap-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node failure-recap-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired failure-recap-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return "I fixed failure-recap-report.mjs. Earlier it failed because the output used a dash, and now it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix unrelated-anchor-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "unrelated-anchor-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /unrelated-anchor-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "unrelated-anchor-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /unrelated-anchor-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node unrelated-anchor-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired unrelated-anchor-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      assert.match(content, /SelfMe:3000/);
      return "Repaired unrelated-anchor-report.mjs after checking serve.mjs, and now it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix vague-finish-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "vague-finish-report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /vague-finish-report\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "vague-finish-report.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'console.log(`${config.name}:${config.port}`);'
      });
    }

    if (toolName === "edit" && /vague-finish-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node vague-finish-report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool result appears to satisfy the task, but your previous reply did not close it clearly\./.test(content)) {
        return "Repaired vague-finish-report.mjs and confirmed it now prints exactly SelfMe:3000.";
      }

      return "The script has been adjusted.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json, then create startup-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (/You have not started the requested work yet\./i.test(content)) {
      return toolCall("files", {
        path: "app.config.json",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("write", {
        path: "startup-report.mjs",
        content: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);',
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /startup-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node startup-report.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Created startup-report.mjs and verified it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json, then create delayed-report.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      if (/Your previous assistant message was only a progress update/i.test(content)) {
        return toolCall("write", {
          path: "delayed-report.mjs",
          content: [
            'import config from "./app.config.json" with { type: "json" };',
            'console.log(`${config.name}:${config.port}`);',
            ""
          ].join("\n")
        });
      }

      return "I found the config. Next I will create the script and verify it.";
    }

    if (toolName === "write" && /delayed-report\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node delayed-report.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe:3000/);
      return "Created delayed-report.mjs and verified it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Run `node src/healthcheck.mjs`, fix the existing files so it prints exactly `SelfMe:3000`")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /renderHealth|renderHeath|SyntaxError|failed \(1\)|exit code 1/i);
        assert.match(content, /Preferred next action:/);
        assert.match(content, /smallest import\/export fix/i);
        assert.match(content, /Verification command: node src\/healthcheck\.mjs/);
        assert.match(content, /Expected output: SelfMe:3000/);
        assert.match(content, /Likely target file: src\/lib\/render-health\.mjs/);
        assert.match(content, /Missing export: renderHealth/);
        return toolCall("files", {
          path: "src/lib/render-health.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe-3000/.test(content)) {
        assert.match(content, /Preferred next action:/);
        assert.match(content, /smallest edit to the most likely source file/i);
        assert.match(content, /Verification command: node src\/healthcheck\.mjs/);
        assert.match(content, /Expected output: SelfMe:3000/);
        assert.match(content, /Observed output: SelfMe-3000/);
        return toolCall("edit", {
          path: "src/lib/render-health.mjs",
          startLine: 2,
          endLine: 2,
          replacement: '  return `${config.name}:${config.port}`;'
        });
      }

      assert.match(content, /SelfMe:3000/);
      return "Fixed the existing healthcheck flow and verified it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /src\/lib\/render-health\.mjs/.test(summary)) {
      assert.match(content, /renderHeath/);
      return toolCall("edit", {
        path: "src/lib/render-health.mjs",
        startLine: 1,
        endLine: 2,
        replacement: [
          "export function renderHealth(config) {",
          '  return `${config.name}-${config.port}`;'
        ].join("\n")
      });
    }

    if (toolName === "edit" && /src\/lib\/render-health\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/healthcheck.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Run `node src/bridge.mjs`, fix the existing files so it prints exactly `SelfMe:ready`")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /bridge-helperr\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        assert.match(content, /Verification command: node src\/bridge\.mjs/);
        assert.match(content, /Expected output: SelfMe:ready/);
        assert.match(content, /Likely target file: src\/bridge\.mjs/);
        assert.match(content, /Missing path: .*bridge-helperr\.mjs/);
        return toolCall("files", {
          path: "src/bridge.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe:ready/);
      return "Fixed the bridge import and helper output, then verified src/bridge.mjs now prints exactly SelfMe:ready.";
    }

    if (toolName === "files" && /src\/bridge\.mjs/.test(summary)) {
      assert.match(content, /bridge-helperr\.mjs/);
      return toolCall("files", {
        path: "src/bridge-helper.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/bridge-helper\.mjs/.test(summary)) {
      assert.match(content, /return "-ready"/);
      return toolCall("edit", {
        path: "src/bridge.mjs",
        startLine: 1,
        endLine: 1,
        replacement: 'import { bridgeStatus } from "./bridge-helper.mjs";'
      });
    }

    if (toolName === "edit" && /src\/bridge\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "src/bridge-helper.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return ":ready";'
      });
    }

    if (toolName === "edit" && /src\/bridge-helper\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/bridge.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Run `node src/bridge-switch.mjs`, fix the existing files so it prints exactly `SelfMe:ready`")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        if (/bridge-switch-helperr\.mjs/.test(content)) {
          return toolCall("files", {
            path: "src/bridge-switch.mjs",
            startLine: 1,
            endLine: 20
          });
        }

        if (/does not provide an export named|bridgeStatus/.test(content)) {
          return toolCall("files", {
            path: "src/bridge-switch-helper.mjs",
            startLine: 1,
            endLine: 20
          });
        }
      }

      if (/SelfMe-ready/.test(content)) {
        return toolCall("files", {
          path: "src/bridge-switch-helper.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe:ready/);
      return "Fixed the bridge-switch import and helper logic, then verified src/bridge-switch.mjs now prints exactly SelfMe:ready.";
    }

    if (toolName === "files" && /src\/bridge-switch\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "src/bridge-switch.mjs",
        startLine: 1,
        endLine: 1,
        replacement: 'import { bridgeStatus } from "./bridge-switch-helper.mjs";'
      });
    }

    if (toolName === "files" && /src\/bridge-switch-helper\.mjs/.test(summary)) {
      if (/export function bridgeState/.test(content)) {
        return toolCall("edit", {
          path: "src/bridge-switch-helper.mjs",
          startLine: 1,
          endLine: 2,
          replacement: [
            "export function bridgeStatus() {",
            '  return "-ready";'
          ].join("\n")
        });
      }

      return toolCall("edit", {
        path: "src/bridge-switch-helper.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return ":ready";'
      });
    }

    if (toolName === "edit" && /src\/bridge-switch\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/bridge-switch.mjs"
      });
    }

    if (toolName === "edit" && /src\/bridge-switch-helper\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/bridge-switch.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Run `node src/preview.mjs`, repair the existing file so it prints exactly `SelfMe local`")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /config\/theme\.json|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        assert.match(content, /Verification command: node src\/preview\.mjs/);
        assert.match(content, /Expected output: SelfMe local/);
        assert.match(content, /Likely target file: src\/preview\.mjs/);
        assert.match(content, /Missing path: .*config\/theme\.json/);
        return toolCall("files", {
          path: "src/preview.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe local/);
      return "Repaired the broken import in src/preview.mjs and verified it now prints exactly SelfMe local.";
    }

    if (toolName === "files" && /src\/preview\.mjs/.test(summary)) {
      assert.match(content, /\.\/config\/theme\.json/);
      return toolCall("edit", {
        path: "src/preview.mjs",
        startLine: 1,
        endLine: 1,
        replacement: 'import theme from "../config/theme.json" with { type: "json" };'
      });
    }

    if (toolName === "edit" && /src\/preview\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/preview.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: 读取 app.config.json，然后修复 serve.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"port": 3000/);
      return toolCall("files", {
        path: "serve.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /serve\.mjs/.test(summary)) {
      assert.match(content, /app\.conf\.json/);
      return toolCall("edit", {
        path: "serve.mjs",
        startLine: 1,
        endLine: 2,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name} on ${config.port}`);'
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node serve.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe on 3000/.test(content)) {
        return toolCall("edit", {
          path: "serve.mjs",
          startLine: 1,
          endLine: 2,
          replacement: [
            'import config from "./app.config.json" with { type: "json" };',
            'console.log(`${config.name} running on ${config.port}`);'
          ].join("\n")
        });
      }

      assert.match(content, /SelfMe running on 3000/);
      return "已修复 serve.mjs，并确认输出 SelfMe running on 3000。";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json and fix report.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"port": 3000/);
      return toolCall("files", {
        path: "report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /report\.mjs/.test(summary)) {
      assert.match(content, /name=\$\{config\.name\}/);
      return toolCall("edit", {
        path: "report.mjs",
        startLine: 1,
        endLine: 3,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);',
          'console.log("done");'
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node report.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe:3000\s+done/.test(content) || /SelfMe:3000[\s\S]*done/.test(content)) {
        return toolCall("edit", {
          path: "report.mjs",
          startLine: 1,
          endLine: 3,
          replacement: [
            'import config from "./app.config.json" with { type: "json" };',
            'console.log(`${config.name}:${config.port}`);'
          ].join("\n")
        });
      }

      assert.match(content, /SelfMe:3000/);
      return "Fixed report.mjs and confirmed it prints exactly SelfMe:3000.";
    }
  }

  if (content.startsWith("Original user request: Run `node smoke-a.mjs`, then fix report.mjs so running `node report.mjs` prints exactly `SelfMe:3000` on one line.")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "shell") {
      if (/node smoke-a\.mjs · completed/.test(content)) {
        assert.match(content, /Target verification and Working files as the current task anchor/i);
        assert.match(content, /Do not rerun earlier auxiliary commands or warmups/i);
        return toolCall("shell", {
          command: "node report.mjs"
        });
      }

      if (/name=SelfMe/.test(content) && /port=3000/.test(content)) {
        assert.match(content, /Target verification and Working files as the current task anchor/i);
        assert.match(content, /Do not rerun earlier auxiliary commands or warmups/i);
        assert.match(content, /Verification command: node report\.mjs/);
        assert.match(content, /Expected output: SelfMe:3000/);
        assert.match(content, /Observed output:/);
        return toolCall("files", {
          path: "report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /Target verification and Working files/i);
        assert.match(content, /Do not go back to earlier auxiliary commands/i);
        assert.match(content, /Verification command: node report\.mjs/);
        assert.match(content, /Expected output: SelfMe:3000/);
        return toolCall("files", {
          path: "report.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe:3000/);
      return "Skipped repeating the warmup command, repaired report.mjs, and verified it now prints exactly SelfMe:3000.";
    }

    if (toolName === "files" && /report\.mjs/.test(summary)) {
      assert.match(content, /name=\$\{config\.name\}/);
      return toolCall("edit", {
        path: "report.mjs",
        startLine: 1,
        endLine: 3,
        replacement: [
          'import config from "./app.config.json" with { type: "json" };',
          'console.log(`${config.name}:${config.port}`);'
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node report.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Use app.config.json and numbers.txt to repair existing dashboard.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"port": 3000/);
      return toolCall("files", {
        path: "numbers.txt",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /numbers\.txt/.test(summary)) {
      assert.match(content, /4/);
      assert.match(content, /5/);
      assert.match(content, /6/);
      return toolCall("files", {
        path: "dashboard.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /dashboard\.mjs/.test(summary)) {
      assert.match(content, /config\.name/);
      return toolCall("shell", {
        command: "node dashboard.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe total=15/.test(content)) {
        return toolCall("edit", {
          path: "dashboard.mjs",
          startLine: 4,
          endLine: 4,
          replacement: 'console.log(`${config.name}:${config.port} total=${total}`);'
        });
      }

      assert.match(content, /SelfMe:3000 total=15/);
      return "Fixed dashboard.mjs and confirmed it prints exactly SelfMe:3000 total=15.";
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node dashboard.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Inspect catalog.txt and repair existing status.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /catalog\.txt/.test(summary)) {
      assert.match(summary, /truncated/i);
      return toolCall("shell", {
        command: "tail -n 5 catalog.txt"
      });
    }

    if (toolName === "shell" && /tail -n 5 catalog\.txt/.test(summary)) {
      assert.match(content, /name=SelfMe/);
      assert.match(content, /channel=release/);
      assert.match(content, /port=3000/);
      return toolCall("files", {
        path: "status.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /status\.mjs/.test(summary)) {
      assert.match(content, /pending/);
      return toolCall("edit", {
        path: "status.mjs",
        startLine: 1,
        endLine: 1,
        replacement: 'console.log("SelfMe release 3000");'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node status.mjs"
      });
    }

    if (toolName === "shell" && /node status\.mjs/.test(summary)) {
      assert.match(content, /SelfMe release 3000/);
      return "Fixed status.mjs and confirmed it prints exactly SelfMe release 3000.";
    }
  }

  if (content.startsWith("Original user request: Read config/theme.json and repair existing src/banner.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/theme\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"env": "local"/);
      return toolCall("files", {
        path: "src/banner.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/banner\.mjs/.test(summary)) {
      assert.match(content, /themes\.json/);
      return toolCall("edit", {
        path: "src/banner.mjs",
        startLine: 1,
        endLine: 2,
        replacement: [
          'import theme from "../config/theme.json" with { type: "json" };',
          'console.log(`${theme.name}-${theme.env}`);'
        ].join("\n")
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/banner.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe-local/.test(content)) {
        return toolCall("edit", {
          path: "src/banner.mjs",
          startLine: 1,
          endLine: 2,
          replacement: [
            'import theme from "../config/theme.json" with { type: "json" };',
            'console.log(`${theme.name} ${theme.env}`);'
          ].join("\n")
        });
      }

      assert.match(content, /SelfMe local/);
      return "Fixed src/banner.mjs and confirmed it prints exactly SelfMe local.";
    }
  }

  if (content.startsWith("Original user request: Read config/profile.json, then create src/lib/render-label.mjs and repair existing src/runner.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/profile\.json/.test(summary)) {
      assert.match(content, /"product": "SelfMe"/);
      assert.match(content, /"channel": "local"/);
      return toolCall("write", {
        path: "src/lib/render-label.mjs",
        content: [
          "export function renderLabel(profile) {",
          '  return `${profile.product} [${profile.channel}]`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/lib\/render-label\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/runner.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-label\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/runner.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe \[local\]/);
      return "Created src/lib/render-label.mjs, repaired src/runner.mjs, and confirmed it prints exactly SelfMe [local].";
    }

    if (toolName === "files" && /src\/runner\.mjs/.test(summary)) {
      assert.match(content, /\.\/libs\/render-label\.mjs/);
      return toolCall("edit", {
        path: "src/runner.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderLabel } from "./lib/render-label.mjs";'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/runner.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/profile.json, then create src/lib/render-stage-label.mjs and repair existing src/runner-stage.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/profile\.json/.test(summary)) {
      return toolCall("write", {
        path: "src/lib/render-stage-label.mjs",
        content: [
          "export function renderStageLabel(profile) {",
          '  return `${profile.product} [stage]`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/lib\/render-stage-label\.mjs/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("shell", {
          command: "node src/runner-stage.mjs"
        });
      }

      return "Created src/lib/render-stage-label.mjs. Next I will run runner-stage, fix any import issue, and verify the final output.";
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-stage-label\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/runner-stage.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe \[stage\]/);
      return "Created src/lib/render-stage-label.mjs, repaired src/runner-stage.mjs, and confirmed it prints exactly SelfMe [stage].";
    }

    if (toolName === "files" && /src\/runner-stage\.mjs/.test(summary)) {
      assert.match(content, /\.\/libs\/render-stage-label\.mjs/);
      return toolCall("edit", {
        path: "src/runner-stage.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderStageLabel } from "./lib/render-stage-label.mjs";'
      });
    }

    if (toolName === "edit" && /src\/runner-stage\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/runner-stage.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/profile.json, then create src/lib/render-stage-echo.mjs and repair existing src/runner-stage-echo.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/profile\.json/.test(summary)) {
      return toolCall("write", {
        path: "src/lib/render-stage-echo.mjs",
        content: [
          "export function renderStageEcho(profile) {",
          '  return `${profile.product} [echo]`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/lib\/render-stage-echo\.mjs/.test(summary)) {
      if (/You are already inside the execution phase of a concrete task\./.test(content)) {
        return toolCall("shell", {
          command: "node src/runner-stage-echo.mjs"
        });
      }

      return "Created src/lib/render-stage-echo.mjs. Next I will run runner-stage-echo, fix any import issue, and verify the final output.";
    }

    if (toolName === "shell") {
      if (/A single failed tool result does not complete this task\./.test(content)) {
        return toolCall("files", {
          path: "src/runner-stage-echo.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-stage-echo\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return "Created src/lib/render-stage-echo.mjs. Next I will run runner-stage-echo, fix any import issue, and verify the final output.";
      }

      assert.match(content, /SelfMe \[echo\]/);
      return "Created src/lib/render-stage-echo.mjs, repaired src/runner-stage-echo.mjs, and confirmed it prints exactly SelfMe [echo].";
    }

    if (toolName === "files" && /src\/runner-stage-echo\.mjs/.test(summary)) {
      assert.match(content, /\.\/libs\/render-stage-echo\.mjs/);
      return toolCall("edit", {
        path: "src/runner-stage-echo.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderStageEcho } from "./lib/render-stage-echo.mjs";'
      });
    }

    if (toolName === "edit" && /src\/runner-stage-echo\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/runner-stage-echo.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/profile.json, then create src/lib/render-stage-progress.mjs and repair existing src/runner-stage-progress.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/profile\.json/.test(summary)) {
      return toolCall("write", {
        path: "src/lib/render-stage-progress.mjs",
        content: [
          "export function renderStageProgress(profile) {",
          '  return `${profile.product} [draft]`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/lib\/render-stage-progress\.mjs/.test(summary)) {
      if (
        /You are already inside the execution phase of a concrete task\./.test(content)
        || /You are still inside the same multi-step task\./.test(content)
      ) {
        return toolCall("shell", {
          command: "node src/runner-stage-progress.mjs"
        });
      }

      return "Created src/lib/render-stage-progress.mjs. Next I will run runner-stage-progress, fix any import issue, and verify the current output.";
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-stage-progress\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/runner-stage-progress.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/SelfMe \[draft\]/.test(content)) {
        return toolCall("files", {
          path: "src/lib/render-stage-progress.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe \[local\]/);
      return "Repaired src/lib/render-stage-progress.mjs and confirmed src/runner-stage-progress.mjs now prints exactly SelfMe [local].";
    }

    if (toolName === "files" && /src\/runner-stage-progress\.mjs/.test(summary)) {
      assert.match(content, /\.\/libs\/render-stage-progress\.mjs/);
      return toolCall("edit", {
        path: "src/runner-stage-progress.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderStageProgress } from "./lib/render-stage-progress.mjs";'
      });
    }

    if (toolName === "edit" && /src\/runner-stage-progress\.mjs/.test(summary)) {
      if (
        /You are already inside the execution phase of a concrete task\./.test(content)
        || /You are still inside the same multi-step task\./.test(content)
      ) {
        return toolCall("shell", {
          command: "node src/runner-stage-progress.mjs"
        });
      }

      return "Repaired src/runner-stage-progress.mjs import. Next I will rerun it and tighten the helper output if it is still not exact.";
    }

    if (toolName === "files" && /src\/lib\/render-stage-progress\.mjs/.test(summary)) {
      assert.match(content, /\[draft\]/);
      return toolCall("edit", {
        path: "src/lib/render-stage-progress.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return `${profile.product} [local]`;'
      });
    }

    if (toolName === "edit" && /src\/lib\/render-stage-progress\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/runner-stage-progress.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/runtime.json and repair existing src/lib/format-runtime.mjs plus src/console.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/runtime\.json/.test(summary)) {
      assert.match(content, /"product": "SelfMe"/);
      assert.match(content, /"stage": "dev"/);
      assert.match(content, /"region": "cn"/);
      return toolCall("files", {
        path: "src/console.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/console\.mjs/.test(summary)) {
      assert.match(content, /format-runtme\.mjs/);
      return toolCall("files", {
        path: "src/lib/format-runtime.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/lib\/format-runtime\.mjs/.test(summary)) {
      assert.match(content, /runtime\.product\}:\$\{runtime\.stage\}/);
      return toolCall("edit", {
        path: "src/lib/format-runtime.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return `${runtime.product} ${runtime.stage} (${runtime.region})`;'
      });
    }

    if (toolName === "edit" && /src\/lib\/format-runtime\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "src/console.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { formatRuntime } from "./lib/format-runtime.mjs";'
      });
    }

    if (toolName === "edit" && /src\/console\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/console.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe dev \(cn\)/);
      return "Repaired src/lib/format-runtime.mjs and src/console.mjs, then confirmed the script prints exactly SelfMe dev (cn).";
    }
  }

  if (content.startsWith("Original user request: Read config/runtime.json and repair existing src/lib/format-runtime-explain.mjs plus src/console-explain.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/runtime\.json/.test(summary)) {
      return toolCall("files", {
        path: "src/console-explain.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/console-explain\.mjs/.test(summary)) {
      return "src/console-explain.mjs clearly still points at the wrong helper import, so the next step should be in the helper chain instead of stopping here.";
    }

    if (toolName === "files" && /src\/lib\/format-runtime-explain\.mjs/.test(summary)) {
      return "src/lib/format-runtime-explain.mjs still formats the runtime too narrowly, so the output cannot be exact yet.";
    }

    if (toolName === "edit" && /src\/lib\/format-runtime-explain\.mjs/.test(summary)) {
      return "The helper format is fixed now, but the entry file still needs the import repaired before verification can succeed.";
    }

    if (toolName === "edit" && /src\/console-explain\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/console-explain.mjs"
      });
    }

    if (toolName === "shell") {
      assert.match(content, /SelfMe dev \(cn\)/);
      return "Repaired src/lib/format-runtime-explain.mjs and src/console-explain.mjs, then confirmed the script prints exactly SelfMe dev (cn).";
    }

    if (/You are already inside the execution phase of a concrete task\./.test(content)) {
      if (/src\/console-explain\.mjs clearly still points at the wrong helper import/.test(content)) {
        return toolCall("files", {
          path: "src/lib/format-runtime-explain.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      if (/src\/lib\/format-runtime-explain\.mjs still formats the runtime too narrowly/.test(content)) {
        return toolCall("edit", {
          path: "src/lib/format-runtime-explain.mjs",
          startLine: 2,
          endLine: 2,
          replacement: '  return `${runtime.product} ${runtime.stage} (${runtime.region})`;'
        });
      }

      if (/The helper format is fixed now, but the entry file still needs the import repaired/.test(content)) {
        return toolCall("edit", {
          path: "src/console-explain.mjs",
          startLine: 2,
          endLine: 2,
          replacement: 'import { formatRuntimeExplain } from "./lib/format-runtime-explain.mjs";'
        });
      }
    }
  }

  if (content.startsWith("Original user request: Read config/service.json and repair existing src/lib/render-service-stubborn.mjs plus src/service-stubborn.mjs")) {
    const toolName = extractLine(content, "Tool:") ?? extractLine(content, "Latest tool:");
    const summary = extractLine(content, "Summary:") ?? extractLine(content, "Latest summary:") ?? "";

    if (toolName === "files" && /config\/service\.json/.test(summary)) {
      return toolCall("files", {
        path: "src/service-stubborn.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/service-stubborn\.mjs/.test(summary)) {
      return "src/service-stubborn.mjs still points at the wrong helper import, so the task is not ready for completion yet.";
    }

    if (toolName === "edit" && /src\/service-stubborn\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/service-stubborn.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe api-v1/.test(content)) {
        return "The program runs now, but the output is still not exact because it prints SelfMe api-v1 instead of SelfMe api@v1.";
      }

      assert.match(content, /SelfMe api@v1/);
      return "Repaired src/lib/render-service-stubborn.mjs and src/service-stubborn.mjs, then confirmed the script prints exactly SelfMe api@v1.";
    }

    if (toolName === "files" && /src\/lib\/render-service-stubborn\.mjs/.test(summary)) {
      return toolCall("edit", {
        path: "src/lib/render-service-stubborn.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return `${service.name} ${service.surface}@${service.version}`;'
      });
    }

    if (toolName === "edit" && /src\/lib\/render-service-stubborn\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/service-stubborn.mjs"
      });
    }

    if (/You are already inside the execution phase of a concrete task\./.test(content)) {
      if (/src\/service-stubborn\.mjs still points at the wrong helper import/.test(content)) {
        return toolCall("edit", {
          path: "src/service-stubborn.mjs",
          startLine: 2,
          endLine: 2,
          replacement: 'import { renderServiceStubborn } from "./lib/render-service-stubborn.mjs";'
        });
      }

      if (/The program runs now, but the output is still not exact because it prints SelfMe api-v1/.test(content)) {
        return toolCall("files", {
          path: "src/lib/render-service-stubborn.mjs",
          startLine: 1,
          endLine: 20
        });
      }
    }
  }

  if (content.startsWith("Original user request: Read config/service.json, then create src/lib/render-service.mjs and repair existing src/service.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/service\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"surface": "api"/);
      assert.match(content, /"version": "v1"/);
      return toolCall("write", {
        path: "src/lib/render-service.mjs",
        content: [
          "export function renderService(service) {",
          '  return `${service.name} ${service.surface}@${service.version}`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/lib\/render-service\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/service.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-service\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/service.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe api@v1/);
      return "Created src/lib/render-service.mjs, repaired src/service.mjs, and confirmed it prints exactly SelfMe api@v1.";
    }

    if (toolName === "files" && /src\/service\.mjs/.test(summary)) {
      assert.match(content, /\.\/libs\/render-service\.mjs/);
      return toolCall("edit", {
        path: "src/service.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderService } from "./lib/render-service.mjs";'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/service.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/endpoint.json, then create src/shared/render-endpoint.mjs and repair existing src/api/serve-endpoint.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/endpoint\.json/.test(summary)) {
      assert.match(content, /"product": "SelfMe"/);
      assert.match(content, /"host": "127.0.0.1"/);
      assert.match(content, /"port": 3000/);
      return toolCall("write", {
        path: "src/shared/render-endpoint.mjs",
        content: [
          "export function renderEndpoint(endpoint) {",
          '  return `${endpoint.product} http://${endpoint.host}:${endpoint.port}`;',
          "}",
          ""
        ].join("\n")
      });
    }

    if (toolName === "write" && /src\/shared\/render-endpoint\.mjs/.test(summary)) {
      return toolCall("shell", {
        command: "node src/api/serve-endpoint.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /render-endpoint\.mjs|ERR_MODULE_NOT_FOUND|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/api/serve-endpoint.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe http:\/\/127\.0\.0\.1:3000/);
      return "Created src/shared/render-endpoint.mjs, repaired src/api/serve-endpoint.mjs, and confirmed it prints exactly SelfMe http://127.0.0.1:3000.";
    }

    if (toolName === "files" && /src\/api\/serve-endpoint\.mjs/.test(summary)) {
      assert.match(content, /\.\.\/shareds\/render-endpoint\.mjs/);
      return toolCall("edit", {
        path: "src/api/serve-endpoint.mjs",
        startLine: 2,
        endLine: 2,
        replacement: 'import { renderEndpoint } from "../shared/render-endpoint.mjs";'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/api/serve-endpoint.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/release.json, then create src/templates/release-label.txt and repair existing src/docs/show-release.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/release\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"channel": "docs"/);
      return toolCall("write", {
        path: "src/templates/release-label.txt",
        content: "{name} / {channel}\n"
      });
    }

    if (toolName === "write" && /src\/templates\/release-label\.txt/.test(summary)) {
      return toolCall("shell", {
        command: "node src/docs/show-release.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /release-label\.txt|ENOENT|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/docs/show-release.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe \/ docs/);
      return "Created src/templates/release-label.txt, repaired src/docs/show-release.mjs, and confirmed it prints exactly SelfMe / docs.";
    }

    if (toolName === "files" && /src\/docs\/show-release\.mjs/.test(summary)) {
      assert.match(content, /\.\.\/templats\/release-label\.txt/);
      return toolCall("edit", {
        path: "src/docs/show-release.mjs",
        startLine: 3,
        endLine: 3,
        replacement: 'const template = readFileSync(new URL("../templates/release-label.txt", import.meta.url), "utf8").trim();'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/docs/show-release.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/badge.json, then create src/templates/badge-label.txt and repair existing src/docs/show-badge.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/badge\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"mode": "stable"/);
      return toolCall("write", {
        path: "src/templates/badge-label.txt",
        content: "{name} [{mode}]\n"
      });
    }

    if (toolName === "write" && /src\/templates\/badge-label\.txt/.test(summary)) {
      return toolCall("shell", {
        command: "node src/docs/show-badge.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe \[stable\] ready/.test(content)) {
        return toolCall("files", {
          path: "src/docs/show-badge.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe \[stable\]/);
      return "Created src/templates/badge-label.txt, tightened src/docs/show-badge.mjs, and confirmed it prints exactly SelfMe [stable].";
    }

    if (toolName === "files" && /src\/docs\/show-badge\.mjs/.test(summary)) {
      assert.match(content, /ready/);
      return toolCall("edit", {
        path: "src/docs/show-badge.mjs",
        startLine: 4,
        endLine: 4,
        replacement: 'console.log(template.replace("{name}", badge.name).replace("{mode}", badge.mode));'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/docs/show-badge.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/portal.json and inspect existing src/web/show-portal.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/portal\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"surface": "portal"/);
      assert.match(content, /"region": "cn"/);
      return toolCall("files", {
        path: "src/web/show-portal.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/web\/show-portal\.mjs/.test(summary)) {
      assert.match(content, /renderPortal/);
      return toolCall("shell", {
        command: "node src/web/show-portal.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe portal-cn/.test(content)) {
        return toolCall("files", {
          path: "src/shared/render-portal.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe portal:cn/);
      return "Inspected the existing portal files, tightened the helper output, and confirmed it prints exactly SelfMe portal:cn.";
    }

    if (toolName === "files" && /src\/shared\/render-portal\.mjs/.test(summary)) {
      assert.match(content, /portal\.surface\}-\$\{portal\.region\}/);
      return toolCall("edit", {
        path: "src/shared/render-portal.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return `${portal.name} ${portal.surface}:${portal.region}`;'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/web/show-portal.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/audit.json and inspect existing src/web/show-audit.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/audit\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"level": "audit"/);
      assert.match(content, /"region": "cn"/);
      return toolCall("files", {
        path: "src/web/show-audit.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /src\/web\/show-audit\.mjs/.test(summary)) {
      assert.match(content, /renderAudit/);
      return toolCall("shell", {
        command: "node src/web/show-audit.mjs"
      });
    }

    if (toolName === "shell") {
      if (/SelfMe:audit cn/.test(content)) {
        return toolCall("files", {
          path: "src/shared/render-audit.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe:audit-cn/);
      return "Inspected the existing audit files, narrowed the issue to the helper only, and confirmed it prints exactly SelfMe:audit-cn.";
    }

    if (toolName === "files" && /src\/shared\/render-audit\.mjs/.test(summary)) {
      assert.match(content, /audit\.name\}:\$\{audit\.level\}/);
      return toolCall("edit", {
        path: "src/shared/render-audit.mjs",
        startLine: 2,
        endLine: 2,
        replacement: '  return `${audit.name}:${audit.level}-`;'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/web/show-audit.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Read config/report.json, then create src/data/status-lines.csv and repair existing src/reports/show-status.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /config\/report\.json/.test(summary)) {
      assert.match(content, /"name": "SelfMe"/);
      assert.match(content, /"column": "status"/);
      return toolCall("write", {
        path: "src/data/status-lines.csv",
        content: "green\n"
      });
    }

    if (toolName === "write" && /src\/data\/status-lines\.csv/.test(summary)) {
      return toolCall("shell", {
        command: "node src/reports/show-status.mjs"
      });
    }

    if (toolName === "shell") {
      if (/The latest tool attempt failed\./.test(content)) {
        assert.match(content, /status-lines\.csv|ENOENT|failed \(1\)|exit code 1/i);
        return toolCall("files", {
          path: "src/reports/show-status.mjs",
          startLine: 1,
          endLine: 20
        });
      }

      assert.match(content, /SelfMe\|green/);
      return "Created src/data/status-lines.csv, repaired src/reports/show-status.mjs, and confirmed it prints exactly SelfMe|green.";
    }

    if (toolName === "files" && /src\/reports\/show-status\.mjs/.test(summary)) {
      assert.match(content, /\.\.\/datas\/status-lines\.csv/);
      return toolCall("edit", {
        path: "src/reports/show-status.mjs",
        startLine: 3,
        endLine: 3,
        replacement: 'const firstStatus = readFileSync(new URL("../data/status-lines.csv", import.meta.url), "utf8").trim().split("\\n")[0];'
      });
    }

    if (toolName === "edit") {
      return toolCall("shell", {
        command: "node src/reports/show-status.mjs"
      });
    }
  }

  if (content.startsWith("Original user request: Check whether missing.txt exists")) {
    assert.match(content, /The latest tool attempt failed\./);
    assert.match(content, /ENOENT|no such file or directory/i);
    return "missing.txt does not exist in the current workspace.";
  }

  if (content.startsWith("Original user request: 运行 pwd")) {
    assert.match(content, /Tool: shell/);
    assert.match(content, /Summary: pwd · completed/);
    return "当前工作目录就是这个会话的工作区目录。";
  }

  if (content.startsWith("Original user request: run pwd")) {
    assert.match(content, /Tool: shell/);
    assert.match(content, /Summary: pwd · completed/);
    return "The current working directory is the active workspace.";
  }

  if (content.startsWith("Original user request: Tell me the current working directory by running pwd.")) {
    assert.match(content, /Tool: shell/);
    assert.match(content, /pwd/);
    return "The working directory is the current workspace root.";
  }

  if (content.startsWith("Original user request: Tell me the current working directory again, but do it via your shell tool.")) {
    assert.match(content, /Tool: shell/);
    assert.match(content, /pwd/);
    return "The working directory is the current workspace root.";
  }

  if (content.startsWith("Original user request: Create blocked.txt with the content hidden.")) {
    assert.match(content, /denied by the user/i);
    return "I couldn't create blocked.txt because the write action was denied.";
  }

  if (content.startsWith('Original user request: Change greet.mjs so it prints "Blocked".')) {
    assert.match(content, /denied by the user/i);
    return "I couldn't change greet.mjs because the edit action was denied.";
  }

  if (content.startsWith("Original user request: Run rm greet.mjs.")) {
    assert.match(content, /denied by the user/i);
    return "I couldn't run rm greet.mjs because the shell action was denied.";
  }

  if (content.startsWith("Original user request: Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, and status.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "greet.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /greet\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /report\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "serve.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /serve\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "dashboard.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /dashboard\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "status.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /status\.mjs/.test(summary)) {
      return "FINAL-SIX-STEPS";
    }
  }

  if (content.startsWith("Original user request: Read app.config.json, greet.mjs, report.mjs, serve.mjs, dashboard.mjs, status.mjs, and console.mjs")) {
    const toolName = extractLine(content, "Tool:");
    const summary = extractLine(content, "Summary:") ?? "";

    if (toolName === "files" && /app\.config\.json/.test(summary)) {
      return toolCall("files", {
        path: "greet.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /greet\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "report.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /report\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "serve.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /serve\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "dashboard.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /dashboard\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "status.mjs",
        startLine: 1,
        endLine: 20
      });
    }

    if (toolName === "files" && /status\.mjs/.test(summary)) {
      return toolCall("files", {
        path: "console.mjs",
        startLine: 1,
        endLine: 20
      });
    }
  }

  throw new Error(`Unhandled regression prompt:\n${content}`);
}

function toolCall(tool: string, input: Record<string, unknown>) {
  return `<tool_call>\n${JSON.stringify({ tool, input })}\n</tool_call>`;
}

function extractLine(content: string, prefix: string) {
  return content
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function chunkText(content: string, size: number) {
  const chunks: string[] = [];

  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }

  return chunks;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
