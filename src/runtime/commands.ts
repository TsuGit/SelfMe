export type BuiltInCommandName = "help" | "stop";

export interface CommandPaletteItem {
  key: string;
  command: string;
  display: string;
  summary: string;
  usage?: string;
  hint: string;
  requiresInput?: boolean;
}

const commandPaletteItems: CommandPaletteItem[] = [
  {
    key: "help",
    command: "/help",
    display: "/help",
    summary: "Show command help",
    usage: "/help",
    hint: "Runs immediately."
  },
  {
    key: "stop",
    command: "/stop",
    display: "/stop",
    summary: "Stop current task",
    usage: "/stop",
    hint: "Runs immediately."
  },
  {
    key: "read",
    command: "/read ",
    display: "/read <path>",
    summary: "Read a file",
    usage: "/read <path[:start-end]> [--max-bytes N]",
    hint: "Press Enter to insert it, then add a path or line range.",
    requiresInput: true
  },
  {
    key: "write",
    command: "/write ",
    display: "/write <path>",
    summary: "Create or replace a file",
    usage: "/write <path>",
    hint: "Press Enter to insert it, then place file content on the next line.",
    requiresInput: true
  },
  {
    key: "edit",
    command: "/edit ",
    display: "/edit <path>",
    summary: "Edit an existing file",
    usage: "/edit <path[:start-end]>",
    hint: "Press Enter to insert it, then place replacement text on the next line.",
    requiresInput: true
  },
  {
    key: "shell",
    command: "/shell ",
    display: "/shell <command>",
    summary: "Run a shell command",
    usage: "/shell <command>",
    hint: "Press Enter to insert it, then type the full shell command.",
    requiresInput: true
  }
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

interface IncompleteSlashCommandNotice {
  message: string;
}

export function listCommandPaletteItems() {
  return commandPaletteItems.map((item) => ({ ...item }));
}

export function renderHelpLines() {
  return [
    "Commands",
    ...commandPaletteItems.map((item) => `${item.usage ?? item.display}  ${item.summary}`),
    "",
    "Command Menu",
    "Type / to open commands and filter as you type",
    "Use ↑↓ to select, Enter to run or insert",
    "For /write and /edit, content starts on the next line",
    "Esc closes the menu",
    "",
    "Approvals",
    "Use ↑↓ to choose Approve or Deny",
    "Press Enter to confirm the selected action",
    "Esc closes the approval panel",
    "",
    "Control",
    "Esc, Ctrl+C, or /stop stops the current response"
  ];
}

export function parseBuiltInCommand(content: string): BuiltInCommandName | undefined {
  const trimmed = content.trim();

  if (trimmed === "/help") {
    return "help";
  }

  if (trimmed === "/stop") {
    return "stop";
  }

  return undefined;
}

export function getIncompleteSlashCommandNotice(content: string): IncompleteSlashCommandNotice | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  const header = newlineIndex >= 0 ? normalized.slice(0, newlineIndex) : normalized;
  const trimmedHeader = header.trim();

  if (!trimmedHeader.startsWith("/")) {
    return undefined;
  }

  const approvalMatch = trimmedHeader.match(/^\/(approve|deny)(?:\s+(.+))?$/i);

  if (approvalMatch) {
    const action = approvalMatch[1]?.toLowerCase() ?? "approve";
    const approvalId = approvalMatch[2]?.trim();

    if (!approvalId) {
      return {
        message: `Command requires an approval id: /${action} <approval-id>`
      };
    }

    return undefined;
  }

  const commandToken = getSlashCommandToken(trimmedHeader);

  if (!commandToken) {
    return undefined;
  }

  const builtIn = commandPaletteItems.find((candidate) =>
    !candidate.requiresInput && getCommandToken(candidate) === commandToken
  );

  if (builtIn) {
    const rest = trimmedHeader.slice(commandToken.length + 1).trim();

    if (rest.length > 0) {
      return {
        message: `Command does not take additional input: ${builtIn.usage ?? builtIn.display}`
      };
    }

    return undefined;
  }

  const item = commandPaletteItems.find((candidate) =>
    candidate.requiresInput && getCommandToken(candidate) === commandToken
  );

  if (!item) {
    return undefined;
  }

  const rest = trimmedHeader.slice(commandToken.length + 1).trim();

  if (rest.length > 0) {
    return undefined;
  }

  return {
    message: `Command requires more input: ${item.usage ?? item.display}`
  };
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

function getSlashCommandToken(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
}

function getCommandToken(item: CommandPaletteItem) {
  return item.command.slice(1).trimEnd().toLowerCase();
}
