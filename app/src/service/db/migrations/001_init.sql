-- Core loop schema (spec §4). Per-model vec0 tables are created at runtime (Task 8).

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vault_root TEXT NOT NULL,
  ignore_patterns TEXT NOT NULL DEFAULT '[]', -- JSON array
  answer_guidelines TEXT NOT NULL DEFAULT ''
);

CREATE TABLE embedding_models (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  digest TEXT
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY, -- crypto.randomUUID(), assigned at first discovery
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL, -- SHA-256
  frontmatter TEXT NOT NULL DEFAULT '{}', -- JSON object
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array
  index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexed', 'failed', 'deleted', 'excluded')),
  error TEXT,
  last_indexed_at TEXT,
  embedding_model_id INTEGER REFERENCES embedding_models(id),
  UNIQUE (workspace_id, rel_path)
);
CREATE INDEX idx_notes_workspace_status ON notes(workspace_id, index_status);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading_path TEXT NOT NULL, -- e.g. 'HbA1c (A1C) › Limitations'
  text TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  UNIQUE (note_id, ordinal)
);

CREATE TABLE links (
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_text TEXT NOT NULL,
  target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL, -- NULL = unresolved
  kind TEXT NOT NULL CHECK (kind IN ('wikilink', 'embed', 'markdown'))
);
CREATE INDEX idx_links_source ON links(source_note_id);
CREATE INDEX idx_links_target ON links(target_note_id);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one queued job per note. A running job does not block a new queued one,
-- so an edit during indexing queues a follow-up run.
CREATE UNIQUE INDEX idx_jobs_one_queued_per_note
  ON jobs(note_id) WHERE status = 'queued';

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_workspace ON conversations(workspace_id, updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('rag', 'general')),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'cancelled', 'error', 'no_match')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- note_id has no foreign key on purpose: citations keep their snapshots even if the note row goes.
CREATE TABLE citations (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  marker TEXT NOT NULL, -- 'S1', 'S2', ...
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  note_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  cited INTEGER NOT NULL CHECK (cited IN (0, 1)),
  snapshot_text TEXT NOT NULL,
  snapshot_heading_path TEXT NOT NULL,
  snapshot_note_title TEXT NOT NULL,
  PRIMARY KEY (message_id, marker)
);
CREATE INDEX idx_citations_chunk ON citations(chunk_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);
