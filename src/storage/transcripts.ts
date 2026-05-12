import { access, appendFile, writeFile } from "node:fs/promises";

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
}

