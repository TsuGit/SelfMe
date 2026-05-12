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
