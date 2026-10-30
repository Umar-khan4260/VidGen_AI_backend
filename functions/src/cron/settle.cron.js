'use strict';

const cron = require('node-cron');
const GenerationService = require('../services/generation.service');
const { runSettlementPass } = require('../services/task.settler');

/**
 * Start the in-process task settlement loop for VPS/Docker deployments
 * (Firebase deployments use the scheduled function in functions/index.js
 * instead). Runs the settlement pass every 10 minutes in this same process —
 * no external crontab needed.
 */
function startSettlementCron(kieApiKey) {
  const service = new GenerationService(kieApiKey);

  cron.schedule('*/10 * * * *', async () => {
    try {
      await runSettlementPass(service);
    } catch (e) {
      console.error('[settler] Cron pass failed:', e.message);
    }
  });

  console.log('[settler] In-process settlement cron started (every 10 minutes)');
}

module.exports = { startSettlementCron };
