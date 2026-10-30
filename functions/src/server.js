'use strict';

/**
 * server.js — Docker / local development entry point.
 *
 * This file is used ONLY when running in Docker or locally with `node src/server.js`.
 * Firebase Cloud Functions use `index.js` instead, which wraps `app.js` in onRequest().
 *
 * Environment variables (set in docker-compose.yml or .env):
 *   PORT          — port to listen on (default: 8080)
 *   KIE_API_KEY   — KIE platform API key (use Firebase Secret Manager in production)
 *   NODE_ENV      — 'production' | 'development'
 */

const path = require('path');

// Load backend/.env (one level above the functions folder).
// No-op when the file is missing (e.g. inside Docker, where compose injects
// the variables directly via `environment` / `env_file`).
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = require('./app');
const { startSettlementCron } = require('./cron/settle.cron');

// Inject KIE_API_KEY from environment into app.locals so controllers can access it
// the same way they do in Firebase Functions (req.app.locals.kieApiKey)
app.locals.kieApiKey = process.env.KIE_API_KEY || '';

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
  console.log(`VidGen AI backend running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  if (!app.locals.kieApiKey) {
    console.warn('WARNING: KIE_API_KEY is not set. Generation endpoints will fail.');
  } else {
    // VPS/Docker billing settler (Firebase deployments use the scheduled
    // function in index.js instead).
    startSettlementCron(app.locals.kieApiKey);
  }
});

// Node 18+ kills requests whose body takes longer than 5 minutes to arrive
// (requestTimeout default 300000). KIE uploads of large videos legitimately
// take 15-40 minutes through this proxy, so disable it; headersTimeout stays
// on so slowloris-style header attacks are still cut off.
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
// Sit above nginx's default keepalive (60s) so the proxy's idle connections
// don't race our socket reuse.
server.keepAliveTimeout = 65 * 1000;
