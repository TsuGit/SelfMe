import type { ToolImplementation } from "../types/tool.js";

export interface ToolRegistry {
  get(name: string): ToolImplementation | undefined;
  list(): ToolImplementation[];
}

