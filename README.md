# SelfMe CLI

SelfMe 是一个本地运行的 TypeScript agent CLI。

当前仓库只做一件事：把 CLI agent 的执行闭环做扎实，包括输入、消息流、工具调用、审批、安全边界、会话存储，以及真实 coding task 的持续收敛能力。

这不是一个 Web 产品壳，也不是一个多端共享后端项目。当前阶段只关注单体 CLI。

## Current Scope

- 单进程、本地运行
- TypeScript + Node.js
- 本地文件工具与 shell 工具
- 风险分级审批
- 会话 transcript / tool log 存储
- 多轮任务恢复、失败点续跑、project-level follow-up 收敛

## Repository Layout

```text
src/
  app/        bootstrap、生命周期、事件总线
  editor/     输入缓冲、多行编辑、光标控制
  providers/  local / openai / anthropic provider
  runtime/    agent runtime、任务意图、上下文压缩、命令解析、事件定义
  smoke/      agent regression 回归
  storage/    settings、transcripts、tool logs
  terminal/   终端事件循环、渲染、面板、主题
  tools/      files / shell / registry
  types/      approval、task、event、session、tool
```

## Requirements

- Node.js 20+
- pnpm 11+

## Install

```bash
pnpm install
```

## Run

开发模式：

```bash
pnpm dev
```

构建：

```bash
pnpm build
```

运行构建产物：

```bash
pnpm start
```

## Configuration

首次启动会在当前工作区生成：

```text
.selfme/settings.json
.selfme/runtime/transcripts.jsonl
.selfme/runtime/tool-logs.jsonl
```

`settings.json` 结构：

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-..."
}
```

支持的 `provider`：

- `local`
- `openai`
- `anthropic`

工作区根目录默认取：

1. `SELFME_WORKSPACE_ROOT`
2. `INIT_CWD`
3. 当前进程目录

## Commands

内建命令：

- `/help`
- `/stop`
- `/read <path[:start-end]> [--max-bytes N]`
- `/write <path>`
- `/edit <path[:start-end]>`
- `/shell <command>`

说明：

- 输入 `/` 会打开命令菜单
- `Esc`、`Ctrl+C`、`/stop` 会停止当前任务
- `/write` 和 `/edit` 的正文从下一行开始

## Development

类型检查：

```bash
pnpm typecheck
```

agent smoke 回归：

```bash
pnpm smoke:agent
```

当前主开发策略不是先加功能，而是先提高真实任务完成率，再把失败沉淀成可重复回归。

## Docs

- `docs/agent-cli-roadmap.html`
  当前 CLI 产品边界、基线能力、路线图
- `docs/agent-eval-strategy.html`
  开发方法、能力分层、回归策略
- `docs/brand-color-system.html`
  视觉配色系统

## Status

这个仓库仍在高频迭代中。

当前重点不在功能数量，而在下面这些底层能力是否稳定：

- 中断后继续执行
- 审批后不断链
- 宽 follow-up 回到正确任务上下文
- 多文件任务不提前收尾
- verify / exact-output 链持续收敛

如果这些基础语义不稳定，后面继续扩工具和产品壳层都没有意义。
