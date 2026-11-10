import { AppException } from '../../shared/result';
import type { ChatMessage, ChatProvider, EmbeddingProvider, ModelCatalog, ModelInfo } from './types';

// FNV-1a: a stable word → bucket mapping, so the same text always gives the same vector.
function bucket(word: string, dim: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 0x01000193);
  return (h >>> 0) % dim;
}

// Documents and queries must share a space, so drop the task prefix and the "title › path" header line.
function stripPrefixAndHeader(text: string): string {
  if (text.startsWith('search_query: ')) return text.slice('search_query: '.length);
  if (!text.startsWith('search_document: ')) return text;
  const body = text.slice('search_document: '.length);
  const gap = body.indexOf('\n\n');
  return gap < 0 ? body : body.slice(gap + 2);
}

export class FakeEmbeddingProvider implements EmbeddingProvider, ModelCatalog {
  constructor(private readonly dim = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const w of stripPrefixAndHeader(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        v[bucket(w, this.dim)] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'fake-embed', digest: 'fake', capabilities: ['embedding'] }];
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

export class FakeChatProvider implements ChatProvider {
  constructor(
    private readonly reply: string | ((messages: ChatMessage[]) => string),
    private readonly opts: { chunkSize?: number; delayMs?: number } = {},
  ) {}

  async *chat(req: { messages: ChatMessage[]; signal?: AbortSignal }): AsyncIterable<string> {
    const text = typeof this.reply === 'function' ? this.reply(req.messages) : this.reply;
    const size = this.opts.chunkSize ?? 5;
    for (let i = 0; i < text.length; i += size) {
      if (this.opts.delayMs) await sleep(this.opts.delayMs, req.signal);
      if (req.signal?.aborted) throw new AppException('CANCELLED', 'Generation cancelled');
      yield text.slice(i, i + size);
    }
  }
}
