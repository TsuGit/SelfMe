import pty from "node-pty";
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
      });

      child.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
        resolve({
          ok: exitCode === 0,
          summary: exitCode === 0 ? "Shell command completed" : `Shell command failed (${exitCode})`,
          structuredOutput: {
            command: input.command
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
};
