import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
