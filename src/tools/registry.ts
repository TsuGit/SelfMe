import type { ToolRegistry } from "./base.js";
import type { ToolImplementation } from "../types/tool.js";

import { fileTool } from "./files.js";
import { shellTool } from "./shell.js";

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolImplementation>([
    [shellTool.name, shellTool],
    [fileTool.name, fileTool]
  ]);

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()];
  }
}
