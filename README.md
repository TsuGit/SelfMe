# SelfMe

Terminal agent CLI for real work in your workspace.

SelfMe is a TypeScript + Node.js agent runtime focused on one surface only: the command line. It is being built to stay on task, survive interruptions, respect approvals, use real tools, and keep improving through regression pressure instead of demo-only patches.

## Current Status

SelfMe is still under active runtime development.

What is already real:

- terminal-native CLI workflow
- file, write, edit, and shell tools
- approval-gated risky actions
- resumable task loop
- regression-driven runtime iteration

What is still being hardened:

- long multi-step project execution stability in live sessions
- interrupted-task resume quality after real stop / approval edges
- agent behavior that still feels too eager to explain instead of continuing work

If you are reading this from GitHub, treat the repository as a serious WIP baseline rather than a finished agent product.

## At A Glance

- Runs directly in your terminal
- TypeScript + Node.js runtime
- File and shell tools built in
- OpenAI-compatible, Anthropic-compatible, and self-hosted `local` provider support
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
- reliable workspace tool execution
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

- Workspace-scoped settings and runtime state
- Transcript persistence
- Tool log persistence
- Startup migration from older workspace `.selfme` state

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

Install globally from npm:

```bash
npm i -g selfme
selfme
```

Run without a global install:

```bash
npx selfme
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

The goal is simple: keys and runtime artifacts should not leak into the repository by accident.

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
  providers/  `local` / openai / anthropic integrations
  runtime/    agent runtime, task intent, context, compaction, commands
  smoke/      regression coverage for runtime behavior
  storage/    settings, transcripts, tool logs
  terminal/   screen, renderer, panels, theme
  tools/      files, shell, tool registry
  types/      task, event, session, approval, tool types
```

## Current Checkpoint

As of `2026-07-07`, the npm package name has been finalized as `selfme`, and the install path is:

```bash
npm i -g selfme
```

The current development checkpoint is:

- npm CLI packaging is in place and published under `selfme`
- terminal UX baseline is established enough to keep runtime work moving
- `pnpm smoke:agent` is green on the current continuation / resume / multi-step baseline
- the smoke baseline now includes one terminal-loop end-to-end path, so a typed multi-step prompt can flow through `stdin -> editor -> terminal loop -> runtime` and still continue past a stage summary into the remaining file edit within the same task
- that terminal-loop coverage now also includes `Esc` stop plus a typed `还能继续吗` resume, and the resumed turn is expected to jump straight back to the pending verification command instead of reopening earlier project files
- terminal-loop smoke now also covers the approval-wait branch in two forms: a typed project task can be interrupted while a later edit approval is still pending, and even if that interruption happens after a stage summary already narrowed the chain down to a second file, a typed `还能继续吗` resume is still expected to jump straight back to that pending edit instead of reopening the project entry or the already-read work files
- terminal-loop approval coverage now also includes natural typed approval replies while the approval panel is open, so entering `可以` or `不可以` in the input can resolve the pending approval directly instead of forcing only menu selection or `/approve <id>` commands
- terminal-loop smoke now also covers typed long-task auto-continuation across the per-slice tool-step ceiling, so a real terminal project-inspection run is expected to continue directly into its pending next file instead of surfacing the old hard stop or waiting for a manual second prompt
- when the very first user turn already names a concrete project root like `node-todo` or a concrete file like `node-todo/app.js`, runtime now injects a preferred starting target so the task can begin from that entry directly instead of spending the first slice on a redundant workspace listing
- ordinary tool execution failures now stay on the unified failed-tool event path, so missing-file / edit-range failures keep usable task history instead of falling into ad hoc runtime-error-only branches
- when a task hits either the tool-step ceiling before the next `files` / `edit` / `write` action executes, including the common case where the agent already read the target file and gets cut off just before the real `edit`, the assistant-pass ceiling while a concrete next file is already implied by the continuation prompt, a repeated assistant/tool stall after the task has already narrowed to a concrete next file, or a repeated malformed/unknown/invalid tool-call loop either after narrowing from a real tool result or even before the first real tool executes, runtime now records that pending target so a later `继续` can resume from the blocked step instead of restarting broad exploration
- that pending-step recovery now also preserves command-shaped checkpoints such as `npm test` or `node verify.mjs`, so a resumed task can rerun the exact pending verification command instead of reopening broader project files first
- the active work is still runtime hardening, not feature expansion

The next runtime questions remain:

- can it keep that continuation behavior in real interactive sessions, not just smoke fixtures?
- can it finish long multi-step project tasks without falling back to one-tool-one-stop behavior?
- can interrupted tasks resume cleanly from the latest real execution point after stop / approval edges?
