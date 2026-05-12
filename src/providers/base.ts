export interface ProviderStreamInput {
  content: string;
}

export interface ProviderStreamChunk {
  delta: string;
}

export interface ProviderClient {
  readonly name: string;
  streamResponse(input: ProviderStreamInput): AsyncIterable<ProviderStreamChunk>;
}

