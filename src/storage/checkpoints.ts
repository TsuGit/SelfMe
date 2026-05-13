import { access, readFile, writeFile } from "node:fs/promises";

import type { SessionCheckpoint } from "../types/checkpoint.js";

export class CheckpointStore {
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
    return JSON.parse(content.trim() || "[]") as SessionCheckpoint[];
  }

  async getLatest(sessionId: string) {
    const checkpoints = await this.list();
    return checkpoints.find((checkpoint) => checkpoint.sessionId === sessionId);
  }

  async upsert(checkpoint: SessionCheckpoint) {
    const checkpoints = await this.list();
    const nextCheckpoints = checkpoints.filter((item) => item.sessionId !== checkpoint.sessionId);
    nextCheckpoints.push(checkpoint);
    nextCheckpoints.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await writeFile(this.filePath, JSON.stringify(nextCheckpoints, null, 2));
  }
}
