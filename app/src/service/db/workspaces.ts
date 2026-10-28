import type Database from 'better-sqlite3';
import { AppException } from '../../shared/result';
import type { Workspace } from '../../shared/types';
import { DEFAULT_IGNORES } from '../vault/guard';
import { readSetting, writeSetting } from './settings';

export const HEALTH_GUIDELINES =
  "Keep general medical research separate from documented personal health records, and say which one each statement comes from. Never diagnose. For questions about the user's individual health, recommend review by a healthcare professional.";

type Row = {
  id: number;
  name: string;
  vault_root: string;
  ignore_patterns: string;
  answer_guidelines: string;
};

const toWorkspace = (r: Row): Workspace => ({
  id: r.id,
  name: r.name,
  vaultRoot: r.vault_root,
  ignorePatterns: JSON.parse(r.ignore_patterns) as string[],
  answerGuidelines: r.answer_guidelines,
});

function getWorkspace(db: Database.Database, id: number): Workspace {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new AppException('NOT_FOUND', 'Workspace not found');
  return toWorkspace(row);
}

export function createWorkspace(
  db: Database.Database,
  input: { name: string; vaultRoot: string },
): Workspace {
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO workspaces (name, vault_root, ignore_patterns, answer_guidelines) VALUES (?, ?, ?, ?)',
    )
    .run(
      input.name,
      input.vaultRoot,
      JSON.stringify(DEFAULT_IGNORES),
      input.name === 'Health' ? HEALTH_GUIDELINES : '',
    );
  return getWorkspace(db, Number(lastInsertRowid));
}

export function setActiveWorkspace(db: Database.Database, id: number): void {
  writeSetting(db, 'activeWorkspaceId', id);
}

export function getActiveWorkspace(db: Database.Database): Workspace | null {
  const id = readSetting<number>(db, 'activeWorkspaceId');
  return id === undefined ? null : getWorkspace(db, id);
}

export function updateWorkspace(
  db: Database.Database,
  id: number,
  patch: { answerGuidelines?: string; ignorePatterns?: string[] },
): Workspace {
  getWorkspace(db, id); // NOT_FOUND before writing anything
  if (patch.answerGuidelines !== undefined) {
    db.prepare('UPDATE workspaces SET answer_guidelines = ? WHERE id = ?').run(patch.answerGuidelines, id);
  }
  if (patch.ignorePatterns !== undefined) {
    db.prepare('UPDATE workspaces SET ignore_patterns = ? WHERE id = ?').run(
      JSON.stringify(patch.ignorePatterns),
      id,
    );
  }
  return getWorkspace(db, id);
}
