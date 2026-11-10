import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { OllamaProvider } from '../../src/service/providers/ollama';

let server: http.Server;
let endpoint: string;
let handler: http.RequestListener;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

const readJson = async (req: http.IncomingMessage) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
};
const line = (obj: unknown) => JSON.stringify(obj) + '\n';
const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const chatReq = (extra: object = {}) => ({
  model: 'm',
  messages: [{ role: 'user' as const, content: 'hi' }],
  temperature: 0.2,
  numCtx: 8192,
  ...extra,
});

test('embed returns vectors and sends model and input', async () => {
  let seen: any;
  handler = async (req, res) => {
    seen = await readJson(req);
    res.end(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }));
  };
  const vectors = await new OllamaProvider({ endpoint }).embed(['a', 'b'], { model: 'nomic' });
  expect(vectors).toEqual([[1, 0], [0, 1]]);
  expect(seen).toEqual({ model: 'nomic', input: ['a', 'b'] });
});

test('unreachable endpoint', async () =>
  expect(new OllamaProvider({ endpoint: 'http://127.0.0.1:9' }).embed(['a'], { model: 'm' })).rejects.toMatchObject({
    code: 'OLLAMA_UNREACHABLE',
    hint: expect.stringContaining('ollama serve'),
  }));

test('missing model', async () => {
  handler = (_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'model "m" not found, try pulling it first' }));
  };
  await expect(new OllamaProvider({ endpoint }).embed(['a'], { model: 'm' })).rejects.toMatchObject({
    code: 'MODEL_NOT_FOUND',
    hint: 'ollama pull m',
  });
});

test('chat streams NDJSON deltas, even when a line is split across chunks', async () => {
  let seen: any;
  handler = async (req, res) => {
    seen = await readJson(req);
    res.write(line({ message: { content: 'He' }, done: false }));
    const second = line({ message: { content: 'llo' }, done: false });
    res.write(second.slice(0, 10));
    await new Promise((r) => setTimeout(r, 20));
    res.write(second.slice(10));
    res.write(line({ message: { content: '!' }, done: false }));
    res.end(line({ message: { content: '' }, done: true }));
  };
  const deltas = await collect(new OllamaProvider({ endpoint }).chat(chatReq()));
  expect(deltas).toEqual(['He', 'llo', '!']);
  expect(seen).toMatchObject({ model: 'm', stream: true, options: { temperature: 0.2, num_ctx: 8192 } });
});

test('chat maps a missing model reported inside the stream', async () => {
  handler = (_req, res) => res.end(line({ error: 'model "m" not found' }));
  await expect(collect(new OllamaProvider({ endpoint }).chat(chatReq()))).rejects.toMatchObject({
    code: 'MODEL_NOT_FOUND',
  });
});

test('first-token timeout', async () => {
  handler = () => {}; // never writes
  const p = new OllamaProvider({ endpoint, timeouts: { embedMs: 1000, firstTokenMs: 50, idleMs: 1000 } });
  await expect(collect(p.chat(chatReq()))).rejects.toMatchObject({ code: 'TIMEOUT' });
});

test('idle timeout between tokens', async () => {
  handler = (_req, res) => res.write(line({ message: { content: 'He' }, done: false })); // then silence
  const p = new OllamaProvider({ endpoint, timeouts: { embedMs: 1000, firstTokenMs: 1000, idleMs: 50 } });
  await expect(collect(p.chat(chatReq()))).rejects.toMatchObject({ code: 'TIMEOUT' });
});

test('abort cancels', async () => {
  handler = (_req, res) => res.write(line({ message: { content: 'He' }, done: false })); // then hangs
  const ctl = new AbortController();
  const got: string[] = [];
  const run = (async () => {
    for await (const d of new OllamaProvider({ endpoint }).chat(chatReq({ signal: ctl.signal }))) {
      got.push(d);
      ctl.abort();
    }
  })();
  await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(got).toEqual(['He']);
});

test('listModels merges capabilities', async () => {
  handler = async (req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'a', digest: 'd' }] }));
    } else {
      expect(await readJson(req)).toEqual({ model: 'a' });
      res.end(JSON.stringify({ capabilities: ['completion', 'vision'] }));
    }
  };
  expect(await new OllamaProvider({ endpoint }).listModels()).toEqual([
    { name: 'a', digest: 'd', capabilities: ['completion', 'vision'] },
  ]);
});
