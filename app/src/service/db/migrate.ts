import type Database from 'better-sqlite3';
import { AppException } from '../../shared/result';

export type Migration = { version: number; sql: string };

export function loadMigrations(): Migration[] {
  const files = import.meta.glob('./migrations/*.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  return Object.entries(files)
    .map(([file, sql]) => ({ version: parseInt(file.split('/').pop()!, 10), sql }))
    .sort((a, b) => a.version - b.version);
}

export function migrate(db: Database.Database, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const { v: current } = db
    .prepare('SELECT COALESCE(max(version), 0) AS v FROM schema_migrations')
    .get() as { v: number };
  const latest = Math.max(0, ...migrations.map((m) => m.version));
  if (current > latest) {
    throw new AppException(
      'DB_NEWER_THAN_APP',
      `Database schema version ${current} is newer than this app supports (${latest})`,
      'Update the app, or restore the database from a backup.',
    );
  }

  const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted.filter((m) => m.version > current)) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version);
    })();
  }
}
