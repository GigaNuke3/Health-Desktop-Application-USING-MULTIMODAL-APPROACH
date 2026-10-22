# Second Brain Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan is being implemented by hand by the user, with Claude guiding task by task.** Claude explains, reviews and answers questions; the user writes the code.

**Goal:** A launchable Electron app that indexes a selected Obsidian vault into SQLite + sqlite-vec with Ollama embeddings, and answers questions with clickable, verified citations, keeping all state across restarts.

**Architecture:** Three processes. A sandboxed React renderer talks only to `window.api`; the main process owns windows, dialogs and shell actions and forwards everything else; a `utilityProcess` "knowledge service" owns the database, vault scanning, indexing, retrieval and Ollama. All pure logic (parse, chunk, diff, retrieve, citations) lives in small modules tested without Electron windows.

**Tech Stack:** Electron + Electron Forge (`vite` template with `--typescript`), React, better-sqlite3, sqlite-vec, zod, yaml, react-markdown + remark-gfm, lucide-react, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-second-brain-core-loop-design.md`

## Global Constraints

- App root is `app/` at the repository root. All paths below are relative to `app/` unless they start with `docs/` or `Obisidan-Health/`.
- Node `>=22` (installed: 22.22.2), npm. No pnpm/yarn.
- Versions at time of writing (pin these majors; let the Forge template choose Electron/Vite/TypeScript): `@electron-forge/*` 8.0.1, `better-sqlite3` 13.x, `sqlite-vec` 0.1.9, `zod` 4.x, `yaml` 2.x, `react` 19.x, `react-markdown` 10.x, `remark-gfm` 4.x, `lucide-react` 1.x, `vitest` 5.x, `@playwright/test` 1.64.x.
- No other runtime dependencies without asking first.
- The app never writes inside the vault folder. No `fs.write*`, `fs.rm*`, `fs.rename*` call may take a vault path.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The renderer never sends a file path.
- Database file: `path.join(app.getPath('userData'), 'brain.db')`.
- Default models: chat `qwen2.5:3b`, embeddings `nomic-embed-text`. Default endpoint `http://127.0.0.1:11434`.
- Embedding prefixes: documents `search_document: `, queries `search_query: `.
- Logs never contain note text, chunk text, questions or answers.
- Test fixtures are synthetic general-topic notes only. Never real or invented personal health data.
- Tests run under Electron's Node: `npm test` = `ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`.

## Review Focus

1. **Vault folder missing or unmounted during a scan** → `syncVault` throws `VAULT_NOT_FOUND` and changes nothing; it must never mark every note `deleted`. (Task 7)
2. **CRLF line endings and non-ASCII text** (Obsidian Sync from another device, `›`, accents, emoji) → headings, links and `charStart`/`charEnd` are correct, and offsets slice the original file text exactly. (Tasks 5, 6)
3. **A note edited while it is being indexed** → after the running job finishes, a new job for the same note runs, and the final chunks match the latest file content. (Task 9)
4. **File names with spaces, `#`, `?`, `&` or non-ASCII** (the vault has `06 - Health Research/...`) → the `obsidian://` URI round-trips through `decodeURIComponent` to the exact absolute path. (Task 14)
5. **Empty notes, frontmatter-only notes and notes with no headings** → indexed successfully (status `indexed`, 0 or 1 chunks), never `failed`, never a chunk with empty text. (Tasks 6, 9)

---

### Task 1: Scaffold, security baseline and test runner

**Files:**
- Create: `app/` via the Forge template
- Modify: `forge.config.mts`, `vite.main.config.mts`, `package.json`, `src/main.ts` → move to `src/main/main.ts`, `src/preload.ts` → `src/preload/preload.ts`
- Create: `src/main/security.ts`, `src/service/service.ts` (stub that logs `ready`), `vitest.config.ts`
- Test: `tests/unit/security.test.ts`

**Interfaces:**
- Produces: `buildCsp(dev: boolean): string`, `hardenWindow(win: BrowserWindow): void` in `src/main/security.ts`. Folder layout from spec §10.

- [ ] **Step 1: Scaffold**

```bash
cd /home/eco/Health-Desktop-Application-USING-MULTIMODAL-APPROACH
npx create-electron-app@8.0.1 app --template vite --typescript --skip-git
cd app
npm install better-sqlite3@13 sqlite-vec@0.1.9 zod@4 yaml@2 react@19 react-dom@19 react-markdown@10 remark-gfm@4 lucide-react@1
npm install -D vitest@5 @vitejs/plugin-react @types/better-sqlite3 @types/react @types/react-dom @electron/rebuild
```

Expected: `npm start` opens the template window.

- [ ] **Step 2: Restructure and configure**

- Move entries to `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/` (index.html, `main.tsx`, `App.tsx` rendering "Second Brain").
- `forge.config.mts`: Vite plugin `build` gets a third entry `{ entry: 'src/service/service.ts', config: 'vite.main.config.mts', target: 'main' }`. Entry file names must differ: Forge names each bundle after its entry's basename, so two `index.ts` entries would overwrite each other in `.vite/build/`. `package.json` `main` is `.vite/build/main.cjs`; set `productName: "Second Brain"` and `name: "second-brain"`.
- `vite.main.config.mts`: `build.rollupOptions.external: ['better-sqlite3', 'sqlite-vec']`.
- Renderer Vite config adds `@vitejs/plugin-react`.
- `package.json` scripts: `"test": "ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run"`, `"postinstall": "electron-rebuild -f -o better-sqlite3"`.
- `vitest.config.ts`: `environment: 'node'`, `include: ['tests/**/*.test.ts']`, `exclude: ['tests/e2e/**']`.
- `BrowserWindow` webPreferences: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

- [ ] **Step 3: Write the failing test**

```ts
import { buildCsp } from '../../src/main/security';
test('production CSP is strict', () => {
  const csp = buildCsp(false);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
});
test('dev CSP allows only the Vite HMR socket and inline preamble', () => {
  const csp = buildCsp(true);
  expect(csp).toMatch(/connect-src 'self' ws:\/\/localhost:\*/);
  expect(csp).toMatch(/script-src 'self' 'unsafe-inline'/);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test` — Expected: FAIL, cannot find `buildCsp`.

- [ ] **Step 5: Implement `src/main/security.ts`**

`buildCsp(dev)`: production `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Dev adds `'unsafe-inline'` to `script-src` (React refresh preamble) and `ws://localhost:*` to `connect-src`.
`hardenWindow(win)`: set CSP with `session.webRequest.onHeadersReceived`; `setWindowOpenHandler(() => ({ action: 'deny' }))`; `will-navigate` → `preventDefault()` unless the URL is the app's own origin. `dev` = `MAIN_WINDOW_VITE_DEV_SERVER_URL` is defined.

- [ ] **Step 6: Verify**

Run: `npm test` — Expected: PASS. Run `npm start` — window shows "Second Brain"; DevTools console has no CSP errors.

- [ ] **Step 7: Commit**

```bash
git add app && git commit -m "feat: scaffold Electron app with security baseline and test runner"
```

---

### Task 2: Shared IPC contract and error type

**Files:**
- Create: `src/shared/result.ts`, `src/shared/ipc.ts`, `src/shared/ipc-names.ts`, `src/shared/types.ts`
- Test: `tests/unit/ipc.test.ts`

**Interfaces:**
- Produces (`src/shared/result.ts`):
  - `type ErrorCode = 'INVALID_INPUT' | 'UNKNOWN_METHOD' | 'VAULT_NOT_FOUND' | 'NO_VAULT' | 'PATH_OUTSIDE_VAULT' | 'PATH_IGNORED' | 'NOT_FOUND' | 'OLLAMA_UNREACHABLE' | 'MODEL_NOT_FOUND' | 'TIMEOUT' | 'DIMENSION_MISMATCH' | 'EMBEDDING_MODEL_MISMATCH' | 'DB_NEWER_THAN_APP' | 'CANCELLED' | 'INTERNAL'`
  - `interface AppError { code: ErrorCode; message: string; hint?: string }`
  - `type Result<T> = { ok: true; data: T } | { ok: false; error: AppError }`
  - `class AppException extends Error { constructor(code: ErrorCode, message: string, hint?: string) }` with public `code`, `hint`
  - `toAppError(e: unknown): AppError` (AppException → its fields; anything else → `INTERNAL`, message `"Unexpected error"`)
- Produces (`src/shared/types.ts`): `Workspace`, `NoteSummary`, `NoteDetail`, `LibraryFilter`, `IndexProgress`, `Settings`, `ModelInfo`, `ConversationSummary`, `ConversationDetail`, `MessageView`, `CitationView`, `HomeSummary`, `VaultPreview`. Field lists follow the spec tables; `IndexProgress = { queued: number; running: number; done: number; failed: number; current: string | null; paused: null | 'ollama-unreachable' | 'model-mismatch' | 'cancelled' | 'no-vault' }`. `Settings = { ollamaEndpoint: string; chatModel: string; embeddingModel: string; temperature: number; maxDistance: number }`. Chat views, used by Tasks 12 and 17:
  - `CitationView = { marker: string; rank: number; score: number; cited: boolean; chunkId: number | null; noteId: string; noteRelPath: string; noteTitle: string; headingPath: string[]; snapshotText: string; charStart: number | null; charEnd: number | null; noteStatus: string }` (`charStart`/`charEnd` are the live chunk's offsets, null when the chunk is gone)
  - `MessageView = { id: string; role: 'user' | 'assistant'; content: string; mode: 'rag' | 'general'; status: 'complete' | 'cancelled' | 'error' | 'no_match'; model: string | null; createdAt: string; citations: CitationView[]; unknownMarkers: string[] }`
  - `ConversationSummary = { id: string; title: string; updatedAt: string }`, `ConversationDetail = ConversationSummary & { messages: MessageView[] }`
- Produces (`src/shared/ipc-names.ts`, no imports, used by preload): `PUBLIC_METHODS` (readonly tuple) and `EVENTS = ['index:progress', 'chat:delta', 'chat:done', 'service:status'] as const`.
- Produces (`src/shared/ipc.ts`): `inputSchemas: Record<PublicMethod, z.ZodType>`, `type ApiOutputs` (method → output type), `type PublicMethod = typeof PUBLIC_METHODS[number]`, `parseInput(method: string, input: unknown): unknown` throwing `AppException('UNKNOWN_METHOD' | 'INVALID_INPUT')`.

Public methods and inputs:

| Method | Input | Output |
|---|---|---|
| `vault.choose` | none | `VaultPreview \| null` (`{ path, mdCount }`, null when dialog cancelled) |
| `vault.confirm` | none (uses the path main remembered from `vault.choose`) | `Workspace` |
| `vault.current` | none | `Workspace \| null` |
| `vault.refresh` | none | `{ added, changed, renamed, deleted, excluded }` counts |
| `library.list` | `{ query?, folder?, tag?, type?, status?, sort: 'modified-desc' \| 'title-asc' }` | `NoteSummary[]` |
| `note.read` | `{ noteId: string }` | `NoteDetail` (raw content, frontmatter, links, chunks' heading paths and offsets) |
| `note.reindex` | `{ noteId }` | `void` |
| `note.openInObsidian` | `{ noteId }` | `void` |
| `index.status` | none | `IndexProgress` |
| `index.retry` | `{ noteId?: string }` | `void` |
| `index.cancel` | none | `void` |
| `index.reembedAll` | none | `void` |
| `chat.list` | none | `ConversationSummary[]` |
| `chat.get` | `{ conversationId }` | `ConversationDetail` |
| `chat.send` | `{ conversationId: string \| null, text: string (1..8000 chars), mode: 'rag' \| 'general' }` | `{ conversationId, assistantMessageId, requestId }` |
| `chat.cancel` | `{ requestId }` | `void` |
| `chat.rename` | `{ conversationId, title: string (1..200) }` | `void` |
| `chat.delete` | `{ conversationId }` | `void` |
| `chat.deleteAll` | none | `void` |
| `settings.get` | none | `Settings` |
| `settings.update` | `Partial<Settings>` + `{ answerGuidelines?, ignorePatterns? }` (strict object) | `Settings` |
| `ollama.test` | none | `{ reachable: boolean; models: ModelInfo[]; error?: AppError }` |
| `home.summary` | none | `HomeSummary` |
| `data.revealDb` | none | `void` |
| `data.rebuildIndex` | none | `void` |

All IDs are strings in the contract; all object schemas are `.strict()`.

- [ ] **Step 1: Write the failing test**

```ts
test('rejects unknown methods', () => {
  expect(() => parseInput('fs.readFile', {})).toThrow(expect.objectContaining({ code: 'UNKNOWN_METHOD' }));
});
test('rejects extra fields, so no path can be smuggled in', () => {
  expect(() => parseInput('note.read', { noteId: 'a', path: '/etc/passwd' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
test('rejects empty and oversize chat text', () => {
  expect(() => parseInput('chat.send', { conversationId: null, text: '', mode: 'rag' })).toThrow();
  expect(() => parseInput('chat.send', { conversationId: null, text: 'x'.repeat(8001), mode: 'rag' })).toThrow();
});
test('every public method has a schema', () => {
  for (const m of PUBLIC_METHODS) expect(inputSchemas[m]).toBeDefined();
});
test('toAppError hides non-app errors', () => {
  expect(toAppError(new Error('secret note text'))).toEqual({ code: 'INTERNAL', message: 'Unexpected error' });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- ipc` → FAIL, module not found.
- [ ] **Step 3: Implement the four files above.** Methods with no input use `z.undefined()`.
- [ ] **Step 4: Run to verify it passes** — `npm test -- ipc` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: shared IPC contract with zod validation"`

---

### Task 3: Database connection and migrations

**Files:**
- Create: `src/service/db/connection.ts`, `src/service/db/migrate.ts`, `src/service/db/migrations/001_init.sql`
- Test: `tests/unit/migrate.test.ts`

**Interfaces:**
- Produces: `openDatabase(file: string): Database` (better-sqlite3; loads sqlite-vec with `sqliteVec.load(db)`; pragmas `journal_mode = WAL`, `foreign_keys = ON`). `type Migration = { version: number; sql: string }`. `loadMigrations(): Migration[]` (via `import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true })`, version = leading number of the file name). `migrate(db: Database, migrations: Migration[]): void`.
- `001_init.sql` creates every table from spec §4 except the per-model `vec0` tables (created at runtime, Task 8). Spec additions: `notes.id TEXT PRIMARY KEY` (`crypto.randomUUID()`), `chunks.id INTEGER PRIMARY KEY`, `workspaces.id INTEGER PRIMARY KEY`, `messages.status` also allows `'no_match'`, `citations.cited INTEGER NOT NULL` (0/1). Foreign keys: chunks/links/jobs → notes `ON DELETE CASCADE`; messages → conversations and citations → messages `ON DELETE CASCADE`; `citations.chunk_id` → chunks `ON DELETE SET NULL`.

- [ ] **Step 1: Write the failing test** (use `:memory:`)

```ts
test('fresh database reaches the latest version', () => {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations());
  expect(db.prepare('SELECT max(version) v FROM schema_migrations').get()).toEqual({ v: 1 });
});
test('running twice is a no-op', () => { /* migrate twice, row count of schema_migrations stays 1 */ });
test('a failing migration rolls back completely', () => {
  // migrations [ {1, valid}, {2, 'CREATE TABLE x(a); SELECT nope FROM missing;'} ] → throws, table x absent, max version 1
});
test('refuses a database newer than the app', () => {
  // insert version 99 → migrate throws code DB_NEWER_THAN_APP
});
test('sqlite-vec is loaded', () => {
  expect(openDatabase(':memory:').prepare('select vec_version() v').get()).toHaveProperty('v');
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- migrate` → FAIL.
- [ ] **Step 3: Implement.** Each migration runs inside `db.transaction()` together with its `schema_migrations` insert.
- [ ] **Step 4: Run to verify it passes** — `npm test -- migrate` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: SQLite connection with sqlite-vec and migrations"`

---

### Task 4: Vault guard

**Files:**
- Create: `src/service/vault/guard.ts`, `tests/fixtures/vault/` (start it here; Task 5 fills in notes)
- Test: `tests/unit/guard.test.ts`

**Interfaces:**
- Produces: `DEFAULT_IGNORES = ['.obsidian/**', '.trash/**', '.boost/**']`. `createVaultGuard(root: string, ignorePatterns: string[]): VaultGuard` where `VaultGuard = { root: string; isIgnored(relPath: string): boolean; resolve(relPath: string): Promise<string> }`. `resolve` returns the real absolute path or throws `AppException('PATH_OUTSIDE_VAULT' | 'PATH_IGNORED' | 'NOT_FOUND')`. Matching uses `path.matchesGlob` on POSIX-style relative paths; a pattern `dir/**` also matches the directory `dir` itself.

- [ ] **Step 1: Create the fixtures.** `tests/fixtures/vault/.obsidian/app.json` (`{}`), `tests/fixtures/vault/Home.md` (`# Home`). In a test `beforeAll`, create a temp dir with `fs.mkdtemp`, copy the fixture vault in, and add a symlink `escape.md` → a file outside the temp vault (git does not reliably keep symlinks).

- [ ] **Step 2: Write the failing test**

```ts
test('resolves a normal note', async () => expect(await guard.resolve('Home.md')).toBe(path.join(realRoot, 'Home.md')));
test('refuses ..', async () => expect(guard.resolve('../outside.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));
test('refuses absolute paths', async () => expect(guard.resolve('/etc/passwd')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));
test('refuses a symlink that escapes', async () => expect(guard.resolve('escape.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_VAULT' }));
test('refuses ignored folders', async () => expect(guard.resolve('.obsidian/app.json')).rejects.toMatchObject({ code: 'PATH_IGNORED' }));
test('custom patterns', () => expect(createVaultGuard(root, ['reports/**']).isIgnored('reports/a.md')).toBe(true));
test('a sibling folder sharing the prefix is outside', async () => { /* root /tmp/x/vault, path ../vault-evil/a.md → PATH_OUTSIDE_VAULT */ });
```

- [ ] **Step 3: Run to verify it fails** — `npm test -- guard` → FAIL.
- [ ] **Step 4: Implement.** `fs.realpath` both the root and the target, then require `target === root || target.startsWith(root + path.sep)`.
- [ ] **Step 5: Run to verify it passes** — `npm test -- guard` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: vault path guard"`

---

### Task 5: Markdown parsing and link resolution

**Files:**
- Create: `src/service/markdown/parse.ts`, `src/service/markdown/links.ts`
- Create fixtures: `tests/fixtures/vault/Topics/Photosynthesis.md`, `Topics/Chlorophyll.md`, `Broken Frontmatter.md`, `Code Sample.md`, `Empty.md` (0 bytes), `Only Frontmatter.md`, `No Headings.md`, `CRLF Note.md` (written with `\r\n` by a `beforeAll`, since editors normalize), `Unicode Café ☕.md`
- Test: `tests/unit/parse.test.ts`, `tests/unit/links.test.ts`

**Interfaces:**
- Produces (`parse.ts`):
  - `type LinkKind = 'wikilink' | 'embed' | 'markdown'`
  - `interface RawLink { target: string; heading: string | null; alias: string | null; kind: LinkKind }`
  - `interface Heading { level: number; text: string; charStart: number; charEnd: number }` (offsets in the raw file string; `charEnd` = end of the heading line)
  - `interface ParsedNote { title: string; frontmatter: Record<string, unknown> | null; frontmatterError: string | null; bodyStart: number; tags: string[]; headings: Heading[]; links: RawLink[]; raw: string }`
  - `parseNote(raw: string, fileName: string): ParsedNote`
- Produces (`links.ts`): `resolveLink(link: RawLink, sourceRelPath: string, allRelPaths: string[]): string | null` (relative path of target note or null).

Rules: frontmatter only when the file starts with `---` followed by a line break, closed by a `---` line. Title: frontmatter `title` (string) → first H1 → file name without `.md`. Tags: frontmatter `tags` (string or list, leading `#` stripped) plus inline `#tag` (`#` preceded by start or whitespace, followed by letters/digits/`_`/`-`/`/`, at least one non-digit), unique, in order of first appearance. Heading lines and link syntax inside fenced code blocks (``` or ~~~) and inline code are ignored. Markdown links count only when the target ends in `.md` and has no URL scheme. Resolution: path relative to the vault root with `.md` added if missing → path relative to the source note's folder (for markdown links) → unique case-insensitive basename match → null.

- [ ] **Step 1: Write the failing tests** (selected assertions; read each fixture with `fs.readFileSync`)

```ts
test('frontmatter, title, tags', () => {
  const p = parseNote(read('Topics/Photosynthesis.md'), 'Photosynthesis.md');
  expect(p.frontmatter).toMatchObject({ type: 'concept', status: 'draft' });
  expect(p.title).toBe('Photosynthesis');
  expect(p.tags).toEqual(['science/biology', 'plants']);   // one frontmatter tag, one inline
});
test('broken YAML keeps the body', () => {
  const p = parseNote(read('Broken Frontmatter.md'), 'Broken Frontmatter.md');
  expect(p.frontmatter).toBeNull();
  expect(p.frontmatterError).toMatch(/./);
  expect(p.headings.length).toBeGreaterThan(0);
});
test('all link forms', () => {
  expect(parseNote('[[A]] [[B|bee]] [[C#Sec]] ![[d.png]] [e](sub/E.md) [web](https://x.org/a.md)', 'x.md').links).toEqual([
    { target: 'A', heading: null, alias: null, kind: 'wikilink' },
    { target: 'B', heading: null, alias: 'bee', kind: 'wikilink' },
    { target: 'C', heading: 'Sec', alias: null, kind: 'wikilink' },
    { target: 'd.png', heading: null, alias: null, kind: 'embed' },
    { target: 'sub/E.md', heading: null, alias: null, kind: 'markdown' },
  ]);
});
test('code fences hide headings and links', () => {
  const p = parseNote(read('Code Sample.md'), 'Code Sample.md');
  expect(p.headings.map(h => h.text)).toEqual(['Code Sample', 'After']);
  expect(p.links.map(l => l.target)).toEqual(['Photosynthesis']);
});
test('CRLF offsets slice the raw text exactly', () => {        // Review Focus 2
  const raw = read('CRLF Note.md'); const p = parseNote(raw, 'CRLF Note.md');
  for (const h of p.headings) expect(raw.slice(h.charStart, h.charEnd)).toBe('#'.repeat(h.level) + ' ' + h.text);
});
test('non-ASCII headings and title', () => {
  const p = parseNote(read('Unicode Café ☕.md'), 'Unicode Café ☕.md');
  expect(p.title).toBe('Unicode Café ☕');
  expect(p.headings[1].text).toBe('Résumé › détails');
});
test('empty file', () => expect(parseNote('', 'Empty.md')).toMatchObject({ title: 'Empty', headings: [], links: [], frontmatter: null }));

// links.test.ts
const all = ['Topics/Photosynthesis.md', 'Topics/Chlorophyll.md', 'Home.md', 'a/Same.md', 'b/Same.md'];
test('exact path', () => expect(resolveLink(wl('Topics/Chlorophyll'), 'Home.md', all)).toBe('Topics/Chlorophyll.md'));
test('basename, case-insensitive', () => expect(resolveLink(wl('photosynthesis'), 'Home.md', all)).toBe('Topics/Photosynthesis.md'));
test('ambiguous basename stays unresolved', () => expect(resolveLink(wl('Same'), 'Home.md', all)).toBeNull());
test('missing target stays unresolved', () => expect(resolveLink(wl('Medical Research'), 'Home.md', all)).toBeNull());
test('relative markdown link', () => expect(resolveLink(md('Chlorophyll.md'), 'Topics/Photosynthesis.md', all)).toBe('Topics/Chlorophyll.md'));
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- parse links` → FAIL.
- [ ] **Step 3: Implement `parseNote` and `resolveLink`.** Parse frontmatter with `yaml`'s `parse`. Walk lines tracking each line's start offset in `raw` (split with a regex that keeps `\r\n` lengths) and whether you are inside a fence.
- [ ] **Step 4: Run to verify they pass** — `npm test -- parse links` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: markdown parsing and link resolution"`

---

### Task 6: Chunker

**Files:**
- Create: `src/service/markdown/chunk.ts`
- Test: `tests/unit/chunk.test.ts`

**Interfaces:**
- Consumes: `ParsedNote`, `Heading` (Task 5).
- Produces: `interface ChunkOptions { minChars: number; maxChars: number }`, `DEFAULT_CHUNK_OPTIONS = { minChars: 300, maxChars: 2000 }`, `interface Chunk { ordinal: number; headingPath: string[]; text: string; charStart: number; charEnd: number; tokenEstimate: number }`, `chunkNote(note: ParsedNote, opts?: ChunkOptions): Chunk[]`, `embeddingText(title: string, chunk: Chunk): string`.

Rules:
- A section runs from a heading line to the next heading of any level (the preamble before the first heading is a section with `headingPath: []`). `headingPath` is the chain of enclosing headings including its own (`['HbA1c (A1C)', 'Limitations']`). Text starts after the frontmatter.
- `text = raw.slice(charStart, charEnd).trim()` with offsets adjusted to the trimmed text. Sections whose text is empty or only a heading line with nothing under it are dropped, except when the note has no other chunk (then keep a single chunk if non-empty).
- A section shorter than `minChars` merges with the next section if that one has the same parent path (`headingPath.slice(0, -1)`); the merged chunk keeps the first section's `headingPath`. Merging repeats while the result is still short. No next sibling → it stays alone.
- A section longer than `maxChars` splits at blank lines that are outside code fences. Pieces fill up to `maxChars`; each piece after the first starts with the last paragraph of the previous one. A single paragraph longer than `maxChars` becomes its own piece, unsplit.
- `tokenEstimate = Math.ceil(text.length / 4)`. `ordinal` counts from 0.
- `embeddingText` = `'search_document: ' + [title, ...headingPath].join(' › ') + '\n\n' + text`. If `headingPath[0] === title`, don't repeat it.

- [ ] **Step 1: Write the failing test**

```ts
const P = (md: string) => parseNote(md, 'T.md');
test('one chunk per section, with heading path', () => {
  const md = `# T\n\n## A\n${'a'.repeat(400)}\n\n## B\n${'b'.repeat(400)}\n`;
  expect(chunkNote(P(md)).map(c => c.headingPath)).toEqual([['T', 'A'], ['T', 'B']]);
});
test('offsets slice the source', () => {
  const n = P(read('CRLF Note.md'));
  for (const c of chunkNote(n)) expect(n.raw.slice(c.charStart, c.charEnd)).toBe(c.text);
});
test('short sibling sections merge forward', () => {
  const md = `# T\n## A\nshort a\n## B\nshort b\n## C\n${'c'.repeat(400)}\n`;
  const cs = chunkNote(P(md));
  expect(cs).toHaveLength(1); expect(cs[0].headingPath).toEqual(['T', 'A']); expect(cs[0].text).toContain('## C');
});
test('short section does not merge across parents', () => {
  const md = `# T\n## A\n### A1\nshort\n## B\n${'b'.repeat(400)}\n`;
  expect(chunkNote(P(md)).map(c => c.headingPath)).toEqual([['T', 'A', 'A1'], ['T', 'B']]);
});
test('long section splits on paragraphs with one-paragraph overlap', () => {
  const paras = Array.from({ length: 6 }, (_, i) => String(i).repeat(600));
  const cs = chunkNote(P(`# T\n${paras.join('\n\n')}\n`));
  expect(cs.length).toBeGreaterThan(1);
  for (const c of cs) expect(c.text.length).toBeLessThanOrEqual(2000 + 50);
  expect(cs[1].text.startsWith(cs[0].text.split('\n\n').at(-1)!)).toBe(true);
});
test('never splits inside a code fence', () => {
  const fence = '```\n' + Array.from({ length: 40 }, () => 'x'.repeat(60)).join('\n\n') + '\n```';
  expect(chunkNote(P(`# T\n${fence}\n`)).some(c => c.text.includes(fence))).toBe(true);
});
test('empty, frontmatter-only, no-heading notes', () => {               // Review Focus 5
  expect(chunkNote(P(''))).toEqual([]);
  expect(chunkNote(P('---\ntitle: x\n---\n'))).toEqual([]);
  const cs = chunkNote(P('just a line'));
  expect(cs).toHaveLength(1); expect(cs[0].headingPath).toEqual([]);
  for (const c of cs) expect(c.text.trim()).not.toBe('');
});
test('embeddingText header', () => {
  expect(embeddingText('HbA1c (A1C)', { headingPath: ['HbA1c (A1C)', 'Limitations'], text: 'x' } as Chunk))
    .toBe('search_document: HbA1c (A1C) › Limitations\n\nx');
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- chunk` → FAIL.
- [ ] **Step 3: Implement `chunkNote` and `embeddingText`.**
- [ ] **Step 4: Run to verify it passes** — `npm test -- chunk` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: structure-aware chunker"`

---

### Task 7: Workspaces, notes, scan diff and sync

**Files:**
- Create: `src/service/db/workspaces.ts`, `src/service/db/notes.ts`, `src/service/db/jobs.ts`, `src/service/db/settings.ts`, `src/service/vault/scan.ts`, `src/service/vault/sync.ts`
- Test: `tests/unit/diff.test.ts`, `tests/unit/sync.test.ts`, `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `VaultGuard` (Task 4), `migrate`/`openDatabase` (Task 3).
- Produces:
  - `workspaces.ts`: `createWorkspace(db, input: { name: string; vaultRoot: string }): Workspace` (default `ignore_patterns` = `DEFAULT_IGNORES`, default `answer_guidelines` = `HEALTH_GUIDELINES` when `name === 'Health'`, else `''`); `getActiveWorkspace(db): Workspace | null`; `setActiveWorkspace(db, id: number): void` (stored in settings key `activeWorkspaceId`); `updateWorkspace(db, id, patch: { answerGuidelines?: string; ignorePatterns?: string[] }): Workspace`.
  - `HEALTH_GUIDELINES` (exact copy): `"Keep general medical research separate from documented personal health records, and say which one each statement comes from. Never diagnose. For questions about the user's individual health, recommend review by a healthcare professional."`
  - `settings.ts`: `DEFAULT_SETTINGS: Settings` (`ollamaEndpoint 'http://127.0.0.1:11434'`, `chatModel 'qwen2.5:3b'`, `embeddingModel 'nomic-embed-text'`, `temperature 0.2`, `maxDistance 0.55`); `getSettings(db): Settings`; `updateSettings(db, patch: Partial<Settings>): Settings`.
  - `scan.ts`: `interface FileStat { relPath: string; mtimeMs: number; size: number }`; `scanVault(guard: VaultGuard): Promise<FileStat[]>` (only `.md` files, POSIX `relPath`, skips ignored paths and symlinks that `guard.resolve` refuses; throws `VAULT_NOT_FOUND` if the root is missing or unreadable); `hashFile(absPath: string): Promise<string>` (SHA-256 hex).
  - `scan.ts`: `interface KnownNote { id: string; relPath: string; mtimeMs: number; size: number; hash: string; status: string }`; `interface ScanDiff { added: (FileStat & { hash })[]; changed: (FileStat & { hash; noteId })[]; renamed: { noteId; from: string; to: FileStat & { hash } }[]; touched: { noteId; mtimeMs; size }[]; deleted: { noteId }[]; excluded: { noteId }[] }`; `diffScan(known: KnownNote[], found: FileStat[], hashOf: (relPath: string) => Promise<string>, isIgnored: (relPath: string) => boolean): Promise<ScanDiff>`. Notes already `deleted`/`excluded` that reappear count as `changed` (they need indexing).
  - `jobs.ts`: `enqueueIndex(db, noteId: string): void` (no-op when a `queued` job for the note exists; a `running` one does not block a new `queued` one); `claimNextJob(db): Job | null`; `finishJob(db, id, outcome: { status: 'done' } | { status: 'failed'; error: string; countAttempt: boolean } | { status: 'queued'; countAttempt: boolean }): void`; `requeueRunning(db): number`; `jobCounts(db, workspaceId): { queued; running; done; failed }`.
  - `notes.ts`: `knownNotes(db, workspaceId): KnownNote[]`; `applyScanDiff(db, workspaceId, diff: ScanDiff): void` (one transaction; enqueues added and changed; `deleted`/`excluded` delete chunks, vectors and links and set status); `listNotes(db, workspaceId, filter: LibraryFilter): NoteSummary[]`; `getNote(db, noteId): NoteRow | null`; `deleteNoteIndex(db, noteId): void` (chunks and links now; Task 8 adds a `deleteVectors` call for the note's chunk ids, made before the chunks are deleted).
  - `sync.ts`: `syncVault(ctx: { db; guard; workspaceId }): Promise<{ added; changed; renamed; deleted; excluded }>` = scan → diff → apply.

- [ ] **Step 1: Write the failing tests**

```ts
// diff.test.ts — pure, no disk
const k = (id, relPath, hash, extra = {}) => ({ id, relPath, mtimeMs: 1, size: 10, hash, status: 'indexed', ...extra });
test('unchanged mtime/size never hashes', async () => {
  const hashOf = vi.fn();
  await diffScan([k('n1', 'a.md', 'h')], [{ relPath: 'a.md', mtimeMs: 1, size: 10 }], hashOf, () => false);
  expect(hashOf).not.toHaveBeenCalled();
});
test('same hash after touch is touched, not changed', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [{ relPath: 'a.md', mtimeMs: 2, size: 10 }], async () => 'h', () => false);
  expect(d.touched).toEqual([{ noteId: 'n1', mtimeMs: 2, size: 10 }]); expect(d.changed).toEqual([]);
});
test('rename keeps the note id', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [{ relPath: 'b.md', mtimeMs: 1, size: 10 }], async () => 'h', () => false);
  expect(d.renamed).toEqual([expect.objectContaining({ noteId: 'n1', from: 'a.md' })]);
  expect(d.added).toEqual([]); expect(d.deleted).toEqual([]);
});
test('newly ignored is excluded, not deleted', async () => {
  const d = await diffScan([k('n1', 'reports/a.md', 'h')], [], async () => 'h', p => p.startsWith('reports/'));
  expect(d.excluded).toEqual([{ noteId: 'n1' }]); expect(d.deleted).toEqual([]);
});

// sync.test.ts — temp copy of the fixture vault, :memory: db
test('first sync adds and queues every non-ignored note', async () => { /* added === number of .md fixtures outside .obsidian; jobCounts.queued equal */ });
test('missing vault root changes nothing', async () => {           // Review Focus 1
  await syncVault(ctx); await fs.rm(tmpVault, { recursive: true });
  await expect(syncVault(ctx)).rejects.toMatchObject({ code: 'VAULT_NOT_FOUND' });
  expect(knownNotes(db, wsId).every(n => n.status !== 'deleted')).toBe(true);
});
test('deleted file marks the note deleted and removes its chunks', async () => { /* insert a chunk row by hand, delete file, sync → status deleted, 0 chunks */ });
test('re-queue does not duplicate a queued job', () => { /* enqueueIndex twice → 1 queued */ });
test('a running job allows one new queued job', () => { /* claim, enqueue, enqueue → running 1, queued 1 */ });

// settings.test.ts
test('defaults then update', () => { /* getSettings === DEFAULT_SETTINGS; update temperature 0.5; reopen db file → 0.5 */ });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- diff sync settings` → FAIL.
- [ ] **Step 3: Implement the modules.** `scanVault` uses `fs.readdir(root, { recursive: true, withFileTypes: true })` and `fs.stat` per `.md` file. Check the root with `fs.stat` first so a missing root throws before anything else runs.
- [ ] **Step 4: Run to verify they pass** — `npm test -- diff sync settings` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: vault scan, diff and sync"`

---

### Task 8: Model providers and vector storage

**Files:**
- Create: `src/service/providers/types.ts`, `src/service/providers/ollama.ts`, `src/service/providers/fake.ts`, `src/service/db/vectors.ts`
- Modify: `src/service/db/notes.ts` (`deleteNoteIndex` calls `deleteVectors`)
- Test: `tests/unit/ollama.test.ts`, `tests/unit/vectors.test.ts`, `tests/integration/ollama.real.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }`
  - `interface EmbeddingProvider { embed(texts: string[], opts: { model: string; signal?: AbortSignal }): Promise<number[][]> }`
  - `interface ChatProvider { chat(req: { model: string; messages: ChatMessage[]; temperature: number; numCtx: number; signal?: AbortSignal }): AsyncIterable<string> }`
  - `interface ModelCatalog { listModels(): Promise<ModelInfo[]> }` with `ModelInfo = { name: string; digest: string; capabilities: string[] }`
- Produces (`ollama.ts`): `class OllamaProvider implements EmbeddingProvider, ChatProvider, ModelCatalog` with `constructor(opts: { endpoint: string; timeouts?: { embedMs: number; firstTokenMs: number; idleMs: number } })` (defaults 60000, 180000, 60000). Endpoints: `POST /api/embed` `{ model, input }` → `embeddings`; `POST /api/chat` `{ model, messages, stream: true, options: { temperature, num_ctx } }` (NDJSON, `message.content` per line, `done: true` ends); `GET /api/tags` + `POST /api/show { model }` → `capabilities`. Error mapping: connection refused/DNS → `OLLAMA_UNREACHABLE` (hint `Start Ollama with: ollama serve`); HTTP 404 or body containing `not found` → `MODEL_NOT_FOUND` (hint `ollama pull <model>`); timer expiry → `TIMEOUT`; caller abort → `CANCELLED`.
- Produces (`fake.ts`): `class FakeEmbeddingProvider implements EmbeddingProvider, ModelCatalog` (`constructor(dim = 64)`; lowercase word tokens hashed into `dim` buckets, counted, L2-normalized; the `search_document: `/`search_query: ` prefix and header line are stripped before hashing so documents and queries share a space; `listModels` returns `[{ name: 'fake-embed', digest: 'fake', capabilities: ['embedding'] }]`). `class FakeChatProvider implements ChatProvider` (`constructor(reply: string | ((messages: ChatMessage[]) => string), opts?: { chunkSize?: number; delayMs?: number })`, yields the reply in pieces, honours `signal`).
- Produces (`vectors.ts`): `upsertEmbeddingModel(db, m: { provider: string; name: string; dimensions: number; digest: string }): EmbeddingModelRow` (`{ id, provider, name, dimensions, digest, table }`); `ensureVectorTable(db, m: EmbeddingModelRow): void` (`CREATE VIRTUAL TABLE IF NOT EXISTS <table> USING vec0(chunk_id integer primary key, workspace_id integer partition key, embedding float[<dim>] distance_metric=cosine)`; table name `vec_` + model name with non-alphanumerics → `_` + `_` + dim); `insertVectors(db, m, rows: { chunkId: number; workspaceId: number; vector: number[] }[]): void`; `deleteVectors(db, chunkIds: number[]): void` (from every vector table); `knn(db, m, workspaceId: number, query: number[], k: number): { chunkId: number; distance: number }[]`.

Gotcha to know: better-sqlite3 binds JS numbers as REAL, but vec0 needs integer keys. Pass `BigInt(chunkId)` and `BigInt(workspaceId)`, and vectors as `new Float32Array(vector)`.

- [ ] **Step 1: Write the failing tests**

```ts
// ollama.test.ts — a node:http server on port 0 plays Ollama
test('embed returns vectors', async () => { /* server replies {embeddings:[[1,0],[0,1]]} → embed(['a','b']) equals that */ });
test('unreachable endpoint', async () =>
  expect(new OllamaProvider({ endpoint: 'http://127.0.0.1:9' }).embed(['a'], { model: 'm' })).rejects.toMatchObject({ code: 'OLLAMA_UNREACHABLE' }));
test('missing model', async () => { /* 404 {"error":"model \"m\" not found"} → MODEL_NOT_FOUND, hint 'ollama pull m' */ });
test('chat streams NDJSON deltas', async () => { /* three lines + done → collected ['He','llo','!'] */ });
test('first-token timeout', async () => { /* server never writes; timeouts.firstTokenMs 50 → TIMEOUT */ });
test('abort cancels', async () => { /* abort after first delta → CANCELLED */ });
test('listModels merges capabilities', async () => { /* tags [{name:'a',digest:'d'}], show → {capabilities:['completion','vision']} */ });

// vectors.test.ts
test('knn is restricted to the workspace and ordered by distance', () => {
  // two workspaces, three vectors, query → only ws1 ids, nearest first, distance in [0, 2]
});
test('deleteVectors removes rows', () => { /* ... */ });
test('fake embeddings: shared words are closer than unrelated ones', async () => {
  const f = new FakeEmbeddingProvider();
  const [a, b, c] = await f.embed(['search_document: chlorophyll absorbs light', 'search_query: what absorbs light', 'search_document: tax law'], { model: 'fake' });
  expect(cos(a, b)).toBeGreaterThan(cos(a, c));
});

// ollama.real.test.ts — only when OLLAMA_IT=1 (test.skipIf(!process.env.OLLAMA_IT))
test('nomic-embed-text returns 768 dims', async () => { /* ... */ });
test('qwen2.5:3b streams at least one delta', async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- ollama vectors` → FAIL.
- [ ] **Step 3: Implement.** Use the global `fetch`. A connection-refused `fetch` rejects with a `TypeError` whose `cause.code` is `ECONNREFUSED`. Chat timeouts: a timer reset on every chunk read from `response.body`.
- [ ] **Step 4: Run to verify they pass** — `npm test -- ollama vectors` → PASS. With Ollama running and both models pulled: `OLLAMA_IT=1 npm test -- ollama.real` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: Ollama and fake providers, sqlite-vec storage"`

---

### Task 9: Indexer and job queue

**Files:**
- Create: `src/service/index/indexer.ts`, `src/service/index/model-state.ts`
- Test: `tests/unit/indexer.test.ts`, `tests/unit/model-state.test.ts`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces (`model-state.ts`): `getIndexModelState(db, workspaceId: number, current: EmbeddingModelRow): { status: 'ok' | 'empty' | 'mismatch'; indexedWith: string | null }` (mismatch when any `indexed` note has an `embedding_model_id` different from `current.id`; `indexedWith` = that model's name).
- Produces (`indexer.ts`): `createIndexer(deps: { db; workspace: Workspace; guard: VaultGuard; embedder: EmbeddingProvider; catalog: ModelCatalog; getSettings: () => Settings; emit: (p: IndexProgress) => void; sleep?: (ms: number) => Promise<void> }): Indexer` where `Indexer = { kick(): void; cancel(): void; retry(noteId?: string): void; reembedAll(): void; progress(): IndexProgress; idle(): Promise<void>; stop(): Promise<void> }`. `idle()` resolves when the queue is empty or paused (used by tests).

Behavior (from spec §5, values pinned):
- On create: `requeueRunning`, then resolve the current embedding model through `catalog.listModels()` (name = settings `embeddingModel`; missing → pause with failed-job error `MODEL_NOT_FOUND` on the next job), `upsertEmbeddingModel`, `ensureVectorTable`. Dimension comes from the first embed response and is stored on the model row.
- If `getIndexModelState` is `mismatch` → `paused: 'model-mismatch'`, no jobs run until `reembedAll()` (which deletes all vectors and chunks of the workspace and re-queues every `indexed` note).
- One job at a time: claim → `guard.resolve` → read file → `parseNote` → `chunkNote` → embed `embeddingText` in batches of 16 → check every vector's length equals the model's dimensions (`DIMENSION_MISMATCH`) → one transaction: `deleteNoteIndex`, insert chunks, vectors, resolved links, update note (`title`, `frontmatter`, `tags`, `content_hash` of the content just read, `index_status 'indexed'`, `error` = frontmatter error or null, `last_indexed_at`, `embedding_model_id`) → `finishJob done`.
- `OLLAMA_UNREACHABLE`: `finishJob queued, countAttempt false`, `paused: 'ollama-unreachable'`, poll `catalog.listModels()` every 5000 ms until it succeeds, then resume.
- `MODEL_NOT_FOUND`: `failed`, `countAttempt false`, error message includes the pull hint.
- Any other error: retry with waits `[2000, 8000, 30000]`; the 4th failure → `failed` (note `index_status 'failed'`, `error` = message).
- `cancel()`: finish the current note, then stop with `paused: 'cancelled'`; `kick()` resumes.
- `emit` after every state change.

- [ ] **Step 1: Write the failing tests** (fixture vault copy, `:memory:` db, `FakeEmbeddingProvider`, `sleep: async () => {}`)

```ts
test('indexes the fixture vault', async () => {
  await syncVault(ctx); ix.kick(); await ix.idle();
  expect(jobCounts(db, ws.id)).toMatchObject({ queued: 0, failed: 0 });
  expect(count('chunks')).toBeGreaterThan(0);
  expect(statusOf('Empty.md')).toBe('indexed');                 // Review Focus 5
  expect(statusOf('Broken Frontmatter.md')).toBe('indexed');
  expect(errorOf('Broken Frontmatter.md')).toMatch(/frontmatter/);
});
test('reindexing a changed note does not duplicate chunks', async () => { /* index, append a section, sync+kick+idle → chunk count for that note = fresh chunkNote length; vector rows = chunk rows */ });
test('edit during indexing is picked up', async () => {          // Review Focus 3
  // embedder whose first embed() call rewrites the file and calls syncVault before returning;
  // after idle(): stored content_hash === hashFile(current file), chunks contain the new text
});
test('unreachable Ollama pauses without failing jobs', async () => { /* embedder throws OLLAMA_UNREACHABLE → progress.paused 'ollama-unreachable', failed 0 */ });
test('missing model fails without consuming retries', async () => { /* attempts stays 0, status failed, error contains 'ollama pull' */ });
test('other errors retry 3 times then fail', async () => { /* embedder always throws INTERNAL → sleep called with 2000, 8000, 30000; status failed */ });
test('dimension mismatch fails the note', async () => { /* embedder returns wrong length on second batch */ });
test('restart requeues running jobs', () => { /* mark a job running by hand, create indexer → it is processed */ });

// model-state.test.ts
test('mismatch after switching models', () => { /* index with model A, current B → { status: 'mismatch', indexedWith: 'A' } */ });
test('reembedAll clears mismatch', async () => { /* ... → status 'ok' after idle */ });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- indexer model-state` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass** — `npm test -- indexer model-state` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: indexing queue with retries, pause and model tracking"`

---

### Task 10: Retrieval

**Files:**
- Create: `src/service/rag/retrieve.ts`
- Test: `tests/unit/retrieve.test.ts`

**Interfaces:**
- Consumes: `knn`, `EmbeddingModelRow` (Task 8), `getIndexModelState` (Task 9).
- Produces: `interface RetrievalOptions { k: number; maxDistance: number; perNoteCap: number; charBudget: number; maxChunks: number }`, `DEFAULT_RETRIEVAL = { k: 20, maxDistance: 0.55, perNoteCap: 2, charBudget: 6000, maxChunks: 6 }`, `interface RetrievedChunk { chunkId: number; noteId: string; noteTitle: string; relPath: string; headingPath: string[]; text: string; distance: number; meta: { type?: string; source_type?: string; status?: string } }`, `retrieve(deps: { db; embedder: EmbeddingProvider; model: EmbeddingModelRow; workspaceId: number }, question: string, opts?: Partial<RetrievalOptions>): Promise<RetrievedChunk[]>`.

Rules: throws `EMBEDDING_MODEL_MISMATCH` (message `Index built with A, current model is B`) when model state is `mismatch`. Embeds `'search_query: ' + question`. Keeps distance ≤ `maxDistance`, at most `perNoteCap` per note, in distance order. Budget: always take the first result; stop at the first one that would exceed `charBudget`; stop at `maxChunks`. `meta` copies only string values of those three frontmatter keys.

- [ ] **Step 1: Write the failing test** (index the fixture vault with the fake embedder first)

```ts
test('finds the right note and section', async () => {
  const r = await retrieve(deps, 'What does chlorophyll absorb?');
  expect(r[0].relPath).toBe('Topics/Chlorophyll.md');
  expect(r[0].headingPath.at(-1)).toBe('Absorption');
});
test('cutoff removes weak matches', async () => expect(await retrieve(deps, 'quarterly tax filing deadlines')).toEqual([]));
test('per-note cap', async () => { /* question matching many sections of one note → ≤ 2 from that note */ });
test('budget and max chunks', async () => { /* charBudget 10 → exactly 1 result; maxChunks 1 → 1 */ });
test('other workspaces are invisible', async () => { /* second workspace indexed with the same text → no its noteIds */ });
test('model mismatch refuses', async () => expect(retrieve({ ...deps, model: otherModel }, 'x')).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_MISMATCH' }));
```

Write `Topics/Chlorophyll.md` so it has an `## Absorption` section about red and blue light, and nothing in the fixtures mentions taxes.

- [ ] **Step 2: Run to verify it fails** — `npm test -- retrieve` → FAIL.
- [ ] **Step 3: Implement `retrieve`.** One `knn` call, then a single `SELECT … WHERE chunks.id IN (…)` joined to notes.
- [ ] **Step 4: Run to verify it passes** — `npm test -- retrieve` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: semantic retrieval with cutoff, cap and budget"`

---

### Task 11: Prompt and citations

**Files:**
- Create: `src/service/rag/prompt.ts`, `src/service/rag/citations.ts`
- Test: `tests/unit/prompt.test.ts`, `tests/unit/citations.test.ts`

**Interfaces:**
- Consumes: `RetrievedChunk` (Task 10), `ChatMessage` (Task 8).
- Produces: `buildRagMessages(input: { question: string; sources: RetrievedChunk[]; history: ChatMessage[]; guidelines: string }): ChatMessage[]`; `buildGeneralMessages(input: { question: string; history: ChatMessage[] }): ChatMessage[]`; `sourceHeader(n: number, s: RetrievedChunk): string`; `parseCitations(answer: string, sourceCount: number): { cited: number[]; unknown: string[] }`; `trimHistory(history: ChatMessage[], maxMessages = 6, maxChars = 4000): ChatMessage[]` (keeps the newest).

RAG system prompt (exact copy, then sources, then guidelines if non-empty):

```
You answer questions using only the numbered sources below, taken from the user's notes.
- Cite every statement with its source number in square brackets, like [S1] or [S1][S3].
- If the sources do not contain the answer, say so plainly. Do not fill gaps with general knowledge.
- If sources disagree, say that they disagree and cite each one.
- Never present general knowledge as if it came from the user's notes.

Sources:
```

Each source: `sourceHeader` = `[S<n>] <title> › <headingPath joined with ' › '> (<type> · <source_type> · <status>)`, parenthesis omitted when all three are missing, title not repeated when it equals `headingPath[0]`. Then a blank line, the chunk text, a blank line.
General system prompt (exact copy): `Answer from your general knowledge. You have no access to the user's notes in this mode.`
Message order: system, trimmed history, user question.

`parseCitations`: matches `[S1]`, `[s1]`, `[S1, S2]`, `[S1,S3]` (case-insensitive). `cited` = unique valid numbers in order of first appearance; `unknown` = markers outside `1..sourceCount`, as written (`'S9'`).

- [ ] **Step 1: Write the failing tests**

```ts
test('parses marker forms', () => expect(parseCitations('A [S1]. B [s2, S1]. C [S9].', 3)).toEqual({ cited: [1, 2], unknown: ['S9'] }));
test('no markers', () => expect(parseCitations('plain answer', 2)).toEqual({ cited: [], unknown: [] }));
test('ignores look-alikes', () => expect(parseCitations('[Section 1] and S1 alone', 2).cited).toEqual([]));
test('source header', () => expect(sourceHeader(1, src({ noteTitle: 'HbA1c (A1C)', headingPath: ['HbA1c (A1C)', 'Limitations'], meta: { type: 'biomarker', status: 'partially-verified' } })))
  .toBe('[S1] HbA1c (A1C) › Limitations (biomarker · partially-verified)'));
test('rag messages: system, history, question; guidelines appended', () => {
  const m = buildRagMessages({ question: 'q', sources: [src()], history: [{ role: 'user', content: 'h' }], guidelines: 'Never diagnose.' });
  expect(m.map(x => x.role)).toEqual(['system', 'user', 'user']);
  expect(m[0].content).toContain('[S1]'); expect(m[0].content.trimEnd().endsWith('Never diagnose.')).toBe(true);
});
test('trimHistory keeps the newest 6', () => { /* 10 messages → last 6 */ });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- prompt citations` → FAIL.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run to verify they pass** — `npm test -- prompt citations` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: grounded prompt assembly and citation parsing"`

---

### Task 12: Conversation service

**Files:**
- Create: `src/service/db/conversations.ts`, `src/service/chat/chat-service.ts`
- Test: `tests/unit/chat-service.test.ts`

**Interfaces:**
- Consumes: Tasks 8, 10, 11.
- Produces (`conversations.ts`): `createConversation(db, workspaceId, title): string`; `addMessage(db, m: { conversationId; role; content; mode; model; status }): string`; `updateMessage(db, id, patch: { content?; status? }): void`; `saveCitations(db, messageId, rows: { marker: string; chunk: RetrievedChunk; rank: number; cited: boolean }[]): void` (score stored as `1 - distance`; snapshots from the chunk); `listConversations(db, workspaceId): ConversationSummary[]` (newest `updated_at` first); `getConversation(db, id): ConversationDetail` (messages with citations; each `MessageView` also carries `unknownMarkers` computed with `parseCitations`); `renameConversation`, `deleteConversation`, `deleteAllConversations(db, workspaceId)`.
- Produces (`chat-service.ts`): `createChatService(deps: { db; workspace: () => Workspace; chat: ChatProvider; embedder: EmbeddingProvider; model: () => EmbeddingModelRow; getSettings: () => Settings; emit: (event: 'chat:delta' | 'chat:done', payload: unknown) => void }): ChatService` with `send(input: { conversationId: string | null; text: string; mode: 'rag' | 'general' }): Promise<{ conversationId; assistantMessageId; requestId }>` (returns as soon as both messages exist; generation continues in the background) and `cancel(requestId: string): void`, plus the list/get/rename/delete wrappers.

Behavior:
- New conversation title = first 60 characters of the question (trimmed; `…` appended when cut).
- RAG mode: `retrieve` with `maxDistance` from settings. Zero results → assistant message content `No notes in *<workspace name>* matched this question.`, status `no_match`, no model call; emit `chat:done`.
- History = previous messages in the conversation with status `complete`, through `trimHistory`.
- Stream: each delta → `chat:delta { requestId, text }`; content saved to the database at most every 500 ms and at the end.
- End: status `complete`; RAG mode → `saveCitations` for every retrieved source (`marker 'S<n>'`, `cited` from `parseCitations`); emit `chat:done { requestId, messageId, status }`.
- Cancel → status `cancelled` with the partial content. Provider error → status `error`, content = partial text, error code and message stored in `content` only as `\n\n[error: <code>]` suffix; emit `chat:done` with `error: AppError`.
- Conversation `updated_at` set on every new message.

- [ ] **Step 1: Write the failing tests** (indexed fixture vault, fake providers)

```ts
test('rag answer is saved with cited and uncited sources', async () => {
  const chat = new FakeChatProvider('Red and blue light [S1].');
  const { conversationId } = await svc(chat).send({ conversationId: null, text: 'What does chlorophyll absorb?', mode: 'rag' });
  await doneEvent();
  const c = getConversation(db, conversationId);
  expect(c.title).toBe('What does chlorophyll absorb?');
  const a = c.messages[1];
  expect(a.status).toBe('complete');
  expect(a.citations.find(x => x.marker === 'S1')).toMatchObject({ cited: true, noteRelPath: 'Topics/Chlorophyll.md' });
});
test('no match skips the model', async () => {
  const chat = { chat: vi.fn() };
  await svc(chat).send({ conversationId: null, text: 'quarterly tax filing deadlines', mode: 'rag' }); await doneEvent();
  expect(chat.chat).not.toHaveBeenCalled();
  expect(lastMessage().status).toBe('no_match');
});
test('general mode skips retrieval', async () => { /* embedder.embed spy not called; messages[0].content of the chat request has no '[S1]' */ });
test('cancel keeps the partial answer', async () => { /* FakeChatProvider delayMs 20; cancel after first delta → status cancelled, content non-empty */ });
test('provider error is stored and reported', async () => { /* chat throws OLLAMA_UNREACHABLE → status error, chat:done carries error.code */ });
test('conversations survive reopening the database file', async () => { /* temp file db: send, close, openDatabase again → listConversations has it */ });
test('citation snapshot survives note deletion', async () => { /* after answer, delete the note file + sync → citation snapshot_text unchanged, chunk_id null */ });
test('long titles are cut at 60 chars', async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- chat-service` → FAIL.
- [ ] **Step 3: Implement both files.** Keep an `AbortController` per `requestId` in a `Map`.
- [ ] **Step 4: Run to verify it passes** — `npm test -- chat-service` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: persistent conversations with streaming and citations"`

---

### Task 13: Knowledge service process and router

**Files:**
- Create: `src/service/router.ts`, `src/service/handlers.ts`, `src/service/vault/watch.ts`, `src/service/home.ts`
- Modify: `src/service/service.ts`
- Test: `tests/unit/router.test.ts`, `tests/unit/handlers.test.ts`, `tests/unit/watch.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `router.ts`: `createRouter(handlers: Record<string, (input: unknown) => Promise<unknown>>, opts: { publicOnly: boolean }): (method: string, input: unknown) => Promise<Result<unknown>>` — validates with `parseInput` for public methods, catches and converts with `toAppError`, logs `{ method, code, ms }` only.
  - `handlers.ts`: `createHandlers(ctx: ServiceContext)` returning a handler for every public method that the service owns (all except `vault.choose`, `note.openInObsidian`, `data.revealDb`) plus internal methods `vault.set({ path: string })` and `note.resolvePath({ noteId }) → string` (through the guard). `ServiceContext` holds `db`, current workspace, guard, indexer, chat service, Ollama provider, `emit`. `vault.set` validates the path is a readable directory, creates or reuses the workspace for that root (name `Health` when the folder name contains `Health`, else the folder name), makes it active, rebuilds guard/indexer/watcher, runs `syncVault` and `kick`. `settings.update` rebuilds the Ollama provider when the endpoint changes and re-resolves the model when `embeddingModel` changes. `data.rebuildIndex` deletes every chunk, vector, link and job of the workspace, marks notes `pending`, then sync + kick. Every handler that needs a workspace throws `NO_VAULT` when there is none. `library.list`/`note.read` set `index_status` from the db; `note.read` reads the file through the guard.
  - `home.ts`: `homeSummary(db, workspace): HomeSummary` (`{ workspace, counts: { indexed, pending, failed, total }, recentNotes: NoteSummary[5], recentConversations: ConversationSummary[5] }`).
  - `watch.ts`: `watchVault(root: string, onChange: () => void, debounceMs = 500): () => void` (recursive `fs.watch`; events in ignored folders are fine to forward, since sync filters them).
  - `service.ts` protocol over `process.parentPort`: in `{ type: 'init', dbPath }`; in `{ type: 'call', id, method, input }` → out `{ type: 'result', id, result: Result }`; out `{ type: 'event', event, payload }`; out `{ type: 'ready' }` after init. On init: open db, migrate, load active workspace, start indexer and watcher, initial sync.

Note on the watcher: per spec the affected paths are rescanned; this plan runs the full stat-only `syncVault` on each debounced event instead (`// ponytail: full stat rescan per watch burst; scan only the changed paths when vaults reach tens of thousands of files`). The result is identical; hashing still happens only for files whose mtime/size changed.

- [ ] **Step 1: Write the failing tests**

```ts
test('router validates before calling the handler', async () => {
  const h = vi.fn();
  expect(await createRouter({ 'note.read': h }, { publicOnly: true })('note.read', { noteId: 1 }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  expect(h).not.toHaveBeenCalled();
});
test('router refuses internal methods on the public path', async () =>
  expect(await createRouter({ 'vault.set': vi.fn() }, { publicOnly: true })('vault.set', { path: '/' }))
    .toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } }));
test('handler errors become AppError results', async () => { /* handler throws AppException NOT_FOUND → { ok:false, error:{ code:'NOT_FOUND' } } */ });
test('calls without a vault return NO_VAULT', async () => { /* fresh ctx, library.list → NO_VAULT */ });
test('vault.set → library.list → note.read round trip', async () => { /* fixture vault, fake providers */ });
test('note.resolvePath refuses an id from another workspace', async () => { /* → NOT_FOUND */ });
test('watcher fires once per burst', async () => { /* write 5 files in a temp dir within 100 ms → onChange called once after ~500 ms */ });
```

- [ ] **Step 2: Run to verify they fail** — `npm test -- router handlers watch` → FAIL.
- [ ] **Step 3: Implement.** `createHandlers` takes provider constructors through `ctx` so tests pass fakes.
- [ ] **Step 4: Run to verify they pass** — `npm test -- router handlers watch` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: knowledge service process with validated router"`

---

### Task 14: Main process wiring and preload

**Files:**
- Create: `src/main/service-host.ts`, `src/main/ipc.ts`, `src/main/obsidian.ts`
- Modify: `src/main/main.ts`, `src/preload/preload.ts`
- Test: `tests/unit/obsidian.test.ts`

**Interfaces:**
- Consumes: service protocol (Task 13), `PUBLIC_METHODS`/`EVENTS` (Task 2), `hardenWindow` (Task 1).
- Produces:
  - `service-host.ts`: `startServiceHost(opts: { dbPath: string; onEvent: (event: string, payload: unknown) => void }): ServiceHost` with `call(method: string, input: unknown): Promise<Result<unknown>>` and `dispose(): void`. Forks with `utilityProcess.fork(path.join(__dirname, 'service.cjs'))`. On unexpected exit: emit `service:status { state: 'reconnecting' }`, restart after 1000 ms, fail calls in flight with `INTERNAL` "Service restarted", emit `service:status { state: 'ready' }` on `ready`.
  - `obsidian.ts`: `obsidianUri(absPath: string): string` = `'obsidian://open?path=' + encodeURIComponent(absPath)`.
  - `ipc.ts`: `registerIpc(host: ServiceHost, win: BrowserWindow): void`. One `ipcMain.handle('api', (e, method, input))`: reject unless `e.senderFrame` belongs to `win`'s web contents and the URL is the app origin. Main-owned methods: `vault.choose` (`dialog.showOpenDialog({ properties: ['openDirectory'] })`, count `.md` files with the same skip rules as `scanVault`, remember the path in a module variable, return `VaultPreview`), `vault.confirm` (call internal `vault.set` with the remembered path; `INVALID_INPUT` if none), `note.openInObsidian` (internal `note.resolvePath`, then `shell.openExternal(obsidianUri(path))`), `data.revealDb` (`shell.showItemInFolder(dbPath)`). Everything else in `PUBLIC_METHODS` is forwarded to the host; anything else → `UNKNOWN_METHOD`. Service events are forwarded with `win.webContents.send('event', name, payload)`.
  - `preload/preload.ts`: `contextBridge.exposeInMainWorld('api', { invoke(method, input), on(event, cb): () => void })`; `invoke` refuses names not in `PUBLIC_METHODS`, `on` refuses names not in `EVENTS`, and the callback receives only the payload (never the `IpcRendererEvent`). Imports only `electron` and `src/shared/ipc-names.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test.each([
  '/home/u/Vault/06 - Health Research/Medical Concepts/HbA1c.md',
  '/home/u/Vault/Q&A #1?.md',
  '/home/u/Vault/Unicode Café ☕.md',
])('obsidian URI round-trips %s', p => {                           // Review Focus 4
  const u = new URL(obsidianUri(p));
  expect(u.protocol).toBe('obsidian:');
  expect(u.searchParams.get('path')).toBe(p);
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -- obsidian` → FAIL.
- [ ] **Step 3: Implement the four files.**
- [ ] **Step 4: Verify**

Run: `npm test` → all PASS. Run `npm start`; in DevTools console:
`await window.api.invoke('vault.current')` → `{ ok: true, data: null }` on first launch.
`await window.api.invoke('fs.read')` → rejected/`UNKNOWN_METHOD`.
`typeof require` → `'undefined'`.

- [ ] **Step 5: Commit** — `git commit -am "feat: main process service host, IPC bridge and preload"`

---

### Task 15: Renderer shell, Onboarding and Settings

**Files:**
- Create: `src/renderer/api.ts`, `src/renderer/styles.css`, `src/renderer/App.tsx` (replace), `src/renderer/components/Sidebar.tsx`, `src/renderer/components/ErrorNotice.tsx`, `src/renderer/views/Onboarding.tsx`, `src/renderer/views/Settings.tsx`

**Interfaces:**
- Consumes: `window.api` (Task 14), `ApiOutputs`/`PublicMethod`/`Result` types (Task 2).
- Produces: `call<M extends PublicMethod>(method: M, input?: Input<M>): Promise<Result<ApiOutputs[M]>>`; `useEvent(name: typeof EVENTS[number], cb: (payload: any) => void): void`; `type View = 'home' | 'ask' | 'library' | 'indexing' | 'settings'`; `App` state `{ view: View; noteId?: string; conversationId?: string }` with `navigate(view, params?)` passed down; `<ErrorNotice error={AppError} />` shows `message` and `hint` (hint in a monospace block when it is a command).

Requirements:
- CSS variables on `:root`: dark background, surface, border, text, muted text, one accent, danger, monospace font. System font stack. No inline `style=` attributes beyond dynamic sizes.
- App start: `vault.current`. Null → Onboarding. Otherwise sidebar (workspace name at top; Home, Ask, Library, Indexing, Settings with `lucide-react` icons) and the current view. `service:status reconnecting` shows a thin top banner "Reconnecting…". A `VAULT_NOT_FOUND` result from any call shows a banner "Vault not found at <path>" with **Choose again** (runs the onboarding vault step).
- Onboarding step 1: **Choose vault** → `vault.choose` → shows path and `mdCount` → **Use this vault** → `vault.confirm`. Step 2: `ollama.test`; list models; for each of `chatModel`/`embeddingModel` missing, show `ollama pull <name>`; unreachable shows `ollama serve`. **Continue** (also when skipping) → Home.
- Settings: form for every `Settings` field (models as `<select>` filled from `ollama.test`, with capabilities shown next to each), workspace answer guidelines (`<textarea>`), ignore patterns (one per line), **Test connection**, **Save** (`settings.update`). Data controls: **Reveal database file**, **Delete all conversations** and **Rebuild index**, the last two behind `window.confirm` with text saying vault files are not touched.

- [ ] **Step 1: Implement `api.ts` and `App.tsx` with the view switcher and sidebar.**
- [ ] **Step 2: Implement Onboarding.**
- [ ] **Step 3: Implement Settings.**
- [ ] **Step 4: Verify manually**

Run `npm start` with a fresh profile (`rm -rf ~/.config/"Second Brain"` only if you are sure it holds nothing you want). Expected: Onboarding appears → choose `Obisidan-Health` → shows 61 files (count `.md` files outside `.obsidian/`, `.trash/`, `.boost/` to confirm the exact number) → Use this vault → Ollama step reports status honestly with Ollama stopped and started → Continue. Restart the app → it opens straight to Home (Done-when 11 for vault selection). Change temperature, Save, restart → value kept.

- [ ] **Step 5: Commit** — `git commit -am "feat: renderer shell, onboarding and settings"`

---

### Task 16: Library and note preview

**Files:**
- Create: `src/renderer/views/Library.tsx`, `src/renderer/components/NotePreview.tsx`, `src/renderer/components/Markdown.tsx`

**Interfaces:**
- Consumes: `library.list`, `note.read`, `note.reindex`, `note.openInObsidian`, `index:progress`.
- Produces: `<Markdown text={string} onWikilink?={(target: string) => void} />` (react-markdown + remark-gfm, `skipHtml`, links with a scheme open nothing in-app; wikilinks pre-processed into `[text](#wikilink:<encoded target>)` links); `<NotePreview noteId={string} highlight?={{ charStart: number; charEnd: number }} onNavigate={(noteId: string) => void} />`.

Requirements:
- Left: search box (title/path, case-insensitive), filters (folder from note paths, tag, frontmatter `type`, index status), sort select. Lists title, folder, modified date, status badge (`indexed`/`pending`/`failed`/`excluded`). Folder groups `research_notes/` and `reports/` appear as their own folders (no special code; folder filter covers it).
- Right: `NotePreview` — title, properties table from frontmatter, rendered body, wikilinks resolved by matching `NoteDetail.links` (unresolved greyed and not clickable), status + error, **Reindex**, **Open in Obsidian**. With `highlight`, wrap the chunk whose offsets match in a highlighted block and `scrollIntoView` it (render the body as three parts split at `charStart`/`charEnd`).
- List refreshes on `index:progress` (throttled to once per second).

- [ ] **Step 1: Implement `Markdown`.**
- [ ] **Step 2: Implement `NotePreview`.**
- [ ] **Step 3: Implement `Library`.**
- [ ] **Step 4: Verify manually** — Library lists the real vault notes (Done-when 3). Filter by folder `06 - Health Research/Medical Concepts` → only those notes. Open `HbA1c` → frontmatter table shows `type biomarker`; `[[Laboratory Results]]` is greyed (unresolved on purpose); `[[Insulin Resistance]]` navigates. **Open in Obsidian** opens the note in Obsidian (Done-when 8). Typing `<script>` into a fixture note body renders as text, not HTML.
- [ ] **Step 5: Commit** — `git commit -am "feat: knowledge library with note preview"`

---

### Task 17: Ask view

**Files:**
- Create: `src/renderer/views/Ask.tsx`, `src/renderer/components/ConversationList.tsx`, `src/renderer/components/MessageView.tsx`, `src/renderer/components/Citations.tsx`

**Interfaces:**
- Consumes: `chat.*`, `chat:delta`, `chat:done`, `<Markdown>`, `<NotePreview>` (Task 16).

Requirements:
- Left: conversations (newest first), **New**, inline rename, delete with confirm.
- Main: messages; the streaming assistant message updates from `chat:delta` by `requestId`. Before the first delta: "Loading model…" (a 3B model on integrated graphics can take a minute on first use).
- Assistant message: `<Markdown>` with `[S<n>]` turned into chips (pre-process into `[S<n>](#cite:<n>)` before rendering). Chip click → opens `NotePreview` in a right-side panel with `highlight` from that citation (falls back to `snapshot_text` with "This note has changed or been deleted since this answer" when `chunk_id` is null or the note is not `indexed`).
- Under the answer: **Cited sources** (title › section, score as a percentage) and collapsed **Retrieved but not cited**. Warnings: no valid markers in a `rag` answer → "This answer did not cite any of your notes."; `unknownMarkers` → "Citation [S9] does not match any retrieved source."
- `general` messages carry the badge "General knowledge — not from your notes".
- `no_match` messages show **Answer from general knowledge**, which re-sends the same question with `mode: 'general'`.
- `cancelled` messages show "Stopped" ; `error` messages show `<ErrorNotice>`.
- Composer: textarea (Enter sends, Shift+Enter newline), mode toggle "From my notes" / "General knowledge", Send that becomes Stop (`chat.cancel`) while streaming.

- [ ] **Step 1: Implement `ConversationList`.**
- [ ] **Step 2: Implement `MessageView` and `Citations`.**
- [ ] **Step 3: Implement `Ask` with streaming and the composer.**
- [ ] **Step 4: Verify manually** with Ollama running and the vault indexed: ask "What are the published HbA1c thresholds?" → streamed answer cites `[S1]` → chip opens HbA1c › Published thresholds highlighted (Done-when 6–8). Ask something unrelated to the vault → "No notes in *Health* matched…" with the general-knowledge button. Press Stop mid-answer → "Stopped", partial text kept. Stop Ollama, ask → error with `ollama serve` hint. Restart app → conversation and its citations are still there (Done-when 11).
- [ ] **Step 5: Commit** — `git commit -am "feat: ask view with streaming answers and citations"`

---

### Task 18: Home and Indexing views

**Files:**
- Create: `src/renderer/views/Home.tsx`, `src/renderer/views/Indexing.tsx`

**Interfaces:**
- Consumes: `home.summary`, `index.status`, `index.retry`, `index.cancel`, `index.reembedAll`, `vault.refresh`, `index:progress`.

Requirements:
- Home: workspace name and vault path; counts (indexed / pending / failed / total) from `home.summary`, "—" while loading; 5 recent notes (click → Library with that note); 5 recent conversations (click → Ask); an ask box (Enter → Ask view, new conversation, `rag` mode); **Refresh vault**.
- Indexing: live counts and current note from `index:progress`; paused reason as a banner (`ollama-unreachable` → endpoint + `ollama serve`; `model-mismatch` → "Index built with A, current model is B" + **Re-embed all**; `cancelled` → **Resume** (`vault.refresh`); `no-vault` → link to onboarding); failed notes (from `library.list` with `status: 'failed'`) with error and **Retry**; **Retry all failed**; **Cancel**.

- [ ] **Step 1: Implement `Home`.**
- [ ] **Step 2: Implement `Indexing`.**
- [ ] **Step 3: Verify manually** — with Ollama stopped, Indexing shows the unreachable banner and 0 failed; start Ollama → it resumes on its own and finishes (Done-when 4, 5, 9). Switch the embedding model in Settings to another pulled embedding model → mismatch banner → Re-embed all → status ok. Home counts match `SELECT index_status, count(*) FROM notes GROUP BY 1` in the database.
- [ ] **Step 4: Commit** — `git commit -am "feat: home dashboard and indexing status"`

---

### Task 19: End-to-end test, README and acceptance

**Files:**
- Create: `tests/integration/core-loop.test.ts`, `tests/e2e/smoke.spec.ts`, `playwright.config.ts`, `app/README.md`
- Modify: root `README.md` (one paragraph pointing to `app/README.md`)

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the integration test** (`core-loop.test.ts`, in-process `createHandlers` with fake providers and a temp copy of the fixture vault)

```ts
test('index → ask → cite → edit → delete', async () => {
  await call('vault.set', { path: tmpVault }); await indexer.idle();
  const { conversationId } = await call('chat.send', { conversationId: null, text: 'What does chlorophyll absorb?', mode: 'rag' });
  await doneEvent();
  const cited = (await call('chat.get', { conversationId })).messages[1].citations.filter(c => c.cited);
  expect(cited[0]).toMatchObject({ noteRelPath: 'Topics/Chlorophyll.md', headingPath: expect.arrayContaining(['Absorption']) });
  // edit the note → sync → kick → idle: chunk rows for the note === chunkNote(parse(new content)).length
  // delete the note → sync: no chunk rows for it; the old citation's snapshotText is unchanged
});
```

- [ ] **Step 2: Run it** — `npm test -- core-loop` → PASS.

- [ ] **Step 3: Make the packaged app run.** The E2E test needs a production build, and Forge's Vite plugin does not copy external native modules into the package. In `forge.config.mts`: add `@electron-forge/plugin-auto-unpack-natives`, and a `hooks.packageAfterCopy(config, buildPath)` that copies `better-sqlite3`, `bindings`, `file-uri-to-path`, `sqlite-vec` and `sqlite-vec-linux-x64` from `node_modules/` to `buildPath/node_modules/`. Set `packagerConfig.executableName: 'second-brain'`. Run `npm run package` → `out/Second Brain-linux-x64/second-brain` starts and reaches Onboarding.

- [ ] **Step 4: Write the E2E smoke test** (`npm install -D @playwright/test@1.64`; run `npm run package` before it)

```ts
const exe = path.resolve('out/Second Brain-linux-x64/second-brain');
test('choose vault, browse, restart keeps state', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-e2e-'));
  let app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, tmpVault);
  const win = await app.firstWindow();
  await win.getByRole('button', { name: 'Choose vault' }).click();
  await win.getByRole('button', { name: 'Use this vault' }).click();
  await win.getByRole('button', { name: 'Continue' }).click();
  await win.getByRole('button', { name: 'Library' }).click();   // Sidebar items are <button>s
  await expect(win.getByText('Photosynthesis')).toBeVisible();
  await app.close();
  app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
  const win2 = await app.firstWindow();
  await expect(win2.getByRole('button', { name: 'Library' })).toBeVisible();          // sidebar = not Onboarding
  await expect(win2.getByRole('button', { name: 'Choose vault' })).toHaveCount(0);
  await app.close();
});
```

`--user-data-dir` must be honoured: in `src/main/main.ts`, before `app.whenReady()`, `app.commandLine.getSwitchValue('user-data-dir')` → `app.setPath('userData', value)` when present. Add `"test:e2e": "playwright test"`.

- [ ] **Step 5: Run it** — `npm run test:e2e` → PASS.
- [ ] **Step 6: Write `app/README.md`**: what it is; requirements (Node 22, Ollama); setup (`npm install`, `ollama serve`, `ollama pull qwen2.5:3b`, `ollama pull nomic-embed-text`, `npm start`); tests (`npm test`, `OLLAMA_IT=1 npm test`, `npm run test:e2e`); where data lives and that the vault is never written; what is not built yet (spec §11); the manual acceptance checklist below.
- [ ] **Step 7: Run the acceptance checklist** against `Obisidan-Health` with real Ollama and tick each item in the README:
  1. App launches. 2. Vault chosen with the native picker. 3. Library shows the real notes. 4–5. Indexing completes with `nomic-embed-text`; Indexing shows 0 failed or explains each failure. 6–7. A question about a Medical Concepts note gets a streamed answer with at least one valid citation. 8. The citation opens the note in-app at the right section and in Obsidian. 9. Stopping Ollama shows the paused state and the fix. 11. After a restart, the vault, index, conversations and settings are all still there.
- [ ] **Step 8: Commit** — `git add -A app README.md && git commit -m "test: core loop integration and e2e; docs: README and acceptance checklist"`
