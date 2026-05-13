import { access, appendFile, readFile, writeFile } from "node:fs/promises";

import type { RuntimeEvent } from "../types/events.js";

export class TranscriptStore {
  constructor(private readonly filePath: string) {}

  async ensureInitialized() {
    try {
      await access(this.filePath);
    } catch {
      await writeFile(this.filePath, "");
    }
  }

  async appendEvent(event: RuntimeEvent) {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
  }

  async readEvents() {
    const content = await readFile(this.filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuntimeEvent);
  }

  async readEventsBySession(sessionId: string) {
    const events = await this.readEvents();
    return events.filter((event) => event.sessionId === sessionId);
  }
}
