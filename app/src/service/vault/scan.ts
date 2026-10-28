import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppException } from '../../shared/result';
import type { VaultGuard } from './guard';

export interface FileStat {
  relPath: string;
  mtimeMs: number;
  size: number;
}

export interface KnownNote {
  id: string;
  relPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  status: string;
}

type Hashed = FileStat & { hash: string };

export interface ScanDiff {
  added: Hashed[];
  changed: (Hashed & { noteId: string })[];
  renamed: { noteId: string; from: string; to: Hashed }[];
  touched: { noteId: string; mtimeMs: number; size: number }[];
  deleted: { noteId: string }[];
  excluded: { noteId: string }[];
}

export async function hashFile(absPath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(absPath))
    .digest('hex');
}

export async function scanVault(guard: VaultGuard): Promise<FileStat[]> {
  // Check the root first so a missing or unmounted vault throws before anything is compared.
  try {
    if (!(await fs.stat(guard.root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new AppException(
      'VAULT_NOT_FOUND',
      'Vault folder not found',
      'Check that the folder exists and any drive holding it is mounted.',
    );
  }

  let entries;
  try {
    entries = await fs.readdir(guard.root, { recursive: true, withFileTypes: true });
  } catch {
    throw new AppException('VAULT_NOT_FOUND', 'Vault folder could not be read');
  }

  const found: FileStat[] = [];
  for (const e of entries) {
    if (!e.name.endsWith('.md') || !(e.isFile() || e.isSymbolicLink())) continue;
    const relPath = path.relative(guard.root, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (guard.isIgnored(relPath)) continue;
    try {
      // resolve() refuses symlinks that leave the vault; a file that vanished mid-scan is just skipped.
      const st = await fs.stat(await guard.resolve(relPath));
      if (st.isFile()) found.push({ relPath, mtimeMs: Math.trunc(st.mtimeMs), size: st.size });
    } catch {
      continue;
    }
  }
  return found;
}

export async function diffScan(
  known: KnownNote[],
  found: FileStat[],
  hashOf: (relPath: string) => Promise<string>,
  isIgnored: (relPath: string) => boolean,
): Promise<ScanDiff> {
  const diff: ScanDiff = { added: [], changed: [], renamed: [], touched: [], deleted: [], excluded: [] };
  const byPath = new Map(known.map((k) => [k.relPath, k]));
  const foundPaths = new Set(found.map((f) => f.relPath));
  const isGone = (k: KnownNote) => k.status === 'deleted' || k.status === 'excluded';

  const unmatched: Hashed[] = [];
  for (const f of found) {
    if (isIgnored(f.relPath)) continue;
    const k = byPath.get(f.relPath);
    if (!k) {
      unmatched.push({ ...f, hash: await hashOf(f.relPath) });
    } else if (isGone(k)) {
      diff.changed.push({ ...f, hash: await hashOf(f.relPath), noteId: k.id }); // reappeared: needs indexing
    } else if (k.mtimeMs !== f.mtimeMs || k.size !== f.size) {
      const hash = await hashOf(f.relPath);
      if (hash === k.hash) diff.touched.push({ noteId: k.id, mtimeMs: f.mtimeMs, size: f.size });
      else diff.changed.push({ ...f, hash, noteId: k.id });
    }
  }

  // Live notes that are no longer found: newly ignored → excluded, otherwise deleted unless renamed.
  const vanished: KnownNote[] = [];
  for (const k of known) {
    if (isGone(k)) continue;
    if (isIgnored(k.relPath)) diff.excluded.push({ noteId: k.id });
    else if (!foundPaths.has(k.relPath)) vanished.push(k);
  }

  for (const f of unmatched) {
    const i = vanished.findIndex((k) => k.hash === f.hash);
    if (i < 0) {
      diff.added.push(f);
    } else {
      diff.renamed.push({ noteId: vanished[i].id, from: vanished[i].relPath, to: f });
      vanished.splice(i, 1);
    }
  }
  diff.deleted.push(...vanished.map((k) => ({ noteId: k.id })));
  return diff;
}
