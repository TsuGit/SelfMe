import type { EventBus } from "./event-bus.js";
import type { AgentRuntime } from "../runtime/agent.js";
import type { TerminalRenderer } from "../terminal/renderer.js";
import type { TerminalEventLoop } from "../terminal/event-loop.js";
import type { SettingsStore } from "../storage/settings.js";
import type { TranscriptStore } from "../storage/transcripts.js";

export class AppLifecycle {
  constructor(
    private readonly input: {
      bus: EventBus;
      runtime: AgentRuntime;
      renderer: TerminalRenderer;
      terminal: TerminalEventLoop;
      settings: SettingsStore;
      transcriptStore: TranscriptStore;
    }
  ) {}

  async start() {
    await this.input.transcriptStore.ensureInitialized();
    await this.input.runtime.start();
    await this.input.renderer.start();
    this.input.terminal.start();
  }
}
