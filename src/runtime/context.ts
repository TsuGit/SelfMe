import { randomUUID } from "node:crypto";

import type { SessionRecord } from "../types/session.js";

export function createDefaultSessionRecord(cwd: string, version: string): SessionRecord {
  return {
    sessionId: randomUUID(),
    title: "New session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version,
    model: "local-scaffold",
    cwd
  };
}

export function createResumedSessionRecord(input: {
  previous: SessionRecord;
  cwd: string;
  version: string;
}) {
  return {
    ...input.previous,
    cwd: input.cwd,
    version: input.version,
    updatedAt: new Date().toISOString()
  };
}
