import type Database from 'better-sqlite3';
import { AppException } from '../../shared/result';

export interface EmbeddingModelRow {
  id: number;
  provider: string;
  name: string;
  dimensions: number;
  digest: string;
  table: string;
}

// The name is reduced to [A-Za-z0-9_], so it is safe to splice into SQL.
const tableName = (name: string, dimensions: number) =>
  `vec_${name.replace(/[^a-zA-Z0-9]/g, '_')}_${dimensions}`;

export function upsertEmbeddingModel(
  db: Database.Database,
  m: { provider: string; name: string; dimensions: number; digest: string },
): EmbeddingModelRow {
  let row = db
    .prepare(
      'SELECT id FROM embedding_models WHERE provider = ? AND name = ? AND dimensions = ? AND digest = ?',
    )
    .get(m.provider, m.name, m.dimensions, m.digest) as { id: number } | undefined;
  if (!row) {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO embedding_models (provider, name, dimensions, digest) VALUES (?, ?, ?, ?)')
      .run(m.provider, m.name, m.dimensions, m.digest);
    row = { id: Number(lastInsertRowid) };
  }
  return { id: row.id, ...m, table: tableName(m.name, m.dimensions) };
}

export function ensureVectorTable(db: Database.Database, m: EmbeddingModelRow): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${m.table} USING vec0(chunk_id integer primary key, workspace_id integer partition key, embedding float[${m.dimensions}] distance_metric=cosine)`,
  );
}

// better-sqlite3 binds JS numbers as REAL, but vec0 needs integer keys, hence the BigInts.
export function insertVectors(
  db: Database.Database,
  m: EmbeddingModelRow,
  rows: { chunkId: number; workspaceId: number; vector: number[] }[],
): void {
  const insert = db.prepare(`INSERT INTO ${m.table} (chunk_id, workspace_id, embedding) VALUES (?, ?, ?)`);
  db.transaction(() => {
    for (const r of rows) {
      if (r.vector.length !== m.dimensions) {
        throw new AppException(
          'DIMENSION_MISMATCH',
          `Embedding has ${r.vector.length} dimensions, expected ${m.dimensions}`,
          'The embedding model may have changed. Use Re-embed all.',
        );
      }
      insert.run(BigInt(r.chunkId), BigInt(r.workspaceId), new Float32Array(r.vector));
    }
  })();
}

export function deleteVectors(db: Database.Database, chunkIds: number[]): void {
  if (!chunkIds.length) return;
  // Shadow tables are plain tables; only the vec0 virtual tables match.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING vec0%'")
    .all() as { name: string }[];
  db.transaction(() => {
    for (const { name } of tables) {
      const del = db.prepare(`DELETE FROM ${name} WHERE chunk_id = ?`);
      for (const id of chunkIds) del.run(BigInt(id));
    }
  })();
}

export function knn(
  db: Database.Database,
  m: EmbeddingModelRow,
  workspaceId: number,
  query: number[],
  k: number,
): { chunkId: number; distance: number }[] {
  const rows = db
    .prepare(
      `SELECT chunk_id, distance FROM ${m.table} WHERE embedding MATCH ? AND k = ? AND workspace_id = ? ORDER BY distance`,
    )
    .all(new Float32Array(query), BigInt(k), BigInt(workspaceId)) as { chunk_id: number | bigint; distance: number }[];
  return rows.map((r) => ({ chunkId: Number(r.chunk_id), distance: r.distance }));
}
