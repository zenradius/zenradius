'use strict';

const STALE_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STALE_READ_RETRIES = 3;

function recoverStaleTasks(db, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - STALE_TASK_TIMEOUT_MS).toISOString();
  const now = new Date(nowMs).toISOString();
  const retryable = db.prepare(
    `UPDATE acs_tasks
     SET status = CASE WHEN COALESCE(retry_count, 0) + 1 >= ? THEN 'failed' ELSE 'pending' END,
       result = ?, retry_count = COALESCE(retry_count, 0) + 1, updated_at = ?
     WHERE status = 'in_progress' AND updated_at < ?
       AND name IN ('getParameterValues', 'getParameterNames', 'refreshObject')`
  ).run(MAX_STALE_READ_RETRIES, JSON.stringify({ error: 'Task ACS timeout; read operation rescheduled' }), now, cutoff);
  const failed = db.prepare(
    `UPDATE acs_tasks
    SET status = 'failed', result = ?, retry_count = COALESCE(retry_count, 0) + 1, updated_at = ?
     WHERE status = 'in_progress' AND updated_at < ?
       AND name NOT IN ('getParameterValues', 'getParameterNames', 'refreshObject')`
  ).run(JSON.stringify({ error: 'Task ACS timeout; automatic replay is disabled for this operation' }), now, cutoff);

  return { retried: retryable.changes, failed: failed.changes };
}

module.exports = { recoverStaleTasks };
