import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../app/event-bus.js";
import type { ProviderClient, ProviderStreamChunk, ProviderStreamInput } from "../providers/base.js";
import { AgentRuntime } from "../runtime/agent.js";
import { createDefaultSessionRecord } from "../runtime/context.js";
import { buildContextMessages } from "../runtime/context-compaction.js";
import {
  createAssistantCompletedEvent,
  createAssistantDeltaEvent,
  createTerminalCommandInvokedEvent,
  createToolExecutionCompletedEvent,
  createUserMessageSubmittedEvent
} from "../runtime/events.js";
import { LogStore } from "../storage/logs.js";
import { TranscriptStore } from "../storage/transcripts.js";
import { InMemoryToolRegistry } from "../tools/registry.js";
import type { RuntimeEvent, TaskStateChangedEvent } from "../types/events.js";

const VERSION = "2026.6.16";

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
  await writeFile(join(workspace, "src", "console.mjs"), 'import runtime from "../config/runtime.json" with { type: "json" };\nimport { formatRuntime } from "./lib/format-runtme.mjs";\nconsole.log(formatRuntime(runtime));\n', "utf8");
  await writeFile(join(workspace, "src", "service.mjs"), 'import service from "../config/service.json" with { type: "json" };\nimport { renderService } from "./libs/render-service.mjs";\nconsole.log(renderService(service));\n', "utf8");
  await writeFile(join(workspace, "src", "api", "serve-endpoint.mjs"), 'import endpoint from "../../config/endpoint.json" with { type: "json" };\nimport { renderEndpoint } from "../shareds/render-endpoint.mjs";\nconsole.log(renderEndpoint(endpoint));\n', "utf8");
  await writeFile(join(workspace, "src", "docs", "show-release.mjs"), 'import release from "../../config/release.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst template = readFileSync(new URL("../templats/release-label.txt", import.meta.url), "utf8").trim();\nconsole.log(template.replace("{name}", release.name).replace("{channel}", release.channel));\n', "utf8");
  await writeFile(join(workspace, "src", "docs", "show-badge.mjs"), 'import badge from "../../config/badge.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst template = readFileSync(new URL("../templates/badge-label.txt", import.meta.url), "utf8").trim();\nconsole.log(`${template.replace("{name}", badge.name).replace("{mode}", badge.mode)} ready`);\n', "utf8");
  await writeFile(join(workspace, "src", "reports", "show-status.mjs"), 'import report from "../../config/report.json" with { type: "json" };\nimport { readFileSync } from "node:fs";\nconst firstStatus = readFileSync(new URL("../datas/status-lines.csv", import.meta.url), "utf8").trim().split("\\n")[0];\nconsole.log(`${report.name}|${firstStatus}`);\n', "utf8");
  await writeFile(join(workspace, "src", "shared", "render-portal.mjs"), 'export function renderPortal(portal) {\n  return `${portal.name} ${portal.surface}-${portal.region}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "web", "show-portal.mjs"), 'import portal from "../../config/portal.json" with { type: "json" };\nimport { renderPortal } from "../shared/render-portal.mjs";\nconsole.log(renderPortal(portal));\n', "utf8");
  await writeFile(join(workspace, "src", "shared", "render-audit.mjs"), 'export function renderAudit(audit) {\n  return `${audit.name}:${audit.level}`;\n}\n', "utf8");
  await writeFile(join(workspace, "src", "web", "show-audit.mjs"), 'import audit from "../../config/audit.json" with { type: "json" };\nimport { renderAudit } from "../shared/render-audit.mjs";\nconsole.log(`${renderAudit(audit)} ${audit.region}`);\n', "utf8");
  await writeFile(join(workspace, "src", "lib", "format-runtime.mjs"), 'export function formatRuntime(runtime) {\n  return `${runtime.product}:${runtime.stage}`;\n}\n', "utf8");
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
    prompt: "Run ls."
  });

  assert.equal(deniedShellResult.toolSummaries.length, 0);
  assert.match(deniedShellResult.assistantText, /(denied|couldn'?t run|not approved)/i);

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

  console.log("task: verify context compaction");
  verifyContextCompaction();
  verifyContextCompactionKeepsWholeTurns();
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
  assert.equal(task.payload.state, input.expectedState ?? "completed", `agent task did not complete: ${task.payload.state}`);

  const events = (await input.transcriptStore.readEventsBySession(input.sessionId)).slice(beforeEvents.length);
  const assistantText = collectAssistantText(events, task.taskId ?? "");
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

  return {
    taskId: task.taskId ?? "",
    assistantText,
    toolSummaries,
    runtimeErrors
  };
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

function collectAssistantText(events: RuntimeEvent[], taskId: string) {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: "assistant.delta.received" }> =>
      event.type === "assistant.delta.received" && event.taskId === taskId
    )
    .map((event) => event.payload.delta)
    .join("");
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
      content: `Recent request ${index}`
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
    toolName: "edit",
    summary: "greet.mjs:1-1 · updated (1 -> 1 lines)"
  }));
  events.push(createToolExecutionCompletedEvent({
    sessionId,
    taskId: "tool-recent-5",
    toolName: "shell",
    summary: "node greet.mjs · completed",
    rawOutput: "Hello, SelfMe!"
  }));

  const messages = buildContextMessages(events);
  const merged = messages.map((message) => `${message.role}: ${message.content}`).join("\n");
  const recentUsers = messages.filter((message) => message.role === "user").map((message) => message.content);
  const recentAssistants = messages.filter((message) => message.role === "assistant").map((message) => message.content);
  const recentNotesMessage = messages.find((message) => message.role === "system" && message.content.includes("Recent session notes:"))?.content ?? "";

  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Earlier session summary:")));
  assert.ok(messages.some((message) => message.role === "system" && message.content.includes("Recent session notes:")));
  assert.match(merged, /yes · timed out · truncated/);
  assert.doesNotMatch(merged, /\/help/);
  assert.doesNotMatch(recentNotesMessage, /checklist\.md:1-3/);
  assert.match(recentNotesMessage, /pwd · completed/);
  assert.match(recentNotesMessage, /ls · completed/);
  assert.match(recentNotesMessage, /greet\.mjs:1-1 · updated/);
  assert.match(recentNotesMessage, /node greet\.mjs · completed/);
  assert.doesNotMatch(merged, /Y{100}/);
  assert.deepEqual(recentUsers, ["Recent request 7", "Recent request 8", "Recent request 9"]);
  assert.deepEqual(recentAssistants, ["Recent answer 7", "Recent answer 8", "Recent answer 9"]);
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

  if (content.startsWith("Read app.config.json, then create print-config.mjs")) {
    return toolCall("files", {
      path: "app.config.json",
      startLine: 1,
      endLine: 20
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

  if (content.startsWith("Read config/runtime.json and repair existing src/lib/format-runtime.mjs plus src/console.mjs")) {
    return toolCall("files", {
      path: "config/runtime.json",
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

  if (content.startsWith("Original user request: Run ls.")) {
    assert.match(content, /denied by the user/i);
    return "I couldn't run ls because the shell action was denied.";
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
