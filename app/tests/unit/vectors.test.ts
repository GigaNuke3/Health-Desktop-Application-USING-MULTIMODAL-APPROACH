import { beforeEach, expect, test } from 'vitest';
import { openDatabase } from '../../src/service/db/connection';
import { loadMigrations, migrate } from '../../src/service/db/migrate';
import { deleteNoteIndex } from '../../src/service/db/notes';
import {
  deleteVectors,
  ensureVectorTable,
  insertVectors,
  knn,
  upsertEmbeddingModel,
} from '../../src/service/db/vectors';
import { createWorkspace } from '../../src/service/db/workspaces';
import { FakeEmbeddingProvider } from '../../src/service/providers/fake';

let db: ReturnType<typeof openDatabase>;

const model = (name = 'test-embed', dimensions = 4, digest = 'd1') =>
  upsertEmbeddingModel(db, { provider: 'fake', name, dimensions, digest });

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db, loadMigrations());
});

test('knn is restricted to the workspace and ordered by distance', () => {
  const m = model();
  ensureVectorTable(db, m);
  insertVectors(db, m, [
    { chunkId: 1, workspaceId: 1, vector: [1, 0, 0, 0] },
    { chunkId: 2, workspaceId: 1, vector: [0.7, 0.7, 0, 0] },
    { chunkId: 3, workspaceId: 2, vector: [1, 0, 0, 0] },
  ]);
  const hits = knn(db, m, 1, [1, 0, 0, 0], 5);
  expect(hits.map((h) => h.chunkId)).toEqual([1, 2]);
  expect(hits[0].distance).toBeCloseTo(0, 5);
  for (const h of hits) {
    expect(h.distance).toBeGreaterThanOrEqual(0);
    expect(h.distance).toBeLessThanOrEqual(2);
  }
  expect(hits[0].distance).toBeLessThan(hits[1].distance);
});

test('deleteVectors removes rows from every vector table', () => {
  const a = model('model-a', 4);
  const b = model('model-b', 3);
  ensureVectorTable(db, a);
  ensureVectorTable(db, b);
  insertVectors(db, a, [{ chunkId: 1, workspaceId: 1, vector: [1, 0, 0, 0] }]);
  insertVectors(db, b, [{ chunkId: 1, workspaceId: 1, vector: [1, 0, 0] }]);
  deleteVectors(db, [1]);
  expect(knn(db, a, 1, [1, 0, 0, 0], 5)).toEqual([]);
  expect(knn(db, b, 1, [1, 0, 0], 5)).toEqual([]);
  expect(() => deleteVectors(db, [])).not.toThrow();
});

test('a vector of the wrong length is a DIMENSION_MISMATCH', () => {
  const m = model();
  ensureVectorTable(db, m);
  expect(() => insertVectors(db, m, [{ chunkId: 1, workspaceId: 1, vector: [1, 0] }])).toThrow(
    expect.objectContaining({ code: 'DIMENSION_MISMATCH' }),
  );
});

test('upsertEmbeddingModel is idempotent, and a new digest is a new model', () => {
  const first = model();
  expect(model().id).toBe(first.id);
  expect(model('test-embed', 4, 'd2').id).not.toBe(first.id);
  expect(first.table).toBe('vec_test_embed_4');
});

test('deleteNoteIndex removes the note’s vectors with its chunks', () => {
  const ws = createWorkspace(db, { name: 'W', vaultRoot: '/v' });
  db.prepare(
    "INSERT INTO notes (id, workspace_id, rel_path, title, mtime, size, content_hash) VALUES ('n1', ?, 'a.md', 'a', 0, 0, 'h')",
  ).run(ws.id);
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO chunks (note_id, ordinal, heading_path, text, char_start, char_end, token_estimate) VALUES ('n1', 0, 'a', 'x', 0, 1, 1)",
    )
    .run();
  const m = model();
  ensureVectorTable(db, m);
  insertVectors(db, m, [{ chunkId: Number(lastInsertRowid), workspaceId: ws.id, vector: [1, 0, 0, 0] }]);
  deleteNoteIndex(db, 'n1');
  expect(knn(db, m, ws.id, [1, 0, 0, 0], 5)).toEqual([]);
  expect(db.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 0 });
});

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

test('fake embeddings: shared words are closer than unrelated ones', async () => {
  const f = new FakeEmbeddingProvider();
  const [a, b, c] = await f.embed(
    [
      'search_document: chlorophyll absorbs light',
      'search_query: what absorbs light',
      'search_document: tax law',
    ],
    { model: 'fake' },
  );
  expect(a).toHaveLength(64);
  expect(cos(a, b)).toBeGreaterThan(cos(a, c));
});

test('fake embeddings ignore the document header line', async () => {
  const f = new FakeEmbeddingProvider();
  const [withHeader, bare] = await f.embed(
    ['search_document: Some Title › Some Heading\n\nchlorophyll absorbs light', 'search_document: chlorophyll absorbs light'],
    { model: 'fake' },
  );
  expect(withHeader).toEqual(bare);
});
