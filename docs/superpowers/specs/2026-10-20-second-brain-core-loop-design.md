# Second Brain — Sub-project 1: Core Loop — Design

Date: 2026-10-20
Status: approved in brainstorming, pending written-spec review

## 1. Purpose

Second Brain is a local-first Electron desktop app that indexes an Obsidian vault and answers questions about it with retrieval-augmented generation (RAG) and clickable source citations. The Markdown files are the source of truth; the index is a disposable, rebuildable representation.

The full product brief spans seven phases. It is split into sub-projects, each with its own spec → plan → implementation cycle:

| # | Sub-project | Status |
|---|---|---|
| 1 | Core loop: shell, secure IPC, vault selection, Library, Markdown indexing, RAG chat with citations, persistent state | **this spec** |
| 2 | Knowledge Graph from extracted links | later |
| 3 | Multimodal intake (PDF/DOCX, images, audio) + capture-to-note with preview/diff | later |
| 4 | Hardening and packaging | later |

### Done when (Definition of Done items 1–9, 11)

Against the real `Obisidan-Health` vault (61 Markdown files) with real Ollama, the user can:

1. Launch the app.
2. Select the vault with a native folder picker.
3. Browse the actual Markdown notes.
4. Index them.
5. Generate embeddings with a real embedding model.
6. Ask questions using RAG.
7. Receive answers with source citations.
8. Open the cited original note (in-app preview and in Obsidian).
9. See indexing status and errors.

(Item 10, the graph, belongs to sub-project 2.)

11\. Restart the app without losing vault selection, index, conversations or settings.

## 2. Decisions

| Decision | Choice |
|---|---|
| Platform | Linux (Fedora) for development and first target; no Linux-only code |
| Runtime / toolchain | Electron, Electron Forge with the Vite template, React, TypeScript, npm |
| Models | Local only via Ollama. Chat: `qwen2.5:3b`. Embeddings: `nomic-embed-text` (768 dims). Both changeable in Settings |
| Cloud providers | None in this sub-project. Provider interfaces exist so one can be added later |
| Vault access | **Strictly read-only.** The app never writes inside the vault folder |
| Storage | One SQLite file via `better-sqlite3` + `sqlite-vec` (`vec0`), in the Electron `userData` folder (`~/.config/Second Brain/brain.db`), never in the vault |
| Workspaces | Data model supports many; UI runs one active workspace. Health is the first; no code is health-specific |
| Validation | `zod` for every IPC input |
| Frontmatter | `yaml` package |
| Markdown rendering | `react-markdown` + `remark-gfm`, raw HTML disabled, no syntax highlighting |
| Icons | `lucide-react` |
| Styling | Plain CSS with variables, dark first, one accent color, system fonts; no UI library |
| Routing | `useState` view switcher; no router library |
| File watching | Node built-in recursive `fs.watch`; no watcher library |
| Tests | Vitest run under Electron's Node (`ELECTRON_RUN_AS_NODE=1`), one Playwright Electron smoke test |

## 3. Architecture

Three processes:

- **Renderer (React UI):** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. CSP `default-src 'self'`, `connect-src 'self'` (the UI never talks to Ollama). External navigation and `window.open` are blocked.
- **Main process:** window, menus, native dialogs, `obsidian://` opener, IPC router, supervisor of the knowledge service. Does no heavy work.
- **Knowledge service (`utilityProcess`):** database, vault scanning and watching, indexing queue, retrieval, chat, Ollama provider. Talks to main over a `MessagePort`. If it exits unexpectedly, main restarts it and the UI shows "Reconnecting…".

### IPC

- The preload exposes exactly one object, `window.api`, with a fixed set of named methods (e.g. `vault.choose()`, `library.list(filter)`, `note.read(noteId)`, `chat.send(convId, text, opts)`, `chat.cancel(reqId)`).
- The contract (method names, zod input schemas, result types) lives in `src/shared/` and is shared by main, preload, service and renderer.
- Every call returns `{ ok: true, data }` or `{ ok: false, error: { code, message, hint } }`.
- Push events from service to UI: `index:progress`, `chat:delta`, `chat:done`, `service:status`.

### File access rules

- The renderer never sends a file path. It sends a `noteId`; the service resolves the path from the database.
- The **vault guard** (single module) resolves the real path (following symlinks) and refuses anything outside the vault root, and anything under `.obsidian/`, `.trash/`, `.boost/` or a workspace ignore pattern.
- "Open in Obsidian" builds `obsidian://open?path=<absolute path>` from the service-resolved path, and main opens it with `shell.openExternal`.
- Model output is never executed. The model has no tools.
- Logs contain event types, ids, timings and error codes, never note text or questions.

## 4. Data model

All in one SQLite file. Migrations are numbered SQL files run in order at startup, each in a transaction, tracked in `schema_migrations`. If the database's schema version is newer than the app knows, the app refuses to open it.

| Table | Columns / notes |
|---|---|
| `workspaces` | id, name, vault_root, ignore_patterns (JSON), answer_guidelines (text) |
| `notes` | id (random, assigned at first discovery), workspace_id, rel_path, title, mtime, size, content_hash (SHA-256), frontmatter (JSON), tags (JSON), index_status (`pending`/`indexed`/`failed`/`deleted`/`excluded`), error, last_indexed_at, embedding_model_id. Unique `(workspace_id, rel_path)` |
| `chunks` | id, note_id, ordinal, heading_path (e.g. `HbA1c (A1C) › Limitations`), text, char_start, char_end, token_estimate |
| `chunk_vectors_<model>_<dim>` | `vec0` virtual table: chunk_id → float[dim]. One table per embedding model + dimension |
| `embedding_models` | id, provider, name, dimensions, digest (from Ollama) |
| `links` | source_note_id, target_text, target_note_id (null when unresolved), kind (`wikilink`/`embed`/`markdown`) |
| `jobs` | id, kind, note_id, status (`queued`/`running`/`done`/`failed`), attempts, error, created_at, updated_at. At most one non-finished job per note |
| `conversations` | id, workspace_id, title, created_at, updated_at |
| `messages` | id, conversation_id, role, content, mode (`rag`/`general`), model, status (`complete`/`cancelled`/`error`), created_at |
| `citations` | message_id, marker (`S1`…), chunk_id (nullable), note_id, rank, score, snapshot_text, snapshot_heading_path, snapshot_note_title |
| `settings` | key, value (JSON) |

### Sync rules

- **New file:** new note row, indexing job queued.
- **Changed file** (mtime/size differ and hash differs): delete the note's chunks, vectors and links, insert the new ones, all in one transaction. Hash unchanged → only mtime is updated.
- **Rename:** a deleted path and a new path with the same hash in one scan → keep the existing note id and update `rel_path`.
- **Deleted file:** remove chunks, vectors and links; mark note `deleted`. Citations keep their snapshots. Conversations are never touched.
- **Ignored:** `.obsidian/`, `.trash/`, `.boost/` by default, plus per-workspace patterns. Notes newly matching a pattern are marked `excluded` and their chunks removed.
- **Embedding model change** (name or digest differs from the model the index was built with): retrieval is refused with "Index built with A, current model is B" until the user runs Re-embed all. Vectors from different models are never mixed.

## 5. Indexing pipeline

`scan → diff → queue → parse → chunk → embed → write (one transaction)`

### Change detection

- Full scan at startup, after vault selection, and on "Refresh vault".
- While running, recursive `fs.watch` events are debounced for 500 ms, then the affected paths are rescanned.
- Diff: compare mtime and size; compute SHA-256 only when they differ.

### Parsing (`markdown/parse.ts`)

- Frontmatter: `yaml`. Invalid YAML → note error `invalid frontmatter`, body still indexed.
- Title: frontmatter `title` → first `# H1` → filename without extension.
- Tags: frontmatter `tags` plus inline `#tag`.
- Links: `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`, `![[embed]]`, `[text](relative.md)`. Text inside fenced code blocks and inline code is ignored. Resolution: exact relative path, then unique case-insensitive basename match; otherwise unresolved (expected in this vault; not an error).
- Headings: line-based parser aware of fenced code blocks.

### Chunking (`markdown/chunk.ts`)

- One chunk per heading section.
- Sections under ~300 characters merge into the following section under the same parent heading.
- Sections over ~2,000 characters split at paragraph boundaries, never inside a paragraph or code fence; one paragraph of overlap.
- Limits are configurable per file type.
- Embedded text: `search_document: <note title> › <heading path>\n\n<chunk text>`. Stored chunk text has no header.

### Embedding

- Ollama `/api/embed`, batches of 16 chunks, one note at a time, one request in flight.
- Response dimension must match `embedding_models.dimensions`, else the note fails.
- Timeout 60 s per request. Up to 3 attempts with waits of 2 s, 8 s, 30 s; then `failed` with a Retry action.
- Ollama unreachable → the queue pauses (jobs are not failed) and resumes when a health check succeeds.
- Model missing → job fails immediately with `ollama pull <model>` hint, without consuming retries.
- On service start, jobs left `running` return to `queued`.
- Cancel stops after the current note; the database stays consistent.
- Progress events: counts of queued, running, done, failed, plus the current note title.

## 6. Retrieval and chat

### Retrieval (`rag/retrieve.ts`, no UI dependencies)

1. Embed the question with prefix `search_query: `.
2. KNN top 20 from the active model's `vec0` table, restricted to the active workspace and notes with status `indexed`.
3. Drop results with cosine distance above the cutoff (default 0.55, setting).
4. Keep at most 2 chunks per note.
5. Take results in score order up to ~6,000 characters, at most 6 chunks.
6. If nothing remains, RAG mode does **not** call the model. The reply is "No notes in *<workspace>* matched this question" with an "Answer from general knowledge" action.

Keyword/hybrid search, reranking and query rewriting are out of scope.

### Prompt

- System prompt: rules plus numbered sources. Each source header: `[S<n>] <note title> › <heading path> (<type> · <source_type> · <status>)`, using frontmatter fields that are present.
- Rules: answer only from the sources; cite as `[S<n>]`; say when the sources do not cover the question or conflict; do not present general knowledge as coming from the notes.
- The workspace's `answer_guidelines` text is appended. Default for Health: keep general research separate from personal records, never diagnose, recommend professional review for individual medical questions.
- History: last 6 messages, trimmed to fit. Retrieval uses only the current question.
- Ollama `num_ctx` 8192, temperature 0.2 (setting).

### Generation

- Ollama `/api/chat` with streaming; deltas forwarded service → main → renderer.
- Cancel aborts the request; the partial answer is saved with status `cancelled`.
- Timeouts: 180 s to first token, 60 s between tokens.

### Citation check (after completion)

- Parse `[S<n>]` markers. A marker with no matching source is shown as a citation error, not removed.
- Store citations for every retrieved source with snapshots; the UI shows **Cited sources** and **Retrieved but not cited** separately.
- A RAG answer with no valid markers shows: "This answer did not cite any of your notes."

### Modes and conversations

- Per message: "From my notes" (default, `rag`) or "General knowledge" (`general`: no retrieval, answer labeled as not from the notes).
- Title: first 60 characters of the first question; renamable.
- Delete a conversation removes its messages and citations.
- Nothing from conversations is written to the vault or promoted to knowledge.

## 7. Interface

Dark first. Left sidebar: active workspace name, then Home, Ask, Library, Indexing, Settings. Knowledge Graph and Capture and Import are not shown until they exist.

- **First launch:** step 1 choose vault (native picker; show count of `.md` files found; confirm). Step 2 check Ollama (test endpoint, list models, show `ollama pull` commands for missing ones). Step 2 is skippable.
- **Home:** workspace name and vault path; counts of indexed / pending / failed notes; 5 most recently modified notes; 5 most recent conversations; ask box; Refresh vault. Every number comes from the database; unknown shows "—".
- **Ask:** conversation list (new, rename, delete) and conversation view. Streaming Markdown answers, `[S<n>]` as clickable chips, cited and retrieved-not-cited source lists with note title, section and score. Mode toggle and Send/Stop. States: empty, loading model, streaming, error with hint, cancelled. Clicking a citation opens the note preview scrolled to and highlighting the section.
- **Library:** list with title/path search; filters by folder, tag, frontmatter `type`, index status; sort by modified date. Preview pane: rendered note, frontmatter as a properties table, wikilinks as in-app links (unresolved greyed), index status and error, Reindex, Open in Obsidian.
- **Indexing:** live counts, current note, failed list with error and Retry, Retry all failed, model-mismatch banner with Re-embed all, Cancel.
- **Settings:** Ollama endpoint with Test connection; chat and embedding model chosen from the models Ollama reports, with capabilities shown; temperature; retrieval cutoff; workspace answer guidelines and ignore patterns; data controls (reveal database file, delete all conversations, rebuild index — deletes index data only, never vault files).

## 8. Errors

| Failure | User sees | Behavior |
|---|---|---|
| Vault missing/unreadable | Banner "Vault not found at …" + Choose again | Indexing stops; index and conversations kept |
| Ollama unreachable | "Ollama unreachable at <endpoint>" + `ollama serve` | Queue paused; chat errors; auto-resume |
| Model not pulled | "Model X not found" + `ollama pull X` | Job failed without consuming retries |
| Parse/embed failure | Note marked failed with reason | 3 retries, then manual Retry |
| Embedding model changed | "Index built with A, current model is B" | Retrieval refused until Re-embed all |
| Service crash | "Reconnecting…" | Main restarts service; running jobs requeued |
| Database newer than app | Startup error | Database not opened |

## 9. Testing

- Vitest under `ELECTRON_RUN_AS_NODE=1` so native modules are built once, for Electron.
- **Synthetic fixture vault** `tests/fixtures/vault/`: invented general-topic notes only (no real or invented personal health data), covering frontmatter, broken YAML, nested headings, code fences containing link syntax, every link form, unresolved links, an `.obsidian/` folder, and a symlink pointing outside the vault.
- **Fake embedding provider:** deterministic bag-of-words vectors, so retrieval tests are exact without Ollama. **Fake chat provider:** returns scripted text with chosen markers.
- **Unit:** parse (frontmatter, title, tags, headings, links), chunk, link resolution, vault guard (`..`, symlink escape, ignored folders), scan diff (add, change, rename, delete, exclude), retrieval (cutoff, per-note cap, budget, workspace filter), citation parsing (valid, unknown, none), migrations (fresh, upgrade, newer-than-app refusal), conversation persistence across reopen, IPC input validation, provider error mapping (unreachable, model missing, timeout, dimension mismatch), model-mismatch refusal.
- **Integration:** index fixture vault → ask with fake providers → correct note and section cited → edit note → no duplicate chunks → delete note → chunks gone, old citation snapshots intact.
- **Real Ollama (opt-in, `OLLAMA_IT=1`):** embed and chat against the configured models.
- **E2E (Playwright `_electron`):** launch, choose fixture vault (dialog stubbed from the test runner via `electronApp.evaluate`; no test hooks in app code), library lists the notes, restart, vault and a saved conversation still present.
- **Manual acceptance:** README checklist for Done-when items 1–9 and 11 against `Obisidan-Health` with real Ollama.

## 10. Code layout

```
src/
  shared/     ipc contract: method names, zod schemas, result/error types
  main/       window, CSP, ipc router, dialogs, obsidian:// opener, service supervisor
  preload/    exposes window.api only
  service/    utilityProcess entry
    db/         connection, migrations/*.sql, repositories
    vault/      guard, scanner, watcher
    markdown/   parse, chunk
    index/      job queue, indexer
    providers/  EmbeddingProvider / ChatProvider interfaces, ollama.ts, fake.ts
    rag/        retrieve, prompt, citations
    chat/       conversation service, streaming
  renderer/   views/ (Onboarding, Home, Ask, Library, Indexing, Settings), components/
tests/        fixtures/vault, unit/, integration/, e2e/
```

The README documents setup (Node 22, `npm install`, `ollama serve`, `ollama pull qwen2.5:3b`, `ollama pull nomic-embed-text`, `npm start`), tests, and the manual acceptance checklist.

## 11. Out of scope

Knowledge Graph view; PDF, DOCX, image and audio intake; any write to the vault (including save-answer-as-note); keyword/hybrid search, reranking, query rewriting; cloud providers; long-term approved memory; multi-workspace UI; packaging and installers; encryption at rest (not claimed anywhere in the UI or docs).
