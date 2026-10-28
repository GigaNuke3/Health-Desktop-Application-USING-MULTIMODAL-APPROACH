import type Database from 'better-sqlite3';
import type { Settings } from '../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  ollamaEndpoint: 'http://127.0.0.1:11434',
  chatModel: 'qwen2.5:3b',
  embeddingModel: 'nomic-embed-text',
  temperature: 0.2,
  maxDistance: 0.55,
};

// The settings table is a general JSON key/value store (activeWorkspaceId lives there too).
export function readSetting<T>(db: Database.Database, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function writeSetting(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

export function getSettings(db: Database.Database): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const stored = readSetting<Settings[typeof key]>(db, key);
    if (stored !== undefined) (settings as Record<string, unknown>)[key] = stored;
  }
  return settings;
}

export function updateSettings(db: Database.Database, patch: Partial<Settings>): Settings {
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key in DEFAULT_SETTINGS) writeSetting(db, key, value);
    }
  })();
  return getSettings(db);
}
