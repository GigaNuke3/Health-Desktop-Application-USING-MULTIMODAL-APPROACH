import type Database from 'better-sqlite3';
import { applyScanDiff, knownNotes } from '../db/notes';
import type { VaultGuard } from './guard';
import { diffScan, hashFile, scanVault } from './scan';

export interface SyncResult {
  added: number;
  changed: number;
  renamed: number;
  deleted: number;
  excluded: number;
}

// scan → diff → apply. scanVault throws VAULT_NOT_FOUND first, so a missing vault never reaches the diff.
export async function syncVault(ctx: {
  db: Database.Database;
  guard: VaultGuard;
  workspaceId: number;
}): Promise<SyncResult> {
  const { db, guard, workspaceId } = ctx;
  const found = await scanVault(guard);
  const diff = await diffScan(
    knownNotes(db, workspaceId),
    found,
    async (relPath) => hashFile(await guard.resolve(relPath)),
    guard.isIgnored,
  );
  applyScanDiff(db, workspaceId, diff);
  return {
    added: diff.added.length,
    changed: diff.changed.length,
    renamed: diff.renamed.length,
    deleted: diff.deleted.length,
    excluded: diff.excluded.length,
  };
}
