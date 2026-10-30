'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const app = require('./src/app');
const GenerationService = require('./src/services/generation.service');
const { runSettlementPass } = require('./src/services/task.settler');

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
 * (app crashed / closed after createTask). Firebase-hosted scheduler; the
 * VPS/Docker deployment uses node-cron in src/cron/settle.cron.js with the
 * same shared pass (task.settler.js) — running both at once is safe because
 * settlement is exactly-once per task.
 */
exports.settleTasks = onSchedule(
  {
    schedule: 'every 10 minutes',
    secrets: [kieApiKey],
    timeoutSeconds: 540,
  },
  async () => {
    const service = new GenerationService(kieApiKey.value());
    await runSettlementPass(service);
    return null;
  }
);
