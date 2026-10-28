import { expect, test, vi } from 'vitest';
import { diffScan, type KnownNote } from '../../src/service/vault/scan';

const k = (id: string, relPath: string, hash: string, extra: Partial<KnownNote> = {}): KnownNote => ({
  id,
  relPath,
  mtimeMs: 1,
  size: 10,
  hash,
  status: 'indexed',
  ...extra,
});
const stat = (relPath: string, mtimeMs = 1, size = 10) => ({ relPath, mtimeMs, size });
const never = () => false;

test('unchanged mtime/size never hashes', async () => {
  const hashOf = vi.fn();
  const d = await diffScan([k('n1', 'a.md', 'h')], [stat('a.md')], hashOf, never);
  expect(hashOf).not.toHaveBeenCalled();
  expect(d).toEqual({ added: [], changed: [], renamed: [], touched: [], deleted: [], excluded: [] });
});

test('same hash after touch is touched, not changed', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [stat('a.md', 2)], async () => 'h', never);
  expect(d.touched).toEqual([{ noteId: 'n1', mtimeMs: 2, size: 10 }]);
  expect(d.changed).toEqual([]);
});

test('different hash is changed', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [stat('a.md', 2)], async () => 'new', never);
  expect(d.changed).toEqual([{ noteId: 'n1', relPath: 'a.md', mtimeMs: 2, size: 10, hash: 'new' }]);
});

test('new file is added with its hash', async () => {
  const d = await diffScan([], [stat('a.md')], async () => 'h', never);
  expect(d.added).toEqual([{ relPath: 'a.md', mtimeMs: 1, size: 10, hash: 'h' }]);
});

test('rename keeps the note id', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [stat('b.md')], async () => 'h', never);
  expect(d.renamed).toEqual([expect.objectContaining({ noteId: 'n1', from: 'a.md' })]);
  expect(d.added).toEqual([]);
  expect(d.deleted).toEqual([]);
});

test('missing file is deleted', async () => {
  const d = await diffScan([k('n1', 'a.md', 'h')], [], async () => 'h', never);
  expect(d.deleted).toEqual([{ noteId: 'n1' }]);
});

test('newly ignored is excluded, not deleted', async () => {
  const d = await diffScan([k('n1', 'reports/a.md', 'h')], [], async () => 'h', (p) =>
    p.startsWith('reports/'),
  );
  expect(d.excluded).toEqual([{ noteId: 'n1' }]);
  expect(d.deleted).toEqual([]);
});

test('deleted and excluded notes that reappear count as changed; already-gone ones stay quiet', async () => {
  const known = [
    k('n1', 'a.md', 'h', { status: 'deleted' }),
    k('n2', 'b.md', 'h2', { status: 'excluded' }),
    k('n3', 'c.md', 'h3', { status: 'deleted' }),
  ];
  const d = await diffScan(known, [stat('a.md'), stat('b.md')], async () => 'h', never);
  expect(d.changed.map((c) => c.noteId).sort()).toEqual(['n1', 'n2']);
  expect(d.deleted).toEqual([]);
  expect(d.excluded).toEqual([]);
});
