import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { IndexStatus, LibraryFilter, NoteSummary } from '../../shared/types';
import type { KnownNote, ScanDiff } from '../vault/scan';
import { enqueueIndex } from './jobs';

export interface NoteRow {
  id: string;
  workspaceId: number;
  relPath: string;
  title: string;
  mtime: number;
  size: number;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  status: IndexStatus;
  error: string | null;
  lastIndexedAt: string | null;
  embeddingModelId: number | null;
}

type Row = {
  id: string;
  workspace_id: number;
  rel_path: string;
  title: string;
  mtime: number;
  size: number;
  content_hash: string;
  frontmatter: string;
  tags: string;
  index_status: IndexStatus;
  error: string | null;
  last_indexed_at: string | null;
  embedding_model_id: number | null;
};

export function knownNotes(db: Database.Database, workspaceId: number): KnownNote[] {
  const rows = db
    .prepare('SELECT id, rel_path, mtime, size, content_hash, index_status FROM notes WHERE workspace_id = ?')
    .all(workspaceId) as Pick<Row, 'id' | 'rel_path' | 'mtime' | 'size' | 'content_hash' | 'index_status'>[];
  return rows.map((r) => ({
    id: r.id,
    relPath: r.rel_path,
    mtimeMs: r.mtime,
    size: r.size,
    hash: r.content_hash,
    status: r.index_status,
  }));
}

export function getNote(db: Database.Database, noteId: string): NoteRow | null {
  const r = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    relPath: r.rel_path,
    title: r.title,
    mtime: r.mtime,
    size: r.size,
    contentHash: r.content_hash,
    frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown>,
    tags: JSON.parse(r.tags) as string[],
    status: r.index_status,
    error: r.error,
    lastIndexedAt: r.last_indexed_at,
    embeddingModelId: r.embedding_model_id,
  };
}

// Task 8 adds a vector delete here, before the chunks go (vectors are keyed by chunk id).
export function deleteNoteIndex(db: Database.Database, noteId: string): void {
  db.prepare('DELETE FROM links WHERE source_note_id = ?').run(noteId);
  db.prepare('UPDATE links SET target_note_id = NULL WHERE target_note_id = ?').run(noteId);
  db.prepare('DELETE FROM chunks WHERE note_id = ?').run(noteId);
}

export function applyScanDiff(db: Database.Database, workspaceId: number, diff: ScanDiff): void {
  const insert = db.prepare(
    "INSERT INTO notes (id, workspace_id, rel_path, title, mtime, size, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const markChanged = db.prepare(
    "UPDATE notes SET mtime = ?, size = ?, content_hash = ?, index_status = 'pending', error = NULL WHERE id = ?",
  );
  const touch = db.prepare('UPDATE notes SET mtime = ?, size = ? WHERE id = ?');
  // Renames keep the indexed content; the title (if it came from the file name) refreshes on the next edit.
  const rename = db.prepare('UPDATE notes SET rel_path = ?, mtime = ?, size = ? WHERE id = ?');
  const retire = (status: 'deleted' | 'excluded') => (noteId: string) => {
    deleteNoteIndex(db, noteId);
    db.prepare("DELETE FROM jobs WHERE note_id = ? AND status = 'queued'").run(noteId);
    db.prepare('UPDATE notes SET index_status = ?, error = NULL WHERE id = ?').run(status, noteId);
  };

  db.transaction(() => {
    for (const f of diff.added) {
      const id = randomUUID();
      // Placeholder title until the indexer parses the note.
      insert.run(id, workspaceId, f.relPath, f.relPath.split('/').pop()!.replace(/\.md$/i, ''), f.mtimeMs, f.size, f.hash);
      enqueueIndex(db, id);
    }
    for (const c of diff.changed) {
      markChanged.run(c.mtimeMs, c.size, c.hash, c.noteId);
      enqueueIndex(db, c.noteId);
    }
    for (const r of diff.renamed) rename.run(r.to.relPath, r.to.mtimeMs, r.to.size, r.noteId);
    for (const t of diff.touched) touch.run(t.mtimeMs, t.size, t.noteId);
    for (const d of diff.deleted) retire('deleted')(d.noteId);
    for (const x of diff.excluded) retire('excluded')(x.noteId);
  })();
}

const esc = (s: string) => s.replace(/[\\%_]/g, '\\$&');

export function listNotes(db: Database.Database, workspaceId: number, filter: LibraryFilter): NoteSummary[] {
  const where = ['workspace_id = ?'];
  const args: unknown[] = [workspaceId];
  if (filter.status) {
    where.push('index_status = ?');
    args.push(filter.status);
  } else {
    where.push("index_status NOT IN ('deleted', 'excluded')");
  }
  if (filter.query) {
    where.push("(title LIKE ? ESCAPE '\\' OR rel_path LIKE ? ESCAPE '\\')");
    args.push(`%${esc(filter.query)}%`, `%${esc(filter.query)}%`);
  }
  if (filter.folder) {
    where.push("rel_path LIKE ? ESCAPE '\\'");
    args.push(`${esc(filter.folder.replace(/\/+$/, ''))}/%`);
  }
  if (filter.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
    args.push(filter.tag);
  }
  if (filter.type) {
    where.push("json_extract(frontmatter, '$.type') = ?");
    args.push(filter.type);
  }
  const order = filter.sort === 'title-asc' ? 'title COLLATE NOCASE ASC' : 'mtime DESC, title COLLATE NOCASE ASC';

  const rows = db
    .prepare(
      `SELECT id, rel_path, title, mtime, tags, index_status, json_extract(frontmatter, '$.type') AS type
       FROM notes WHERE ${where.join(' AND ')} ORDER BY ${order}`,
    )
    .all(...args) as (Pick<Row, 'id' | 'rel_path' | 'title' | 'mtime' | 'tags' | 'index_status'> & { type: unknown })[];
  return rows.map((r) => ({
    id: r.id,
    relPath: r.rel_path,
    title: r.title,
    mtime: r.mtime,
    tags: JSON.parse(r.tags) as string[],
    type: typeof r.type === 'string' ? r.type : null,
    status: r.index_status,
  }));
}
