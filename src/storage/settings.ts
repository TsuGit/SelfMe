import { access, readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

export const settingsSchema = z.object({
  provider: z.enum(["local", "openai", "anthropic"]).default("local"),
  model: z.string().default(""),
  baseUrl: z.string().default(""),
  apiKey: z.string().default("")
});

export type AppSettings = z.infer<typeof settingsSchema>;

const defaultSettings: AppSettings = {
  provider: "local",
  model: "",
  baseUrl: "",
  apiKey: ""
};

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  async ensureInitialized() {
    try {
      await access(this.filePath);
    } catch {
      await writeFile(this.filePath, JSON.stringify(defaultSettings, null, 2));
    }
  }

  async read() {
    const content = await readFile(this.filePath, "utf8");
    return settingsSchema.parse(JSON.parse(content));
  }
}
