'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

// Import controllers
const { identifyUserHandler } = require('./src/controllers/user.controller');

// ============================================================
// Secrets
// ============================================================
const kieApiKey = defineSecret('KIE_API_KEY');

// ============================================================
// FUNCTION 1: identifyUser
// ============================================================
exports.identifyUser = onCall(identifyUserHandler);

// ============================================================
// FUNCTION 2: generateContent (Phase 3 - placeholder for now)
// ============================================================
exports.generateContent = onCall({ secrets: [kieApiKey] }, async (request) => {
  throw new HttpsError('unimplemented', 'generateContent will be implemented in Phase 3.');
});

// ============================================================
// FUNCTION 3: getTaskStatus (Phase 3 - placeholder for now)
// ============================================================
exports.getTaskStatus = onCall({ secrets: [kieApiKey] }, async (request) => {
  throw new HttpsError('unimplemented', 'getTaskStatus will be implemented in Phase 3.');
});

// ============================================================
// FUNCTION 4: verifyPurchase (Phase 6 - placeholder for now)
// ============================================================
exports.verifyPurchase = onCall(async (request) => {
  throw new HttpsError('unimplemented', 'verifyPurchase will be implemented in Phase 6.');
});
