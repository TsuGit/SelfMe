export type BuiltInCommandName = "help" | "tools" | "stop";

export interface CommandPaletteItem {
  key: string;
  command: string;
  summary: string;
  requiresInput?: boolean;
}

const commandPaletteItems: CommandPaletteItem[] = [
  { key: "help", command: "/help", summary: "Show the minimal command reference" },
  { key: "tools", command: "/tools", summary: "List available tools" },
  { key: "stop", command: "/stop", summary: "Stop the current running task" },
  { key: "read", command: "/read ", summary: "Read a file or line range", requiresInput: true },
  { key: "write", command: "/write ", summary: "Write a file from multiline input", requiresInput: true },
  { key: "edit", command: "/edit ", summary: "Replace a file range from multiline input", requiresInput: true },
  { key: "shell", command: "/shell ", summary: "Run a shell command", requiresInput: true }
];

export interface ParsedToolCommand {
  toolName: "shell" | "files" | "write" | "edit";
  input: {
    command?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
    maxBytes?: number;
    content?: string;
    replacement?: string;
  };
}

export function listCommandPaletteItems() {
  return commandPaletteItems.map((item) => ({ ...item }));
}

export function renderHelpLines() {
  return [
    "/help",
    "/tools",
    "/stop",
    "/read <path>",
    "/read <path:start-end>",
    "/read <path> --max-bytes <n>",
    "/write <path>\\n<content>",
    "/edit <path>\\n<replacement>",
    "/edit <path:start-end>\\n<replacement>",
    "/shell <command>"
  ];
}

export function parseBuiltInCommand(content: string): BuiltInCommandName | undefined {
  const trimmed = content.trim();

  if (trimmed === "/help") {
    return "help";
  }

  if (trimmed === "/tools") {
    return "tools";
  }

  if (trimmed === "/stop") {
    return "stop";
  }

  return undefined;
}

export function parseToolCommand(content: string): ParsedToolCommand | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  const header = newlineIndex >= 0 ? normalized.slice(0, newlineIndex) : normalized;
  const body = newlineIndex >= 0 ? normalized.slice(newlineIndex + 1) : "";
  const trimmedHeader = header.trim();

  if (trimmedHeader.startsWith("/write ")) {
    const path = trimmedHeader.slice("/write ".length).trim();

    if (!path) {
      return undefined;
    }

    return {
      toolName: "write",
      input: {
        path,
        content: body
      }
    };
  }

  if (trimmedHeader.startsWith("/edit ")) {
    const target = trimmedHeader.slice("/edit ".length).trim();

    if (!target) {
      return undefined;
    }

    return {
      toolName: "edit",
      input: {
        ...parsePathRangeInput(target),
        replacement: body
      }
    };
  }

  const trimmed = normalized.trim();
  const commandMatch = trimmed.match(/^\/(shell|read)\s+([\s\S]+)$/);

  if (!commandMatch) {
    return undefined;
  }

  const [, command, rawInput] = commandMatch;

  if (command === "read") {
    return {
      toolName: "files",
      input: parseReadInput(rawInput.trim())
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

  return {
    ...parsePathRangeInput(withoutMaxBytes),
    maxBytes
  };
}

function parsePathRangeInput(rawInput: string) {
  const rangeMatch = rawInput.match(/:(\d+)(?:-(\d+))?$/);

  if (!rangeMatch) {
    return {
      path: rawInput
    };
  }

  const path = rawInput.slice(0, rangeMatch.index).trim();
  const startLine = Number(rangeMatch[1]);
  const endLine = rangeMatch[2] ? Number(rangeMatch[2]) : startLine;

  return {
    path,
    startLine,
    endLine
  };
}
