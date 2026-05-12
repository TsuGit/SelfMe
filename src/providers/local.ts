import type { ProviderClient, ProviderStreamInput, ProviderStreamChunk } from "./base.js";

export class LocalProvider implements ProviderClient {
  readonly name = "local-scaffold";

  async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
    const text = `Scaffold online.\n\nReceived:\n${input.content.trim()}\n\nProvider integration is the next step.`;
    const words = text.split(" ");

    for (const word of words) {
      yield { delta: `${word} ` };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
