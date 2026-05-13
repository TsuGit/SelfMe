export interface ParsedToolCommand {
  toolName: "shell" | "files";
  input: {
    command?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    maxBytes?: number;
  };
}

export type BuiltInCommandName = "help" | "tools" | "tasks" | "plan" | "checkpoint" | "sessions";

export interface CommandPaletteItem {
  key: string;
  command: string;
  summary: string;
  requiresInput?: boolean;
}

const commandPaletteItems: CommandPaletteItem[] = [
  { key: "help", command: "/help", summary: "Show command reference" },
  { key: "tools", command: "/tools", summary: "List available tools" },
  { key: "tasks", command: "/tasks", summary: "Show current tasks" },
  { key: "plan", command: "/plan", summary: "Summarize current recovery plan" },
  { key: "checkpoint", command: "/checkpoint", summary: "Show latest checkpoint snapshot" },
  { key: "sessions", command: "/sessions", summary: "Browse recent sessions" },
  { key: "history", command: "/history", summary: "Show recent conversation history" },
  { key: "search", command: "/search ", summary: "Search conversation history", requiresInput: true },
  { key: "jump-latest", command: "/jump latest", summary: "Jump to the latest history item" },
  { key: "retry-latest", command: "/retry latest", summary: "Retry the latest user request" },
  { key: "resume", command: "/resume", summary: "Open resumable tool tasks" },
  { key: "resume-latest", command: "/resume latest", summary: "Resume the latest tool task" },
  { key: "read", command: "/read ", summary: "Read a file or line range", requiresInput: true },
  { key: "shell", command: "/shell ", summary: "Run a shell command", requiresInput: true }
];

export function listCommandPaletteItems() {
  return commandPaletteItems.map((item) => ({ ...item }));
}

export interface ParsedSessionCommand {
  name: "history" | "search" | "jump" | "retry" | "resume";
  query?: string;
  target?: "latest" | "list" | string;
}

export function parseBuiltInCommand(content: string): BuiltInCommandName | undefined {
  const trimmed = content.trim();

  if (trimmed === "/help") {
    return "help";
  }

  if (trimmed === "/tools") {
    return "tools";
  }

  if (trimmed === "/tasks") {
    return "tasks";
  }

  if (trimmed === "/plan") {
    return "plan";
  }

  if (trimmed === "/checkpoint") {
    return "checkpoint";
  }

  if (trimmed === "/sessions") {
    return "sessions";
  }

  return undefined;
}

export function parseSessionCommand(content: string): ParsedSessionCommand | undefined {
  const trimmed = content.trim();

  if (trimmed === "/history") {
    return { name: "history" };
  }

  const searchMatch = trimmed.match(/^\/search\s+([\s\S]+)$/);

  if (searchMatch) {
    return {
      name: "search",
      query: searchMatch[1].trim()
    };
  }

  if (trimmed === "/jump latest") {
    return {
      name: "jump",
      target: "latest"
    };
  }

  if (trimmed === "/retry latest") {
    return {
      name: "retry",
      target: "latest"
    };
  }

  if (trimmed === "/resume latest") {
    return {
      name: "resume",
      target: "latest"
    };
  }

  if (trimmed === "/resume") {
    return {
      name: "resume",
      target: "list"
    };
  }

  const resumeMatch = trimmed.match(/^\/resume\s+([a-zA-Z0-9-]+)$/);

  if (resumeMatch) {
    return {
      name: "resume",
      target: resumeMatch[1]
    };
  }

  return undefined;
}

export function parseToolCommand(content: string): ParsedToolCommand | undefined {
  const trimmed = content.trim();
  const commandMatch = trimmed.match(/^\/(shell|read)\s+([\s\S]+)$/);

  if (!commandMatch) {
    return undefined;
  }

  const [, command, rawInput] = commandMatch;

  if (command === "read") {
    const parsedReadInput = parseReadInput(rawInput.trim());

    return {
      toolName: "files",
      input: parsedReadInput
    };
  }

  return {
    toolName: "shell",
    input: {
      command: rawInput.trim()
    }
  };
}

function parseReadInput(rawInput: string) {
  const maxBytesMatch = rawInput.match(/\s+--max-bytes\s+(\d+)\s*$/);
  const maxBytes = maxBytesMatch ? Number(maxBytesMatch[1]) : undefined;
  const withoutMaxBytes = maxBytesMatch
    ? rawInput.slice(0, maxBytesMatch.index).trim()
    : rawInput;
  const rangeMatch = withoutMaxBytes.match(/:(\d+)(?:-(\d+))?$/);

  if (!rangeMatch) {
    return {
      path: withoutMaxBytes,
      maxBytes
    };
  }

  const path = withoutMaxBytes.slice(0, rangeMatch.index).trim();
  const startLine = Number(rangeMatch[1]);
  const endLine = rangeMatch[2] ? Number(rangeMatch[2]) : startLine;

  return {
    path,
    startLine,
    endLine,
    maxBytes
  };
}
