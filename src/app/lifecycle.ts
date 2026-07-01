import { createSystemMessageAppendedEvent } from "../runtime/events.js";
import type { AgentRuntime } from "../runtime/agent.js";
import type { TranscriptStore } from "../storage/transcripts.js";
import type { TerminalEventLoop } from "../terminal/event-loop.js";
import type { EventBus } from "./event-bus.js";

export class AppLifecycle {
  constructor(
    private readonly input: {
      bus: EventBus;
      runtime: AgentRuntime;
      renderer: {
        start(): Promise<void>;
      };
      terminal: TerminalEventLoop;
      transcriptStore: TranscriptStore;
      sessionId: string;
      startupNotices: Array<{
        title: string;
        content: string;
      }>;
    }
  ) {}

  async start() {
    await this.input.transcriptStore.ensureInitialized();
    await this.input.renderer.start();
    await this.input.runtime.start();

    for (const notice of this.input.startupNotices) {
      const event = createSystemMessageAppendedEvent({
        sessionId: this.input.sessionId,
        title: notice.title,
        content: notice.content
      });
      this.input.bus.emit(event);
      await this.input.transcriptStore.appendEvent(event);
    }

    this.input.terminal.start();
  }
}
