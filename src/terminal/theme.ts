const terminalTheme = {
  bgBase: "10;22;40",
  bgSubtle: "13;27;47",
  bgPanel: "18;32;51",
  lineSubtle: "34;54;79",
  lineStrong: "44;70;101",
  textPrimary: "237;244;251",
  textSecondary: "198;211;224",
  textMuted: "145;163;183",
  accentPrimary: "60;200;255",
  accentSecondary: "99;184;255",
  accentWarm: "216;193;143",
  stateSuccess: "112;214;168",
  stateError: "255;122;144"
} as const;

type ThemeKey = keyof typeof terminalTheme;

function resolveCode(code: ThemeKey | string) {
  return code in terminalTheme
    ? terminalTheme[code as ThemeKey]
    : code;
}

function ansi(code: ThemeKey | string, text: string, mode: "fg" | "bg" = "fg") {
  const prefix = mode === "fg" ? "38" : "48";
  return `\u001b[${prefix};2;${resolveCode(code)}m${text}\u001b[0m`;
}

export function fg(code: ThemeKey, text: string) {
  return ansi(terminalTheme[code], text, "fg");
}

export function bg(code: ThemeKey, text: string) {
  return ansi(terminalTheme[code], text, "bg");
}

export function paint(text: string, input: {
  fg?: ThemeKey | string;
  bg?: ThemeKey | string;
  bold?: boolean;
  conceal?: boolean;
}) {
  const segments: string[] = [];

  if (input.bold) {
    segments.push("\u001b[1m");
  }

  if (input.conceal) {
    segments.push("\u001b[8m");
  }

  if (input.fg) {
    segments.push(`\u001b[38;2;${resolveCode(input.fg)}m`);
  }

  if (input.bg) {
    segments.push(`\u001b[48;2;${resolveCode(input.bg)}m`);
  }

  segments.push(text, "\u001b[0m");
  return segments.join("");
}

export { terminalTheme, type ThemeKey };
