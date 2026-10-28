import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openDatabase } from '../../src/service/db/connection';
import {
  claimNextJob,
  enqueueIndex,
  finishJob,
  jobCounts,
  requeueRunning,
} from '../../src/service/db/jobs';
import { loadMigrations, migrate } from '../../src/service/db/migrate';
import { knownNotes, listNotes } from '../../src/service/db/notes';
import {
  createWorkspace,
  getActiveWorkspace,
  HEALTH_GUIDELINES,
  setActiveWorkspace,
  updateWorkspace,
} from '../../src/service/db/workspaces';
import { createVaultGuard, DEFAULT_IGNORES } from '../../src/service/vault/guard';
import { syncVault } from '../../src/service/vault/sync';

let db: ReturnType<typeof openDatabase>;
let wsId: number;
let tmp: string;
let vault: string;
let ctx: Parameters<typeof syncVault>[0];

const addNote = (id: string) =>
  db
    .prepare(
      "INSERT INTO notes (id, workspace_id, rel_path, title, mtime, size, content_hash) VALUES (?, ?, ?, ?, 0, 0, 'h')",
    )
    .run(id, wsId, `${id}.md`, id);
const noteId = (relPath: string) => knownNotes(db, wsId).find((n) => n.relPath === relPath)!.id;
const statusOf = (relPath: string) => knownNotes(db, wsId).find((n) => n.relPath === relPath)!.status;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-'));
  vault = path.join(tmp, 'vault');
  await fs.cp(path.join(import.meta.dirname, '../fixtures/vault'), vault, { recursive: true });
  db = openDatabase(':memory:');
  migrate(db, loadMigrations());
  wsId = createWorkspace(db, { name: 'Notes', vaultRoot: vault }).id;
  ctx = { db, guard: createVaultGuard(vault, DEFAULT_IGNORES), workspaceId: wsId };
});

afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

// ---- workspaces and job queue ----

test('workspace defaults, active workspace and updates', () => {
  const ws = createWorkspace(db, { name: 'Health', vaultRoot: '/h' });
  expect(ws).toMatchObject({ ignorePatterns: DEFAULT_IGNORES, answerGuidelines: HEALTH_GUIDELINES });
  expect(getActiveWorkspace(db)).toBeNull();
  setActiveWorkspace(db, ws.id);
  expect(getActiveWorkspace(db)?.id).toBe(ws.id);
  expect(updateWorkspace(db, ws.id, { ignorePatterns: ['x/**'] }).ignorePatterns).toEqual(['x/**']);
  expect(db.prepare('SELECT answer_guidelines g FROM workspaces WHERE id = ?').get(wsId)).toEqual({ g: '' });
});

test('re-queue does not duplicate a queued job', () => {
  addNote('n1');
  enqueueIndex(db, 'n1');
  enqueueIndex(db, 'n1');
  expect(jobCounts(db, wsId)).toMatchObject({ queued: 1, running: 0 });
});

test('a running job allows one new queued job', () => {
  addNote('n1');
  enqueueIndex(db, 'n1');
  expect(claimNextJob(db)).toMatchObject({ noteId: 'n1', status: 'running' });
  enqueueIndex(db, 'n1');
  enqueueIndex(db, 'n1');
  expect(jobCounts(db, wsId)).toMatchObject({ running: 1, queued: 1 });
});

test('finishing, retry accounting and restart recovery', () => {
  addNote('n1');
  enqueueIndex(db, 'n1');
  const job = claimNextJob(db)!;
  finishJob(db, job.id, { status: 'queued', countAttempt: true });
  expect(claimNextJob(db)).toMatchObject({ id: job.id, attempts: 1 });
  expect(requeueRunning(db)).toBe(1);
  const again = claimNextJob(db)!;
  finishJob(db, again.id, { status: 'failed', error: 'boom', countAttempt: false });
  expect(jobCounts(db, wsId)).toMatchObject({ failed: 1, queued: 0, running: 0 });
  expect(claimNextJob(db)).toBeNull();
});

test('a retry that was superseded by a newer queued job is closed, not duplicated', () => {
  addNote('n1');
  enqueueIndex(db, 'n1');
  const job = claimNextJob(db)!;
  enqueueIndex(db, 'n1'); // edit during indexing
  finishJob(db, job.id, { status: 'queued', countAttempt: true });
  expect(jobCounts(db, wsId)).toMatchObject({ queued: 1, running: 0, done: 1 });
});

// ---- vault sync ----

test('first sync adds and queues every non-ignored note', async () => {
  const mdFiles = (await fs.readdir(vault, { recursive: true })).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.obsidian'),
  );
  const result = await syncVault(ctx);
  expect(result).toEqual({ added: mdFiles.length, changed: 0, renamed: 0, deleted: 0, excluded: 0 });
  expect(jobCounts(db, wsId).queued).toBe(mdFiles.length);
  expect(statusOf('Topics/Photosynthesis.md')).toBe('pending');
});

test('a second sync with no edits changes nothing', async () => {
  await syncVault(ctx);
  const queued = jobCounts(db, wsId).queued;
  expect(await syncVault(ctx)).toEqual({ added: 0, changed: 0, renamed: 0, deleted: 0, excluded: 0 });
  expect(jobCounts(db, wsId).queued).toBe(queued);
});

test('missing vault root changes nothing', async () => {
  await syncVault(ctx);
  await fs.rm(vault, { recursive: true });
  await expect(syncVault(ctx)).rejects.toMatchObject({ code: 'VAULT_NOT_FOUND' });
  expect(knownNotes(db, wsId).every((n) => n.status !== 'deleted')).toBe(true);
});

test('deleted file marks the note deleted and removes its chunks and queued job', async () => {
  await syncVault(ctx);
  const id = noteId('Home.md');
  db.prepare(
    "INSERT INTO chunks (note_id, ordinal, heading_path, text, char_start, char_end, token_estimate) VALUES (?, 0, 'Home', '# Home', 0, 6, 2)",
  ).run(id);
  await fs.rm(path.join(vault, 'Home.md'));
  expect((await syncVault(ctx)).deleted).toBe(1);
  expect(statusOf('Home.md')).toBe('deleted');
  expect(db.prepare('SELECT count(*) n FROM chunks WHERE note_id = ?').get(id)).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) n FROM jobs WHERE note_id = ? AND status = 'queued'").get(id)).toEqual({ n: 0 });
});

test('rename keeps the note id and does not re-queue', async () => {
  await syncVault(ctx);
  const id = noteId('Home.md');
  const queued = jobCounts(db, wsId).queued;
  await fs.rename(path.join(vault, 'Home.md'), path.join(vault, 'Start.md'));
  expect(await syncVault(ctx)).toMatchObject({ renamed: 1, added: 0, deleted: 0 });
  expect(noteId('Start.md')).toBe(id);
  expect(jobCounts(db, wsId).queued).toBe(queued);
});

test('an edited note becomes pending and is queued again', async () => {
  await syncVault(ctx);
  const id = noteId('Home.md');
  db.prepare("UPDATE notes SET index_status = 'indexed' WHERE id = ?").run(id);
  db.prepare("DELETE FROM jobs WHERE note_id = ?").run(id);
  await fs.writeFile(path.join(vault, 'Home.md'), '# Home\n\nEdited.\n');
  expect((await syncVault(ctx)).changed).toBe(1);
  expect(statusOf('Home.md')).toBe('pending');
  expect(db.prepare("SELECT count(*) n FROM jobs WHERE note_id = ? AND status = 'queued'").get(id)).toEqual({ n: 1 });
});

test('a newly ignored folder is excluded, its chunks removed, and it comes back when allowed again', async () => {
  await syncVault(ctx);
  const id = noteId('Topics/Photosynthesis.md');
  db.prepare(
    "INSERT INTO chunks (note_id, ordinal, heading_path, text, char_start, char_end, token_estimate) VALUES (?, 0, 'P', 'x', 0, 1, 1)",
  ).run(id);

  const stricter = { ...ctx, guard: createVaultGuard(vault, [...DEFAULT_IGNORES, 'Topics/**']) };
  expect(await syncVault(stricter)).toMatchObject({ excluded: 2, deleted: 0 });
  expect(statusOf('Topics/Photosynthesis.md')).toBe('excluded');
  expect(db.prepare('SELECT count(*) n FROM chunks WHERE note_id = ?').get(id)).toEqual({ n: 0 });

  expect(await syncVault(ctx)).toMatchObject({ changed: 2, added: 0 });
  expect(statusOf('Topics/Photosynthesis.md')).toBe('pending');
});

test('listNotes filters and sorts', async () => {
  await syncVault(ctx);
  const set = db.prepare('UPDATE notes SET tags = ?, frontmatter = ?, mtime = ? WHERE id = ?');
  set.run('["science/biology"]', '{"type":"concept"}', 100, noteId('Topics/Photosynthesis.md'));
  set.run('[]', '{"type":"concept"}', 200, noteId('Topics/Chlorophyll.md'));

  const base = { sort: 'title-asc' as const };
  expect(listNotes(db, wsId, { ...base, folder: 'Topics' }).map((n) => n.title)).toEqual(['Chlorophyll', 'Photosynthesis']);
  expect(listNotes(db, wsId, { ...base, tag: 'science/biology' }).map((n) => n.relPath)).toEqual(['Topics/Photosynthesis.md']);
  expect(listNotes(db, wsId, { ...base, type: 'concept', sort: 'modified-desc' }).map((n) => n.title)).toEqual(['Chlorophyll', 'Photosynthesis']);
  expect(listNotes(db, wsId, { ...base, query: 'chloro' })).toHaveLength(1);
  expect(listNotes(db, wsId, { ...base, status: 'indexed' })).toEqual([]);
  expect(listNotes(db, wsId, base)[0]).toMatchObject({ type: null });
});
