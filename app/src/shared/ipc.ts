import { z } from 'zod';
import { PUBLIC_METHODS, type PublicMethod } from './ipc-names';
import { AppException, type AppError } from './result';
import type {
  ConversationDetail,
  ConversationSummary,
  HomeSummary,
  IndexProgress,
  ModelInfo,
  NoteDetail,
  NoteSummary,
  Settings,
  VaultPreview,
  Workspace,
} from './types';

export type { PublicMethod } from './ipc-names';

const id = z.string().min(1);
const noInput = z.undefined();
const indexStatus = z.enum(['pending', 'indexed', 'failed', 'deleted', 'excluded']);

const noteIdInput = z.strictObject({ noteId: id });
const conversationIdInput = z.strictObject({ conversationId: id });

const settingsPatch = z
  .strictObject({
    ollamaEndpoint: z.url(),
    chatModel: z.string().min(1),
    embeddingModel: z.string().min(1),
    temperature: z.number().min(0).max(2),
    maxDistance: z.number().min(0).max(2),
    answerGuidelines: z.string(),
    ignorePatterns: z.array(z.string()),
  })
  .partial();

export const inputSchemas: Record<PublicMethod, z.ZodType> = {
  'vault.choose': noInput,
  'vault.confirm': noInput,
  'vault.current': noInput,
  'vault.refresh': noInput,
  'library.list': z.strictObject({
    query: z.string().optional(),
    folder: z.string().optional(),
    tag: z.string().optional(),
    type: z.string().optional(),
    status: indexStatus.optional(),
    sort: z.enum(['modified-desc', 'title-asc']),
  }),
  'note.read': noteIdInput,
  'note.reindex': noteIdInput,
  'note.openInObsidian': noteIdInput,
  'index.status': noInput,
  'index.retry': z.strictObject({ noteId: id.optional() }),
  'index.cancel': noInput,
  'index.reembedAll': noInput,
  'chat.list': noInput,
  'chat.get': conversationIdInput,
  'chat.send': z.strictObject({
    conversationId: id.nullable(),
    text: z.string().min(1).max(8000),
    mode: z.enum(['rag', 'general']),
  }),
  'chat.cancel': z.strictObject({ requestId: id }),
  'chat.rename': z.strictObject({ conversationId: id, title: z.string().min(1).max(200) }),
  'chat.delete': conversationIdInput,
  'chat.deleteAll': noInput,
  'settings.get': noInput,
  'settings.update': settingsPatch,
  'ollama.test': noInput,
  'home.summary': noInput,
  'data.revealDb': noInput,
  'data.rebuildIndex': noInput,
};

export interface ApiOutputs {
  'vault.choose': VaultPreview | null;
  'vault.confirm': Workspace;
  'vault.current': Workspace | null;
  'vault.refresh': {
    added: number;
    changed: number;
    renamed: number;
    deleted: number;
    excluded: number;
  };
  'library.list': NoteSummary[];
  'note.read': NoteDetail;
  'note.reindex': void;
  'note.openInObsidian': void;
  'index.status': IndexProgress;
  'index.retry': void;
  'index.cancel': void;
  'index.reembedAll': void;
  'chat.list': ConversationSummary[];
  'chat.get': ConversationDetail;
  'chat.send': { conversationId: string; assistantMessageId: string; requestId: string };
  'chat.cancel': void;
  'chat.rename': void;
  'chat.delete': void;
  'chat.deleteAll': void;
  'settings.get': Settings;
  'settings.update': Settings;
  'ollama.test': { reachable: boolean; models: ModelInfo[]; error?: AppError };
  'home.summary': HomeSummary;
  'data.revealDb': void;
  'data.rebuildIndex': void;
}

export function parseInput(method: string, input: unknown): unknown {
  // includes() on the tuple, not a lookup in inputSchemas: 'constructor' must not match.
  if (!(PUBLIC_METHODS as readonly string[]).includes(method)) {
    throw new AppException('UNKNOWN_METHOD', `Unknown method: ${method}`);
  }
  const parsed = inputSchemas[method as PublicMethod].safeParse(input);
  if (!parsed.success) {
    // Field paths only; zod messages can echo back the offending value.
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(input)').join(', ');
    throw new AppException('INVALID_INPUT', `Invalid input for ${method}`, `Check: ${fields}`);
  }
  return parsed.data;
}
