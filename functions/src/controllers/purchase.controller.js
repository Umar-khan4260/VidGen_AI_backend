'use strict';

const { db, FieldValue } = require('../config/firebase');
const userService = require('../services/user.service');
const https = require('https');
const jwt = require('jsonwebtoken');

/** Product ids must exactly match App Store Connect (see
 * subscription_models.dart). Credits per product mirror SubscriptionTier.credits. */
const PRODUCTS = {
  'com.vidgen.subscription.weekly':  { tier: 'weekly',   credits: 500,  days: 7    },
  'com.vidgen.subscription.monthly': { tier: 'monthly',  credits: 2000, days: 30   },
  'com.vidgen.credits.pack.7500':    { tier: 'lifetime', credits: 7500, days: null },
};

// ---------------------------------------------------------------------------
// Apple App Store Server API v2 — Transaction verification
// ---------------------------------------------------------------------------
// Required environment variables (set in .env or Firebase Functions config):
//   APPLE_ISSUER_ID   — Issuer ID (App Store Connect → Users & Access → Keys)
//   APPLE_KEY_ID      — Key ID of your App Store Connect API key (.p8 file)
//   APPLE_PRIVATE_KEY — Full PEM content of the .p8 key (ES256). Literal \n
//                       must be used for newlines in the env value, e.g.:
//                       "-----BEGIN PRIVATE KEY-----\nABC...\n-----END PRIVATE KEY-----"
//   APPLE_BUNDLE_ID   — Your app bundle ID: com.vidgen
//
// Verification strategy:
//   • Try production endpoint first.
//   • If Apple returns errorCode 4290001 (transaction not in production),
//     retry automatically against the sandbox endpoint.

const APPLE_PROD_HOST = 'api.storekit.itunes.apple.com';
const APPLE_SBX_HOST  = 'api.storekit-sandbox.itunes.apple.com';

/**
 * Build a signed ES256 JWT for the App Store Server API.
 * Apple expects this in the Authorization header as a Bearer token.
 */
function _buildAppleJWT() {
  const issuerId   = process.env.APPLE_ISSUER_ID;
  const keyId      = process.env.APPLE_KEY_ID;
  const privateKey = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!issuerId || !keyId || !privateKey) {
    throw new Error('Apple App Store Server API credentials are not fully configured.');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 60,                   // 60-second window — enough for one request
    aud: 'appstoreconnect-v1',
    bid: process.env.APPLE_BUNDLE_ID,
  };

  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
  });
}

/**
 * GET /inApps/v2/transactions/{transactionId} from one Apple host.
 * Returns { statusCode, body } where body is parsed JSON.
 */
function _appleGet(host, transactionId, appleJWT) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path:     `/inApps/v2/transactions/${encodeURIComponent(transactionId)}`,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${appleJWT}`,
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ statusCode: res.statusCode, body: {} }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Apple API request timed out')));
    req.end();
  });
}

/**
 * Verify a transactionId with the Apple App Store Server API v2.
 *
 * Returns:
 *   { verified: true,  environment, productId, bundleId }  — success
 *   { verified: false, reason }                             — failure / not configured
 *
 * The signed JWS transaction payload is decoded (not signature-verified on
 * our side) — Apple issued it over HTTPS with our private API key, so we
 * trust it. We do cross-check productId and bundleId against expectations.
 */
async function verifyWithAppStore(transactionId, expectedProductId) {
  const configured = Boolean(
    process.env.APPLE_ISSUER_ID  &&
    process.env.APPLE_KEY_ID     &&
    process.env.APPLE_PRIVATE_KEY &&
    process.env.APPLE_BUNDLE_ID
  );

  if (!configured) {
    return { verified: false, reason: 'app-store-credentials-not-configured' };
  }

  // Build JWT — fail fast if key is malformed
  let appleJWT;
  try {
    appleJWT = _buildAppleJWT();
  } catch (err) {
    console.error('[purchase] Failed to build Apple JWT:', err.message);
    return { verified: false, reason: `jwt-build-failed: ${err.message}` };
  }

  // 1️⃣  Try production first
  let result = await _appleGet(APPLE_PROD_HOST, transactionId, appleJWT);

  // 2️⃣  If Apple says the receipt is from sandbox, retry on sandbox endpoint
  if (result.statusCode === 200 && result.body.errorCode === 4290001) {
    console.info('[purchase] Transaction is sandbox — retrying on sandbox endpoint.');
    result = await _appleGet(APPLE_SBX_HOST, transactionId, appleJWT);
  }

  if (result.statusCode !== 200) {
    const errCode = result.body.errorCode ?? result.statusCode;
    const errMsg  = result.body.errorMessage ?? 'Unknown Apple error';
    console.warn(`[purchase] Apple API returned errorCode=${errCode} "${errMsg}"`);
    return { verified: false, reason: `apple-error-${errCode}: ${errMsg}` };
  }

  // Decode the JWS signed transaction (header.payload.signature)
  const signedTx = result.body.signedTransactionInfo;
  if (!signedTx || typeof signedTx !== 'string') {
    return { verified: false, reason: 'apple-response-missing-signedTransactionInfo' };
  }

  let txClaims;
  try {
    const parts = signedTx.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWS: expected 3 segments');
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    txClaims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (err) {
    console.error('[purchase] JWS decode error:', err.message);
    return { verified: false, reason: `jws-decode-failed: ${err.message}` };
  }

  const appleProductId = txClaims.productId;
  const appleBundleId  = txClaims.bundleId;
  const environment    = txClaims.environment ?? 'Production'; // 'Sandbox' | 'Production'

  // Cross-check bundle ID
  if (appleBundleId !== process.env.APPLE_BUNDLE_ID) {
    console.warn(`[purchase] Bundle ID mismatch: Apple="${appleBundleId}" expected="${process.env.APPLE_BUNDLE_ID}"`);
    return { verified: false, reason: 'bundle-id-mismatch' };
  }

  // Cross-check product ID
  if (appleProductId !== expectedProductId) {
    console.warn(`[purchase] Product ID mismatch: Apple="${appleProductId}" app="${expectedProductId}"`);
    return { verified: false, reason: 'product-id-mismatch' };
  }

  console.info(`[purchase] ✓ Apple verified tx=${transactionId} product=${appleProductId} env=${environment}`);
  return { verified: true, environment, productId: appleProductId, bundleId: appleBundleId };
}

// ---------------------------------------------------------------------------
// activatePurchase — the HTTP handler  POST /activatePurchase
// ---------------------------------------------------------------------------

/**
 * Grant a completed App Store purchase to the caller's shared Firestore account.
 *
 * Request body: { productId, transactionId }
 *
 * Flow:
 *  1. Resolve the user from the Firebase ID-token UID
 *  2. Idempotency check — if transactionId already recorded, return early
 *  3. Verify the transaction with Apple App Store Server API v2
 *  4. Firestore transaction — set credits + tier + purchase receipt doc
 *  5. Write subscription end-date and ledger entry (outside the transaction)
 */
const activatePurchase = async (req, res) => {
  try {
    const { productId, transactionId } = req.body;
    const firebaseUid = req.auth && req.auth.uid;
    if (!firebaseUid) return res.status(401).json({ error: 'Unauthorized' });

    if (!productId || !PRODUCTS[productId]) {
      return res.status(400).json({ error: 'Unknown productId' });
    }
    if (!transactionId || typeof transactionId !== 'string' || transactionId.length > 190) {
      return res.status(400).json({ error: 'A valid transactionId is required' });
    }

    const userDoc = await userService.resolveByFirebaseUid(firebaseUid);
    if (!userDoc) {
      return res.status(404).json({ error: 'User not found. Please restart the app.' });
    }
    const userData = userDoc.data();
    if (userData.isBlocked) {
      return res.status(403).json({ error: userData.blockReason || 'Your account has been suspended.' });
    }

    // Idempotency — restores re-deliver the same transactionId; never double-grant.
    const purchaseRef = userDoc.ref.collection('purchases').doc(transactionId);
    const existing = await purchaseRef.get();
    if (existing.exists) {
      return res.json({ success: true, alreadyGranted: true });
    }

    const product = PRODUCTS[productId];

    // --- Apple verification ---
    const verification = await verifyWithAppStore(transactionId, productId);

    // ALLOW_UNVERIFIED_PURCHASES=false enforces strict verification.
    // Defaults to true so development/sandbox works before credentials are set.
    const allowUnverified = process.env.ALLOW_UNVERIFIED_PURCHASES !== 'false';

    if (!verification.verified && !allowUnverified) {
      return res.status(403).json({
        error: 'Purchase could not be verified with the App Store.',
        reason: verification.reason,
      });
    }

    if (!verification.verified) {
      console.warn(
        `[purchase] UNVERIFIED grant: ${product.credits} credits → ${userDoc.id} ` +
        `(tx=${transactionId}, reason=${verification.reason}). ` +
        `Set ALLOW_UNVERIFIED_PURCHASES=false and configure Apple credentials before launch.`
      );
    }

    // --- Firestore transaction ---
    const userRef = userDoc.ref;
    let newBalance = null;

    await db.runTransaction(async (t) => {
      // Re-check inside the transaction to guard against concurrent duplicates.
      const freshPurchase = await t.get(purchaseRef);
      if (freshPurchase.exists) { newBalance = null; return; }

      // Credits are set directly to the plan amount (not stacked on existing balance).
      newBalance = product.credits;

      const tierUpdate = {
        credits:      product.credits,
        lastActiveAt: FieldValue.serverTimestamp(),
      };

      if (product.tier === 'lifetime') {
        tierUpdate.subscriptionTier    = 'lifetime';
        tierUpdate.subscriptionEndDate = null;
      } else {
        tierUpdate.subscriptionTier = product.tier;
        // subscriptionEndDate is written after the transaction (server
        // timestamp inside a transaction is not readable at commit time).
      }

      t.update(userRef, tierUpdate);
      t.set(purchaseRef, {
        productId,
        tier:        product.tier,
        credits:     product.credits,
        verified:    verification.verified,
        environment: verification.environment ?? null,
        createdAt:   FieldValue.serverTimestamp(),
      });
    });

    if (newBalance === null) {
      // Concurrent request already granted this transaction.
      return res.json({ success: true, alreadyGranted: true });
    }

    // Write subscription end-date outside the transaction.
    if (product.days) {
      const endDate = new Date(Date.now() + product.days * 24 * 60 * 60 * 1000);
      await userRef.update({ subscriptionEndDate: endDate }).catch(() => {});
    }

    // Persist a credit ledger entry visible in the admin panel.
    await userRef.collection('transactions').doc().set({
      amount:      product.credits,
      type:        'purchase',
      description: `App Store purchase: ${product.tier} (${productId})`,
      transactionId,
      verified:    verification.verified,
      environment: verification.environment ?? null,
      createdAt:   FieldValue.serverTimestamp(),
    });

    return res.json({
      success:     true,
      credits:     newBalance,
      verified:    verification.verified,
      environment: verification.environment ?? null,
    });
  } catch (error) {
    console.error('activatePurchase error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { activatePurchase };
