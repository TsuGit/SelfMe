import pty from "node-pty";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { z } from "zod";

import type { ToolImplementation, ToolResult } from "../types/tool.js";

export const shellToolSchema = z.object({
  command: z.string().min(1)
});

export type ShellToolInput = z.infer<typeof shellToolSchema>;

export const shellTool: ToolImplementation<ShellToolInput> = {
  name: "shell",
  description: "Execute shell commands in the current workspace",
  inputSchema: shellToolSchema,
  approvalPolicy: "on-risk",
  async invoke(input, context): Promise<ToolResult> {
    const shell = platform() === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/zsh";
    const args = platform() === "win32" ? ["-Command", input.command] : ["-lc", input.command];

    try {
      return await runWithPty(shell, args, input.command, context);
    } catch {
      return await runWithSpawn(shell, args, input.command, context);
    }
  }
};

async function runWithPty(
  shell: string,
  args: string[],
  command: string,
  context: Parameters<ToolImplementation<ShellToolInput>["invoke"]>[1]
): Promise<ToolResult> {
  const child = pty.spawn(shell, args, {
    name: "xterm-color",
    cols: 120,
    rows: 30,
    cwd: context.cwd,
    env: process.env as Record<string, string>
  });

  let stdout = "";

  return await new Promise<ToolResult>((resolve) => {
    child.onData((data: string) => {
      stdout += data;
      void context.onStdoutChunk?.(data);
    });

    child.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      resolve({
        ok: exitCode === 0,
        summary: buildShellSummary(command, exitCode),
        structuredOutput: {
          command
        },
        rawLogs: {
          stdout
        },
        exitCode,
        errorMessage: exitCode === 0 ? undefined : `Shell command failed with exit code ${exitCode}`
      });
    });
  });
}

async function runWithSpawn(
  shell: string,
  args: string[],
  command: string,
  context: Parameters<ToolImplementation<ShellToolInput>["invoke"]>[1]
): Promise<ToolResult> {
  const child = spawn(shell, args, {
    cwd: context.cwd,
    env: process.env
  });

  let stdout = "";
  let stderr = "";

  return await new Promise<ToolResult>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = String(chunk);
      stdout += data;
      void context.onStdoutChunk?.(data);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const data = String(chunk);
      stderr += data;
      void context.onStdoutChunk?.(data);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        summary: buildShellSummary(command, exitCode),
        structuredOutput: {
          command
        },
        rawLogs: {
          stdout,
          stderr
        },
        exitCode,
        errorMessage: exitCode === 0 ? undefined : `Shell command failed with exit code ${exitCode}`
      });
    });
  });
}

function buildShellSummary(command: string, exitCode: number) {
  const preview = createCommandPreview(command, 120);

  return exitCode === 0
    ? `${preview} · completed`
    : `${preview} · failed (${exitCode})`;
}

function createCommandPreview(command: string, maxLength: number) {
  const normalized = command.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
