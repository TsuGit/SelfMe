export interface ProviderContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderStreamInput {
  content: string;
  contextMessages?: ProviderContextMessage[];
  signal?: AbortSignal;
}

export interface ProviderStreamChunk {
  delta: string;
}

export interface ProviderClient {
  readonly name: string;
  streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk>;
}
