'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const app = require('./src/app');
const GenerationService = require('./src/services/generation.service');
const { getFirestore } = require('firebase-admin/firestore');

const kieApiKey = defineSecret('KIE_API_KEY');

// 512MiB (not the 256MiB default): uploads are buffered in memory by multer
// before streaming to KIE, and a large reference video plus Express overhead
// can exceed 256MiB. Long timeout because KIE uploads/generations are slow.
exports.api = onRequest(
  {
    secrets: [kieApiKey],
    memory: '512MiB',
    timeoutSeconds: 900,
  },
  (req, res) => {
    app.locals.kieApiKey = kieApiKey.value();
    app(req, res);
  }
);

/**
 * Task settler — bills generation credits even when the client never polls
 * (app crashed / closed after createTask). Every 10 minutes it picks up
 * unsettled tasks older than 10 minutes, fetches their recordInfo and
 * settles the exact creditsConsumed (0 for failures, flat fallback when KIE
 * reports none). See generation.service.js settleTask.
 */
exports.settleTasks = onSchedule(
  {
    schedule: 'every 10 minutes',
    secrets: [kieApiKey],
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const service = new GenerationService(kieApiKey.value());

    // Only tasks older than 10 minutes — anything fresher is still being
    // polled live by the client.
    const cutoffDate = new Date(Date.now() - 10 * 60 * 1000);

    const pending = await db.collectionGroup('tasks')
      .where('settled', '==', false)
      .where('createdAt', '<', cutoffDate)
      .limit(100)
      .get();

    if (pending.empty) return null;

    console.log(`[settler] Settling ${pending.size} pending task(s)...`);
    for (const taskDoc of pending.docs) {
      try {
        await service.settlePendingTask(taskDoc);
      } catch (e) {
        // Individual failures (e.g. recordInfo 404 for a KIE-side purge) must
        // not stop the rest of the batch.
        console.error(`[settler] Failed to settle ${taskDoc.ref.path}:`, e.message);
      }
    }
    return null;
  }
);
