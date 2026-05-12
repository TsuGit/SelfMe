import { z } from "zod";

import type { ProviderClient, ProviderStreamChunk, ProviderStreamInput } from "./base.js";

const anthropicStreamEventSchema = z.object({
  type: z.string(),
  delta: z.object({
    type: z.string().optional(),
    text: z.string().optional()
  }).optional()
});

function resolveMessagesEndpoint(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, "");

  if (normalized.endsWith("/v1")) {
    return `${normalized}/messages`;
  }

  return `${normalized}/v1/messages`;
}

function isMiniMaxAnthropicCompatible(baseUrl: string) {
  return /minimax(i)?\.(com|io)/i.test(baseUrl) && /\/anthropic\/?$/i.test(baseUrl.replace(/\/v1\/?$/i, ""));
}

export class AnthropicProvider implements ProviderClient {
  readonly name = "anthropic";

  constructor(
    private readonly input: {
      baseUrl: string;
      apiKey: string;
      model: string;
    }
  ) {}

  async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
    const isMiniMax = isMiniMaxAnthropicCompatible(this.input.baseUrl);
    const response = await fetch(resolveMessagesEndpoint(this.input.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isMiniMax
          ? {
              Authorization: `Bearer ${this.input.apiKey}`
            }
          : {
              "x-api-key": this.input.apiKey,
              "anthropic-version": "2023-06-01"
            })
      },
      body: JSON.stringify({
        model: this.input.model,
        max_tokens: 4096,
        stream: true,
        messages: [
          {
            role: "user",
            content: input.content
          }
        ]
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const eventBlock of events) {
        const dataLines = eventBlock
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter(Boolean);

        if (dataLines.length === 0) {
          continue;
        }

        const data = dataLines.join("\n");

        if (data === "[DONE]") {
          continue;
        }

        const parsed = anthropicStreamEventSchema.parse(JSON.parse(data));
        const delta = parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta"
          ? parsed.delta.text
          : undefined;

        if (delta) {
          yield { delta };
        }
      }
    }
  }
}
