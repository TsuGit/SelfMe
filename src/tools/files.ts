import { z } from "zod";

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { ToolImplementation, ToolResult } from "../types/tool.js";

export const fileToolSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(256).max(65536).optional()
});

export type FileToolInput = z.infer<typeof fileToolSchema>;

export const fileTool: ToolImplementation<FileToolInput> = {
  name: "files",
  description: "Read or inspect workspace files",
  inputSchema: fileToolSchema,
  approvalPolicy: "never",
  async invoke(input, context): Promise<ToolResult> {
    const target = resolve(context.cwd, input.path);
    const fileStat = await stat(target);
    const content = await readFile(target, "utf8");
    const allLines = content.split("\n");
    const startLine = input.startLine ?? 1;
    const endLine = input.endLine ?? allLines.length;
    const safeStartLine = Math.max(1, Math.min(startLine, allLines.length || 1));
    const safeEndLine = Math.max(safeStartLine, Math.min(endLine, allLines.length || safeStartLine));
    const sliced = allLines.slice(safeStartLine - 1, safeEndLine);
    const numbered = sliced
      .map((line, index) => `${String(safeStartLine + index).padStart(4, " ")} | ${line}`)
      .join("\n");
    const maxBytes = input.maxBytes ?? 12000;
    const clipped = clipText(numbered, maxBytes);

    return {
      ok: true,
      summary: buildFileSummary({
        path: input.path,
        startLine: safeStartLine,
        endLine: safeEndLine,
        truncated: clipped.truncated
      }),
      structuredOutput: {
        path: input.path,
        sizeBytes: fileStat.size,
        totalLines: allLines.length,
        startLine: safeStartLine,
        endLine: safeEndLine,
        truncated: clipped.truncated
      },
      rawLogs: {
        stdout: clipped.text
      }
    };
  }
};

function clipText(text: string, maxBytes: number) {
  const size = Buffer.byteLength(text, "utf8");

  if (size <= maxBytes) {
    return {
      text,
      truncated: false
    };
  }

  let output = "";

  for (const char of text) {
    const next = `${output}${char}`;

    if (Buffer.byteLength(`${next}\n...truncated...`, "utf8") > maxBytes) {
      break;
    }

    output = next;
  }

  return {
    text: `${output}\n...truncated...`,
    truncated: true
  };
}

function buildFileSummary(input: {
  path: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}) {
  const range = `${input.startLine}-${input.endLine}`;
  const suffix = input.truncated ? " · truncated" : "";
  return `${input.path}:${range}${suffix}`;
}
