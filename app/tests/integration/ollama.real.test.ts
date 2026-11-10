import { expect, test } from 'vitest';
import { OllamaProvider } from '../../src/service/providers/ollama';
import { DEFAULT_SETTINGS } from '../../src/service/db/settings';

// Opt-in: OLLAMA_IT=1 npm test -- ollama.real  (needs `ollama serve` and both models pulled)
const real = test.skipIf(!process.env.OLLAMA_IT);
const provider = new OllamaProvider({ endpoint: DEFAULT_SETTINGS.ollamaEndpoint });

real('nomic-embed-text returns 768 dims', async () => {
  const [v] = await provider.embed(['search_document: hello world'], { model: DEFAULT_SETTINGS.embeddingModel });
  expect(v).toHaveLength(768);
}, 60_000);

real('qwen2.5:3b streams at least one delta', async () => {
  let n = 0;
  for await (const d of provider.chat({
    model: DEFAULT_SETTINGS.chatModel,
    messages: [{ role: 'user', content: 'Say hi in one word.' }],
    temperature: 0,
    numCtx: 2048,
  })) {
    if (d) n++;
    if (n >= 1) break;
  }
  expect(n).toBeGreaterThan(0);
}, 240_000);

real('listModels reports the pulled models', async () => {
  const names = (await provider.listModels()).map((m) => m.name);
  expect(names.some((n) => n.startsWith('nomic-embed-text'))).toBe(true);
});
