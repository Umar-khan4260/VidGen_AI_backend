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

// Inject KIE_API_KEY from environment into app.locals so controllers can access it
// the same way they do in Firebase Functions (req.app.locals.kieApiKey)
app.locals.kieApiKey = process.env.KIE_API_KEY || '';

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`VidGen AI backend running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  if (!app.locals.kieApiKey) {
    console.warn('WARNING: KIE_API_KEY is not set. Generation endpoints will fail.');
  }
});
