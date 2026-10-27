'use strict';

/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Good enough to blunt brute-force / abuse on a single instance (Docker,
 * Cloud Run with maxInstances=1). For multi-instance deployments swap the
 * `hits` Map for Redis/Firestore — the interface stays the same.
 */
const hits = new Map();

// Periodically drop expired windows so the map cannot grow unbounded.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now) {
  for (const [key, entry] of hits) {
    if (entry.resetAt <= now) hits.delete(key);
  }
}

module.exports = function rateLimit({ windowMs = 60 * 1000, max = 30 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      sweep(now);
      lastSweep = now;
    }

    const key = (req.auth && req.auth.uid) || req.ip || 'anonymous';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
};
