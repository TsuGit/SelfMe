import { z } from "zod";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ToolImplementation, ToolResult } from "../types/tool.js";

export const fileToolSchema = z.object({
  path: z.string().min(1)
});

export type FileToolInput = z.infer<typeof fileToolSchema>;

export const fileTool: ToolImplementation<FileToolInput> = {
  name: "files",
  description: "Read or inspect workspace files",
  inputSchema: fileToolSchema,
  approvalPolicy: "never",
  async invoke(input, context): Promise<ToolResult> {
    const target = resolve(context.cwd, input.path);
    const content = await readFile(target, "utf8");

    return {
      ok: true,
      summary: `Read file ${input.path}`,
      structuredOutput: {
        path: input.path,
        length: content.length
      },
      rawLogs: {
        stdout: content
      }
    };
  }
};
