'use strict';

const { getFirestore } = require('firebase-admin/firestore');

/**
 * One settlement pass: finds generation tasks the client never polled
 * (app crashed / closed after createTask), fetches their recordInfo from
 * KIE and settles the exact creditsConsumed.
 *
 * Shared by both hosts:
 *  - Firebase deployment: scheduled function in functions/index.js
 *  - VPS/Docker deployment: node-cron loop in src/cron/settle.cron.js
 *
 * Running on BOTH hosts simultaneously is safe — settlement is exactly-once
 * per task (generation.service.js settleTask claims it via a transactional
 * `settled` flag), so no double billing is possible.
 */
async function runSettlementPass(
  service,
  { maxTasks = 100, olderThanMs = 10 * 60 * 1000 } = {}
) {
  const db = getFirestore();
  // Only tasks older than 10 minutes — anything fresher is still being
  // polled live by the client.
  const cutoffDate = new Date(Date.now() - olderThanMs);

  const pending = await db.collectionGroup('tasks')
    .where('settled', '==', false)
    .where('createdAt', '<', cutoffDate)
    .limit(maxTasks)
    .get();

  if (pending.empty) return 0;

  console.log(`[settler] Settling ${pending.size} pending task(s)...`);
  let settledCount = 0;
  for (const taskDoc of pending.docs) {
    try {
      await service.settlePendingTask(taskDoc);
      settledCount += 1;
    } catch (e) {
      // Individual failures (e.g. recordInfo 404 for a KIE-side purge) must
      // not stop the rest of the batch.
      console.error(`[settler] Failed to settle ${taskDoc.ref.path}:`, e.message);
    }
  }
  return settledCount;
}

module.exports = { runSettlementPass };
