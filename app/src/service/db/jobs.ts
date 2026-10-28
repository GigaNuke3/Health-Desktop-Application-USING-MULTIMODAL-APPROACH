import type Database from 'better-sqlite3';

export interface Job {
  id: number;
  kind: string;
  noteId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error: string | null;
}

export type JobOutcome =
  | { status: 'done' }
  | { status: 'failed'; error: string; countAttempt: boolean }
  | { status: 'queued'; countAttempt: boolean };

type Row = { id: number; kind: string; note_id: string; status: Job['status']; attempts: number; error: string | null };

const toJob = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  noteId: r.note_id,
  status: r.status,
  attempts: r.attempts,
  error: r.error,
});

const now = () => new Date().toISOString();

// OR IGNORE: the partial unique index allows only one queued job per note, so a second enqueue is a no-op.
export function enqueueIndex(db: Database.Database, noteId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO jobs (kind, note_id, status, created_at, updated_at) VALUES ('index', ?, 'queued', ?, ?)",
  ).run(noteId, now(), now());
}

export function claimNextJob(db: Database.Database): Job | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as
      | Row
      | undefined;
    if (!row) return null;
    db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now(), row.id);
    return toJob({ ...row, status: 'running' });
  })();
}

export function finishJob(db: Database.Database, id: number, outcome: JobOutcome): void {
  db.transaction(() => {
    let status: Job['status'] = outcome.status;
    // Re-queueing while a newer queued job for the same note exists would break the unique index;
    // that newer job already covers the latest content.
    if (outcome.status === 'queued') {
      const superseded = db
        .prepare(
          "SELECT 1 FROM jobs WHERE status = 'queued' AND note_id = (SELECT note_id FROM jobs WHERE id = ?)",
        )
        .get(id);
      if (superseded) status = 'done';
    }
    const attempt = outcome.status !== 'done' && outcome.countAttempt ? 1 : 0;
    const error = outcome.status === 'failed' ? outcome.error : null;
    db.prepare('UPDATE jobs SET status = ?, attempts = attempts + ?, error = ?, updated_at = ? WHERE id = ?').run(
      status,
      attempt,
      error,
      now(),
      id,
    );
  })();
}

// On service start: jobs interrupted mid-run go back to the queue.
export function requeueRunning(db: Database.Database): number {
  return db.transaction(() => {
    db.prepare(
      "UPDATE jobs SET status = 'done', updated_at = ? WHERE status = 'running' AND note_id IN (SELECT note_id FROM jobs WHERE status = 'queued')",
    ).run(now());
    return db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now()).changes;
  })();
}

export function jobCounts(
  db: Database.Database,
  workspaceId: number,
): { queued: number; running: number; done: number; failed: number } {
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  const rows = db
    .prepare(
      'SELECT j.status AS status, count(*) AS n FROM jobs j JOIN notes n ON n.id = j.note_id WHERE n.workspace_id = ? GROUP BY j.status',
    )
    .all(workspaceId) as { status: keyof typeof counts; n: number }[];
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}
