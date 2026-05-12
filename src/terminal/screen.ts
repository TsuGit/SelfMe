export function clearScreen() {
  return "\u001b[2J";
}

export function clearLine() {
  return "\u001b[2K";
}

export function moveCursorTo(row: number, column: number) {
  return `\u001b[${row + 1};${column + 1}H`;
}

export function hideCursor() {
  return "\u001b[?25l";
}

export function showCursor() {
  return "\u001b[?25h";
}

export async function readCursorPosition() {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    return { row: 0, column: 0 };
  }

  return await new Promise<{ row: number; column: number }>((resolve) => {
    const previousRawMode = "isRaw" in stdin ? Boolean(stdin.isRaw) : false;
    let settled = false;
    let buffer = "";

    const cleanup = () => {
      stdin.off("data", onData);
      clearTimeout(timeoutId);
      if (!previousRawMode) {
        stdin.setRawMode(false);
      }
    };

    const finish = (value: { row: number; column: number }) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const match = buffer.match(/\u001b\[(\d+);(\d+)R/);

      if (!match) {
        return;
      }

      finish({
        row: Number(match[1]) - 1,
        column: Number(match[2]) - 1
      });
    };

    const timeoutId = setTimeout(() => {
      finish({ row: 0, column: 0 });
    }, 80);

    if (!previousRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\u001b[6n");
  });
}
