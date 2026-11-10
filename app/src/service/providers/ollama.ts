import { AppException } from '../../shared/result';
import type {
  ChatMessage,
  ChatProvider,
  EmbeddingProvider,
  ModelCatalog,
  ModelInfo,
} from './types';

interface Timeouts {
  embedMs: number;
  firstTokenMs: number;
  idleMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = { embedMs: 60_000, firstTokenMs: 180_000, idleMs: 60_000 };

// One per request: merges the caller's abort with a timer and remembers which one fired,
// so the failure can be reported as CANCELLED or TIMEOUT instead of a bare AbortError.
class Guard {
  readonly ctl = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  private cancelled = false;

  constructor(
    private readonly endpoint: string,
    private readonly caller?: AbortSignal,
  ) {
    if (caller?.aborted) this.onCallerAbort();
    else caller?.addEventListener('abort', this.onCallerAbort, { once: true });
  }

  private onCallerAbort = () => {
    this.cancelled = true;
    this.ctl.abort();
  };

  arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.ctl.abort();
    }, ms);
  }

  disarm(): void {
    clearTimeout(this.timer);
  }

  close(): void {
    this.disarm();
    this.caller?.removeEventListener('abort', this.onCallerAbort);
  }

  fail(e: unknown): unknown {
    if (e instanceof AppException) return e;
    if (this.cancelled) return new AppException('CANCELLED', 'Request cancelled');
    if (this.timedOut) {
      return new AppException('TIMEOUT', 'Ollama did not answer in time', 'The model may still be loading. Try again.');
    }
    if (e instanceof TypeError) {
      // fetch rejects with TypeError('fetch failed') for refused connections and DNS failures.
      return new AppException('OLLAMA_UNREACHABLE', `Ollama unreachable at ${this.endpoint}`, 'Start Ollama with: ollama serve');
    }
    return e;
  }
}

const modelNotFound = (model: string) =>
  new AppException('MODEL_NOT_FOUND', `Model ${model} not found`, `ollama pull ${model}`);

async function checkOk(res: Response, model?: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  if (model && (res.status === 404 || /not found/i.test(body))) throw modelNotFound(model);
  throw new AppException('INTERNAL', `Ollama returned HTTP ${res.status}`);
}

export class OllamaProvider implements EmbeddingProvider, ChatProvider, ModelCatalog {
  private readonly endpoint: string;
  private readonly timeouts: Timeouts;

  constructor(opts: { endpoint: string; timeouts?: Timeouts }) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.timeouts = opts.timeouts ?? DEFAULT_TIMEOUTS;
  }

  private async post(path: string, body: unknown, g: Guard, model?: string): Promise<Response> {
    const res = await fetch(this.endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: g.ctl.signal,
    });
    await checkOk(res, model);
    return res;
  }

  async embed(texts: string[], opts: { model: string; signal?: AbortSignal }): Promise<number[][]> {
    if (!texts.length) return [];
    const g = new Guard(this.endpoint, opts.signal);
    try {
      g.arm(this.timeouts.embedMs);
      const res = await this.post('/api/embed', { model: opts.model, input: texts }, g, opts.model);
      const { embeddings } = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new AppException('INTERNAL', 'Ollama returned an unexpected embedding response');
      }
      return embeddings;
    } catch (e) {
      throw g.fail(e);
    } finally {
      g.close();
    }
  }

  async *chat(req: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    numCtx: number;
    signal?: AbortSignal;
  }): AsyncIterable<string> {
    const g = new Guard(this.endpoint, req.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      g.arm(this.timeouts.firstTokenMs);
      const res = await this.post(
        '/api/chat',
        {
          model: req.model,
          messages: req.messages,
          stream: true,
          options: { temperature: req.temperature, num_ctx: req.numCtx },
        },
        g,
        req.model,
      );
      if (!res.body) throw new AppException('INTERNAL', 'Ollama returned no response body');
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let first = true;

      // The timer runs only while waiting on Ollama, never while the consumer handles a delta.
      for (;;) {
        g.arm(first ? this.timeouts.firstTokenMs : this.timeouts.idleMs);
        const { done, value } = await reader.read();
        g.disarm();
        first = false;
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop()!;

        for (const text of lines) {
          if (!text.trim()) continue;
          const obj = JSON.parse(text) as { error?: string; message?: { content?: string }; done?: boolean };
          if (obj.error) {
            throw /not found/i.test(obj.error)
              ? modelNotFound(req.model)
              : new AppException('INTERNAL', 'Ollama reported an error');
          }
          if (obj.message?.content) yield obj.message.content;
          if (obj.done) return;
        }
        if (done) return;
      }
    } catch (e) {
      throw g.fail(e);
    } finally {
      g.close();
      void reader?.cancel().catch(() => {});
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const g = new Guard(this.endpoint);
    try {
      g.arm(this.timeouts.embedMs);
      const res = await fetch(this.endpoint + '/api/tags', { signal: g.ctl.signal });
      await checkOk(res);
      const { models } = (await res.json()) as { models?: { name: string; digest: string }[] };
      return await Promise.all(
        (models ?? []).map(async (m) => {
          // Older Ollama versions have no capabilities in /api/show; that is not an error.
          const capabilities = await this.post('/api/show', { model: m.name }, g)
            .then(async (r) => ((await r.json()) as { capabilities?: string[] }).capabilities ?? [])
            .catch(() => []);
          return { name: m.name, digest: m.digest, capabilities };
        }),
      );
    } catch (e) {
      throw g.fail(e);
    } finally {
      g.close();
    }
  }
}
