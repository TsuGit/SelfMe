# SelfMe

Local-first agent CLI for real terminal work.

SelfMe is a TypeScript + Node.js agent runtime focused on one surface only: the command line. It is being built to stay on task, survive interruptions, respect approvals, use real tools, and keep improving through regression pressure instead of demo-only patches.

## At A Glance

- Local CLI only
- TypeScript + Node.js runtime
- File and shell tools built in
- OpenAI-compatible, Anthropic-compatible, and local provider support
- Explicit approvals for risky actions
- Resume and recovery oriented task loop
- Regression suite treated as core product infrastructure

## Why This Exists

Most agent CLIs do not fail because the UI is missing features. They fail because the runtime breaks under ordinary work:

- the agent stops after one tool call
- it explains instead of continuing execution
- it loses context after interruption
- it cannot recover from approval waits or near-miss outputs
- it drifts away from the real working file after the task has already narrowed

SelfMe is being developed directly against those failure modes.

## Product Boundary

SelfMe is intentionally narrow.

In scope:

- a strong terminal-native agent experience
- reliable local tool execution
- resumable multi-step task handling
- clear storage, config, and approval behavior

Out of scope for the current product:

- web UI
- shared backend architecture
- multi-surface sync complexity
- broad platform expansion before the CLI is solid

## Core Capabilities

### Runtime

- Multi-step agent loop with follow-up handling
- Resume-aware task lifecycle
- Interrupt, stop, and recovery flows
- Context compaction for longer sessions

### Tools

- File reads and targeted edits
- File writes
- Shell execution
- Risk-based approval gates

### Terminal Experience

- Command menu driven slash commands
- Multiline input
- Structured tool/result rendering
- Transcript-oriented session flow

### Storage

- Workspace-isolated settings and runtime state
- Transcript persistence
- Tool log persistence
- Startup migration from older workspace-local state

## Quick Start

Requirements:

- Node.js 20+
- pnpm 11+

Install dependencies:

```bash
pnpm install
```

Run in development:

```bash
pnpm dev
```

Build:

```bash
pnpm build
```

Run the built CLI:

```bash
pnpm start
```

## Configuration

SelfMe stores runtime state outside your repository by default.

Example paths:

```text
~/.selfme/workspaces/<workspace-name>-<hash>/settings.json
~/.selfme/workspaces/<workspace-name>-<hash>/runtime/transcripts.jsonl
~/.selfme/workspaces/<workspace-name>-<hash>/runtime/tool-logs.jsonl
```

This means:

- your project can live anywhere on disk
- SelfMe state is centralized under `~/.selfme`
- each workspace still gets isolated config and logs

Supported providers:

- `local`
- `openai`
- `anthropic`

Example `settings.json`:

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-..."
}
```

Environment variables:

- `SELFME_WORKSPACE_ROOT`
  Override the workspace root that SelfMe treats as the active project
- `SELFME_HOME`
  Override the root directory used for SelfMe state

## Safety And Migration

On startup, SelfMe will:

- migrate legacy workspace `.selfme/settings.json` into the user-level state directory
- keep transcript and tool log history per workspace
- warn if workspace `.selfme` is tracked by git
- warn if workspace `.selfme` is not ignored by git

The goal is simple: local keys and runtime artifacts should not leak into the repository by accident.

## Built-In Commands

- `/help`
- `/stop`
- `/read <path[:start-end]> [--max-bytes N]`
- `/write <path>`
- `/edit <path[:start-end]>`
- `/shell <command>`

Interaction notes:

- type `/` to open the command menu
- use `Esc`, `Ctrl+C`, or `/stop` to stop the current task
- `/write` and `/edit` take their body on the next line

## Development Workflow

Typecheck:

```bash
pnpm typecheck
```

Run the runtime regression suite:

```bash
pnpm smoke:agent
```

The working rule for this repository is strict:

1. find a real runtime failure
2. turn it into a repeatable regression
3. fix the runtime behavior
4. keep the fix at the state, loop, or decision level when possible

The goal is not to patch isolated demos. The goal is to harden the runtime.

## Repository Layout

```text
src/
  app/        bootstrap, lifecycle, event bus
  editor/     input buffer, multiline composition, cursor handling
  providers/  local / openai / anthropic integrations
  runtime/    agent runtime, task intent, context, compaction, commands
  smoke/      regression coverage for runtime behavior
  storage/    settings, transcripts, tool logs
  terminal/   screen, renderer, panels, theme
  tools/      files, shell, tool registry
  types/      task, event, session, approval, tool types
```

## Project Documents

- `docs/agent-cli-roadmap.html`
  Product boundary, current baseline, and roadmap
- `docs/agent-eval-strategy.html`
  Evaluation method, regression strategy, and failure taxonomy
- `docs/brand-color-system.html`
  Brand and color rules

## Current Status

SelfMe is still under active iteration. The important questions right now are not about feature count.

They are about runtime quality:

- can it keep working after interruption?
- can it continue after approval waits?
- can it recover from verify and exact-output near-misses?
- can it stay anchored to the real working file?
- can it finish multi-step project tasks without stopping early?

Until those answers are consistently yes, adding more surface area is noise.
