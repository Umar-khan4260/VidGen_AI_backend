'use strict';

/**
 * Model availability endpoint.
 *
 * The Flutter client uses this to hide models that an admin disabled in the
 * admin panel. It is intentionally public and read-only: the response only
 * contains model ids, and the backend still enforces the policy on every
 * generation/chat request (so a modified client cannot bypass it).
 */

const modelPolicy = require('../services/model-policy.service');

const getModels = async (req, res) => {
  try {
    const disabled = await modelPolicy.getDisabledModels();
    return res.json({
      success: true,
      disabledModels: [...disabled],
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Fail open: a broken policy lookup must never stop the client from
    // showing its full model list.
    console.error('models: failed to load disabled model list:', error.message);
    return res.json({
      success: true,
      disabledModels: [],
      updatedAt: new Date().toISOString(),
    });
  }
};

module.exports = {
  getModels,
};
