import type { ModelInfo } from '../../shared/types';

export type { ModelInfo };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbeddingProvider {
  embed(texts: string[], opts: { model: string; signal?: AbortSignal }): Promise<number[][]>;
}

export interface ChatProvider {
  chat(req: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    numCtx: number;
    signal?: AbortSignal;
  }): AsyncIterable<string>;
}

export interface ModelCatalog {
  listModels(): Promise<ModelInfo[]>;
}
