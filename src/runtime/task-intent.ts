export function extractExpectedOutputFromTaskRequest(request: string) {
  const quotedMatch = request.match(/\b(?:print|prints|output|outputs|return|returns)\b[\s\S]{0,80}?\bexact(?:ly)?\b[\s\S]{0,20}?["'`]([^"'`]+)["'`]/i);

  if (quotedMatch?.[1]?.trim()) {
    return quotedMatch[1].trim();
  }

  const backtickValues = [...request.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  return backtickValues.at(-1);
}
