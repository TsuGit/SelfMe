export type TerminalInputEvent =
  | { type: "quit" }
  | { type: "submit" }
  | { type: "newline" }
  | { type: "action-next" }
  | { type: "action-prev" }
  | { type: "action-cancel" }
  | { type: "backspace" }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "move-left" }
  | { type: "move-right" }
  | { type: "scroll"; delta: number }
  | { type: "text"; value: string };

const fixedSequences: Array<{
  sequence: string;
  event: TerminalInputEvent;
}> = [
  { sequence: "\u0003", event: { type: "quit" } },
  { sequence: "\u001b[99;5u", event: { type: "quit" } },
  { sequence: "\u001b[67;5u", event: { type: "quit" } },
  { sequence: "\u001b[Z", event: { type: "action-prev" } },
  { sequence: "\t", event: { type: "action-next" } },
  { sequence: "\u001b[13;2u", event: { type: "newline" } },
  { sequence: "\u001b[27;13;2~", event: { type: "newline" } },
  { sequence: "\u001b[13;2~", event: { type: "newline" } },
  { sequence: "\u001b[5~", event: { type: "scroll", delta: -10 } },
  { sequence: "\u001b[6~", event: { type: "scroll", delta: 10 } },
  { sequence: "\u001b[1;5A", event: { type: "scroll", delta: -3 } },
  { sequence: "\u001b[1;5B", event: { type: "scroll", delta: 3 } },
  { sequence: "\u001b[5A", event: { type: "scroll", delta: -3 } },
  { sequence: "\u001b[5B", event: { type: "scroll", delta: 3 } },
  { sequence: "\u001b[A", event: { type: "move-up" } },
  { sequence: "\u001bOA", event: { type: "move-up" } },
  { sequence: "\u001b[B", event: { type: "move-down" } },
  { sequence: "\u001bOB", event: { type: "move-down" } },
  { sequence: "\u001b[D", event: { type: "move-left" } },
  { sequence: "\u001bOD", event: { type: "move-left" } },
  { sequence: "\u001b[C", event: { type: "move-right" } },
  { sequence: "\u001bOC", event: { type: "move-right" } },
  { sequence: "\u007f", event: { type: "backspace" } },
  { sequence: "\b", event: { type: "backspace" } },
  { sequence: "\r", event: { type: "submit" } },
  { sequence: "\n", event: { type: "newline" } },
  { sequence: "\u001b", event: { type: "action-cancel" } }
];

export function parseTerminalInput(chunk: Buffer | string) {
  const events: TerminalInputEvent[] = [];
  let remaining = chunk.toString("utf8");

  while (remaining.length > 0) {
    const fixed = fixedSequences.find((candidate) => remaining.startsWith(candidate.sequence));

    if (fixed) {
      events.push(fixed.event);
      remaining = remaining.slice(fixed.sequence.length);
      continue;
    }

    const controlSequence = matchControlSequence(remaining);

    if (controlSequence) {
      remaining = remaining.slice(controlSequence.length);
      continue;
    }

    if (remaining.startsWith("\u001b")) {
      remaining = remaining.slice(1);
      continue;
    }

    const chars = Array.from(remaining);
    const char = chars[0];

    if (!char) {
      break;
    }

    events.push({
      type: "text",
      value: char
    });
    remaining = remaining.slice(char.length);
  }

  return events;
}

function matchControlSequence(input: string) {
  const csiMatch = input.match(/^\u001b\[[0-9;:?<>]*[ -/]*[@-~]/);

  if (csiMatch) {
    return csiMatch[0];
  }

  const ss3Match = input.match(/^\u001bO[@-~]/);

  if (ss3Match) {
    return ss3Match[0];
  }

  return "";
}
