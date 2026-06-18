export function formatToolSummaryLine(toolName: string, summary: string) {
  const trimmed = summary.trim();
  const label = capitalizeWord(toolName);

  if (!trimmed) {
    return `${label} · Completed`;
  }

  const leadingToolPattern = new RegExp(`^${escapeRegExp(toolName)}\\s+·\\s+`, "i");

  if (leadingToolPattern.test(trimmed)) {
    return trimmed.replace(leadingToolPattern, `${label} · `);
  }

  return `${label} · ${trimmed}`;
}

function capitalizeWord(value: string) {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
