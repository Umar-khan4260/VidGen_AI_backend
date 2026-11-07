'use strict';

/**
 * Model availability policy.
 *
 * The admin panel writes the ids of disabled models to
 * `admin/config.disabledModels`. This service enforces that list on every
 * generation and chat request.
 *
 * Design notes:
 *  - The list is cached briefly so a busy chat endpoint does not hit Firestore
 *    on every request. A toggle therefore takes effect within TTL_MS.
 *  - A Firestore failure NEVER blocks generation: we log it and fail open, so
 *    a policy lookup outage cannot take the product down.
 *  - An empty list (the default) means every model is allowed.
 */

const { db } = require('../config/firebase');

const CACHE_TTL_MS = 30 * 1000;

let cachedDisabled = new Set();
let cacheLoadedAt = 0;

function normalizeDisabled(raw) {
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

async function getDisabledModels() {
  const now = Date.now();
  if (cacheLoadedAt && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedDisabled;
  }

  try {
    const snapshot = await db.collection('admin').doc('config').get();
    cachedDisabled = normalizeDisabled(snapshot.exists ? snapshot.data().disabledModels : []);
  } catch (error) {
    console.error(
      'model-policy: could not load admin/config.disabledModels (failing open):',
      error.message
    );
    // Keep the last known good list and back off instead of retrying on
    // every request during an outage.
  }

  cacheLoadedAt = now;
  return cachedDisabled;
}

/**
 * Throw a `permission-denied` error when `model` is disabled by the admin.
 * Unknown / missing model ids are ignored here — the KIE call will reject
 * them and the existing validation paths handle that.
 */
async function assertModelEnabled(model) {
  if (!model || typeof model !== 'string') return;

  const disabled = await getDisabledModels();
  if (disabled.has(model)) {
    const error = new Error(
      'This model is currently unavailable. Please choose a different model.'
    );
    error.code = 'permission-denied';
    throw error;
  }
}

/** Drop the cache (used by tests or by a future admin endpoint in-process). */
function invalidateCache() {
  cacheLoadedAt = 0;
}

/**
 * Resolve the model id for a chat request.
 *
 * Most chat payloads carry `model`, but the GPT-5.2 payload does not — the
 * model is only present in the endpoint path (`/gpt-5-2/v1/chat/completions`).
 * Fall back to the first path segment when it looks like a model id rather
 * than a provider prefix (e.g. `/grok/v1/responses`).
 */
function resolveModelId(payloadModel, endpoint) {
  if (payloadModel && typeof payloadModel === 'string') return payloadModel;
  if (typeof endpoint !== 'string') return '';

  const match = endpoint.match(/^\/([^/]+)\//);
  if (!match) return '';

  const segment = match[1];
  return segment.includes('-') || segment.includes('.') ? segment : '';
}

module.exports = {
  assertModelEnabled,
  getDisabledModels,
  invalidateCache,
  resolveModelId,
};
