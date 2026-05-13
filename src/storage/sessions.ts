import { access, readFile, writeFile } from "node:fs/promises";

import type { SessionRecord } from "../types/session.js";

export class SessionStore {
  constructor(private readonly filePath: string) {}

  async ensureInitialized() {
    try {
      await access(this.filePath);
    } catch {
      await writeFile(this.filePath, "[]");
    }
  }

  async list() {
    const content = await readFile(this.filePath, "utf8");
    return JSON.parse(content.trim() || "[]") as SessionRecord[];
  }

  async getLatest() {
    const sessions = await this.list();
    return sessions
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async resolve(query: string) {
    const sessions = await this.list();
    const exact = sessions.find((session) => session.sessionId === query);

    if (exact) {
      return exact;
    }

    const matched = sessions.filter((session) => session.sessionId.startsWith(query));

    if (matched.length === 1) {
      return matched[0];
    }

    if (matched.length > 1) {
      throw new Error(`Ambiguous session id: ${query}`);
    }

    return undefined;
  }

  async upsert(session: SessionRecord) {
    const sessions = await this.list();
    const nextSessions = sessions.filter((item) => item.sessionId !== session.sessionId);
    nextSessions.push(session);
    nextSessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await writeFile(this.filePath, JSON.stringify(nextSessions, null, 2));
  }
}
