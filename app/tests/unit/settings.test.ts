import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { openDatabase } from '../../src/service/db/connection';
import { loadMigrations, migrate } from '../../src/service/db/migrate';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../../src/service/db/settings';

test('defaults then update, and the update survives reopening the file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, 'brain.db');
  try {
    const db = openDatabase(file);
    migrate(db, loadMigrations());
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
    expect(updateSettings(db, { temperature: 0.5 })).toEqual({ ...DEFAULT_SETTINGS, temperature: 0.5 });
    db.close();

    const reopened = openDatabase(file);
    expect(getSettings(reopened).temperature).toBe(0.5);
    reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('other keys in the settings table never leak into Settings', () => {
  const db = openDatabase(':memory:');
  migrate(db, loadMigrations());
  db.prepare("INSERT INTO settings (key, value) VALUES ('activeWorkspaceId', '1')").run();
  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
});
