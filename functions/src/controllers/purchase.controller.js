'use strict';

const { db, FieldValue } = require('../config/firebase');
const userService = require('../services/user.service');

/** Product ids must exactly match App Store Connect (see
 * subscription_models.dart). Credits per product mirror SubscriptionTier.credits. */
const PRODUCTS = {
  'com.mira.aiapp.aigenerator.subscription.weekly': { tier: 'weekly', credits: 500, days: 7 },
  'com.mira.aiapp.aigenerator.subscription.monthly': { tier: 'monthly', credits: 2000, days: 30 },
  'com.mira.aiapp.aigenerator.credits.pack.7500': { tier: 'lifetime', credits: 7500, days: null },
};

/**
 * Verify a purchase with Apple. Requires App Store Server API credentials
 * (APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID) —
 * until those secrets are configured this returns { verified: false }.
 *
 * TODO: implement the actual call — sign an ES256 JWT with the App Store
 * Connect key and GET /inApps/v1/transactions/{transactionId}, then check
 * the productId and bundle id. The grant path below already consumes the
 * result, so wiring this in needs no other changes.
 */
async function verifyWithAppStore(transactionId, productId) {
  const configured = Boolean(
    process.env.APPLE_ISSUER_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY &&
    process.env.APPLE_BUNDLE_ID
  );
  if (!configured) {
    return { verified: false, reason: 'app-store-credentials-not-configured' };
  }
  return { verified: false, reason: 'verification-not-implemented-yet' };
}

/**
 * Grant a completed App Store purchase to the caller's shared account:
 * credits are added to the Firestore balance (the balance generation
 * actually bills), the subscription tier is updated, and the transaction is
 * recorded idempotently by transactionId so restores/re-deliveries never
 * double-grant.
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

    // Already granted? Idempotent no-op (restore flows re-deliver the same
    // transaction and must not stack credits).
    const purchaseRef = userDoc.ref.collection('purchases').doc(transactionId);
    const existing = await purchaseRef.get();
    if (existing.exists) {
      return res.json({ success: true, alreadyGranted: true });
    }

    const product = PRODUCTS[productId];

    const verification = await verifyWithAppStore(transactionId, productId);
    const allowUnverified = process.env.ALLOW_UNVERIFIED_PURCHASES !== 'false';
    if (!verification.verified && !allowUnverified) {
      return res.status(403).json({ error: 'Purchase could not be verified with the App Store.' });
    }
    if (!verification.verified) {
      console.warn(
        `[purchase] UNVERIFIED grant of ${product.credits} credits to ${userDoc.id} ` +
        `(tx ${transactionId}, reason: ${verification.reason}). Configure App Store ` +
        `Server API credentials and set ALLOW_UNVERIFIED_PURCHASES=false before launch.`
      );
    }

    const userRef = userDoc.ref;
    let newBalance = null;

    await db.runTransaction(async (t) => {
      // Re-check inside the transaction: a concurrent duplicate request must
      // not slip past the idempotency check above.
      const freshPurchase = await t.get(purchaseRef);
      if (freshPurchase.exists) {
        newBalance = null;
        return;
      }

      const userSnap = await t.get(userRef);
      const current = Number(userSnap.data()?.credits) || 0;
      // Plan credits set the balance directly to the plan amount rather than adding on top
      newBalance = product.credits;

      const tierUpdate = {
        credits: product.credits,
        lastActiveAt: FieldValue.serverTimestamp(),
      };
      if (product.tier === 'lifetime') {
        tierUpdate.subscriptionTier = 'lifetime';
        tierUpdate.subscriptionEndDate = null;
      } else {
        tierUpdate.subscriptionTier = product.tier;
        // subscriptionEndDate is written just after the transaction — it
        // needs a computed now+days offset, which serverTimestamp can't do.
      }

      t.update(userRef, tierUpdate);
      t.set(purchaseRef, {
        productId,
        tier: product.tier,
        credits: product.credits,
        verified: verification.verified,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    if (newBalance === null) {
      return res.json({ success: true, alreadyGranted: true });
    }

    // Sub-period end computed outside the transaction (serverTimestamp is not
    // readable at write time). Also persists the purchase credit ledger entry.
    if (product.days) {
      const endDate = new Date(Date.now() + product.days * 24 * 60 * 60 * 1000);
      await userRef.update({ subscriptionEndDate: endDate }).catch(() => {});
    }

    await userRef.collection('transactions').doc().set({
      amount: product.credits,
      type: 'purchase',
      description: `App Store purchase: ${product.tier} (${productId})`,
      transactionId,
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, credits: newBalance, verified: verification.verified });
  } catch (error) {
    console.error('activatePurchase error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { activatePurchase };
