import { z } from "zod";

import type { ProviderClient, ProviderStreamChunk, ProviderStreamInput } from "./base.js";

const chatCompletionChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().optional()
      })
    })
  ).default([])
});

export class OpenAIProvider implements ProviderClient {
  readonly name = "openai";

  constructor(
    private readonly input: {
      baseUrl: string;
      apiKey: string;
      model: string;
    }
  ) {}

  async *streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk> {
    const response = await fetch(`${this.input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.input.apiKey}`
      },
      body: JSON.stringify({
        model: this.input.model,
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
      throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
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
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        const parsed = chatCompletionChunkSchema.parse(JSON.parse(data));
        const delta = parsed.choices[0]?.delta?.content;

        if (delta) {
          yield { delta };
        }
      }
    }
  }
}
