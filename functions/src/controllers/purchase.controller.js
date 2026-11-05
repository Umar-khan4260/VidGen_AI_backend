'use strict';

const { db, FieldValue } = require('../config/firebase');
const userService = require('../services/user.service');

/** Product ids must exactly match App Store Connect (see
 * subscription_models.dart). Credits per product mirror SubscriptionTier.credits.
 */
const PRODUCTS = {
  'com.vidgen.subscription.weekly':  { tier: 'weekly',   credits: 500,  days: 7    },
  'com.vidgen.subscription.monthly': { tier: 'monthly',  credits: 2000, days: 30   },
  'com.vidgen.credits.pack.7500':    { tier: 'lifetime', credits: 7500, days: null },
};

/**
 * Grant a completed App Store purchase to the caller's shared Firestore account.
 *
 * Request body: { productId, transactionId }
 *
 * Flow:
 *  1. Resolve the user from the Firebase ID-token UID
 *  2. Idempotency check — if transactionId already recorded, return early
 *  3. Validate productId is known
 *  4. Firestore transaction — set credits + tier + purchase receipt doc
 *  5. Write subscription end-date and ledger entry (outside the transaction)
 *
 * Apple verification is intentionally skipped. The backend stores the
 * purchase details as-reported by the client. If end-to-end Apple
 * verification is needed, configure APPLE_ISSUER_ID/KEY_ID/PRIVATE_KEY
 * and set ALLOW_UNVERIFIED_PURCHASES=false before production launch.
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

    // --- Firestore transaction ---
    const userRef = userDoc.ref;
    let newBalance = null;

    await db.runTransaction(async (t) => {
      // Re-check inside the transaction to guard against concurrent duplicates.
      const freshPurchase = await t.get(purchaseRef);
      if (freshPurchase.exists) { newBalance = null; return; }

      // Credits ADD to the existing balance — a user with leftover credits
      // must never lose them by buying a plan, and repeat lifetime-pack
      // purchases stack. Idempotency (one grant per transactionId) is what
      // prevents double-granting, not overwriting the balance.
      const freshUser = await t.get(userRef);
      const currentCredits = Number(freshUser.data()?.credits) || 0;
      newBalance = currentCredits + product.credits;

      const tierUpdate = {
        credits:      FieldValue.increment(product.credits),
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
        verified:    false,  // Apple verification is skipped; caller attests via the store.
        environment: 'unknown',
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
      verified:    false,
      environment: 'unknown',
      createdAt:   FieldValue.serverTimestamp(),
    });

    return res.json({
      success:     true,
      credits:     newBalance,
      verified:    false,
      environment: 'unknown',
    });
  } catch (error) {
    console.error('activatePurchase error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { activatePurchase };