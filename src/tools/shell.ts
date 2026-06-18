import pty from "node-pty";
import { spawn } from "node:child_process";
import { platform } from "node:os";

import { z } from "zod";

import type { ToolImplementation, ToolResult } from "../types/tool.js";

const SHELL_TIMEOUT_MS = 8_000;
const SHELL_CAPTURE_MAX_BYTES = 64 * 1024;

export const shellToolSchema = z.object({
  command: z.string().min(1)
});

export type ShellToolInput = z.infer<typeof shellToolSchema>;

export const shellTool: ToolImplementation<ShellToolInput> = {
  name: "shell",
  description: "Execute shell commands in the current workspace",
  inputSchema: shellToolSchema,
  approvalPolicy: "on-risk",
  buildApproval(input) {
    const parsed = shellToolSchema.parse(input);
    const risk = classifyShellRisk(parsed.command);
    return {
      title: `Run shell · ${createCommandPreview(parsed.command, 96)}`,
      reason: `Run shell: ${createCommandPreview(parsed.command, 96)}`,
      risk
    };
  },
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

  const stdoutCapture = createTextCapture(SHELL_CAPTURE_MAX_BYTES);

  return await new Promise<ToolResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SHELL_TIMEOUT_MS);
    const abortListener = () => {
      aborted = true;
      child.kill();
    };

    context.signal?.addEventListener("abort", abortListener, { once: true });

    const finalize = (exitCode: number) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortListener);
      const stdout = stdoutCapture.read();
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted,
        summary: buildShellSummary(command, exitCode, timedOut, stdout.truncated, aborted),
        structuredOutput: {
          command,
          aborted,
          timedOut,
          truncated: stdout.truncated
        },
        rawLogs: {
          stdout: stdout.text
        },
        exitCode,
        errorMessage: aborted
          ? "Shell command cancelled"
          : timedOut
          ? `Shell command timed out after ${Math.floor(SHELL_TIMEOUT_MS / 1000)}s`
          : exitCode === 0
            ? undefined
            : `Shell command failed with exit code ${exitCode}`
      });
    };

    child.onData((data: string) => {
      stdoutCapture.append(data);
      void context.onStdoutChunk?.(data);
    });

    child.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
      finalize(exitCode);
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

  const stdoutCapture = createTextCapture(SHELL_CAPTURE_MAX_BYTES);
  const stderrCapture = createTextCapture(SHELL_CAPTURE_MAX_BYTES);

  return await new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, SHELL_TIMEOUT_MS);
    const abortListener = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };

    context.signal?.addEventListener("abort", abortListener, { once: true });

    const finalize = (exitCode: number) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortListener);
      const stdout = stdoutCapture.read();
      const stderr = stderrCapture.read();
      resolve({
        ok: exitCode === 0 && !timedOut && !aborted,
        summary: buildShellSummary(command, exitCode, timedOut, stdout.truncated || stderr.truncated, aborted),
        structuredOutput: {
          command,
          aborted,
          timedOut,
          truncated: stdout.truncated || stderr.truncated
        },
        rawLogs: {
          stdout: stdout.text,
          stderr: stderr.text
        },
        exitCode,
        errorMessage: aborted
          ? "Shell command cancelled"
          : timedOut
          ? `Shell command timed out after ${Math.floor(SHELL_TIMEOUT_MS / 1000)}s`
          : exitCode === 0
            ? undefined
            : `Shell command failed with exit code ${exitCode}`
      });
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const data = String(chunk);
      stdoutCapture.append(data);
      void context.onStdoutChunk?.(data);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const data = String(chunk);
      stderrCapture.append(data);
      void context.onStdoutChunk?.(data);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abortListener);
      reject(error);
    });
    child.on("close", (code) => {
      finalize(code ?? (aborted ? 130 : timedOut ? 124 : 1));
    });
  });
}

function buildShellSummary(command: string, exitCode: number, timedOut: boolean, truncated: boolean, aborted: boolean) {
  const preview = createCommandPreview(command, 120);

  if (aborted) {
    return `${preview} · cancelled${truncated ? " · truncated" : ""}`;
  }

  if (timedOut) {
    return `${preview} · timed out${truncated ? " · truncated" : ""}`;
  }

  return exitCode === 0
    ? `${preview} · completed${truncated ? " · truncated" : ""}`
    : `${preview} · failed (${exitCode})${truncated ? " · truncated" : ""}`;
}

function createCommandPreview(command: string, maxLength: number) {
  const normalized = command.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function classifyShellRisk(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "medium" as const;
  }

  if (
    /(^|[^\w])(rm|mv|cp|chmod|chown|dd|mkfs|diskutil|launchctl|shutdown|reboot|kill|pkill|xargs)\b/i.test(normalized)
    || /\b(sudo|ssh|scp|rsync|curl|wget)\b/i.test(normalized)
    || /[<>]|>>|\||&&|\|\||;\s*|\$\(|`/.test(normalized)
  ) {
    return "high" as const;
  }

  if (
    /^(pwd|ls|cat|head|tail|wc|stat|file|tree)\b/i.test(normalized)
    || /^(rg|find|sed)\b/i.test(normalized)
    || /^git\s+(status|diff|log|show)\b/i.test(normalized)
    || /^(node|tsx|bun|deno|python|python3)\s+[^\s-][^\s]*$/i.test(normalized)
    || /^(pnpm|npm|yarn|bun)\s+(test|run\s+test|exec\s+vitest)\b/i.test(normalized)
  ) {
    return "low" as const;
  }

  return "medium" as const;
}

function createTextCapture(maxBytes: number) {
  let value = "";
  let truncated = false;

  return {
    append(chunk: string) {
      if (!chunk || truncated) {
        if (chunk) {
          truncated = true;
        }
        return;
      }

      const next = `${value}${chunk}`;

      if (Buffer.byteLength(next, "utf8") <= maxBytes) {
        value = next;
        return;
      }

      value = clipText(next, maxBytes);
      truncated = true;
    },
    read() {
      return {
        text: value,
        truncated
      };
    }
  };
}

function clipText(text: string, maxBytes: number) {
  const suffix = "\n...truncated...";
  let output = "";

  for (const char of text) {
    const next = `${output}${char}`;

    if (Buffer.byteLength(`${next}${suffix}`, "utf8") > maxBytes) {
      break;
    }

    output = next;
  }

  return `${output}${suffix}`;
}
