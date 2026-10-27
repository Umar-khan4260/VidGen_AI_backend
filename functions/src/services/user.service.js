const { db, FieldValue } = require('../config/firebase');

class UserService {
  async getUser(userId) {
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists ? userDoc : null;
  }

  async createUser(userId, platform, firebaseUid) {
    const newUser = {
      sharedUserId: userId,
      linkedFirebaseUids: [firebaseUid], // Security link
      createdAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      isBlocked: false,
      blockReason: null,
      subscriptionTier: 'free',
      credits: 0, // No free credits — users must purchase before generating
      subscriptionEndDate: null,
      transactionId: null,
      totalGenerations: 0,
      platform: platform || 'unknown',
    };

    await db.collection('users').doc(userId).set(newUser);
    return newUser;
  }

  async updateLastActiveAndLinkDevice(userId, firebaseUid) {
    await db.collection('users').doc(userId).update({
      lastActiveAt: FieldValue.serverTimestamp(),
      linkedFirebaseUids: FieldValue.arrayUnion(firebaseUid)
    });
  }

  async expireSubscriptionIfNeeded(userId, data) {
    if (
      data.subscriptionEndDate &&
      data.subscriptionTier !== 'free' &&
      data.subscriptionTier !== 'lifetime'
    ) {
      const endDate = data.subscriptionEndDate.toDate();
      if (new Date() > endDate) {
        await db.collection('users').doc(userId).update({ 
          subscriptionTier: 'free', 
          subscriptionEndDate: null 
        });
        data.subscriptionTier = 'free';
        data.subscriptionEndDate = null;
        console.log(`Subscription expired for user: ${userId}`);
      }
    }
    return data;
  }

  async getAdminConfig() {
    const configDoc = await db.collection('admin').doc('config').get();
    return configDoc.exists ? configDoc.data() : {};
  }

  /**
   * Resolve the shared account document linked to a device's Firebase uid.
   * The account doc is keyed by `sharedCloudId` and lists each linked device
   * uid in `linkedFirebaseUids`.
   */
  async resolveByFirebaseUid(firebaseUid) {
    const query = await db.collection('users')
      .where('linkedFirebaseUids', 'array-contains', firebaseUid)
      .limit(1)
      .get();
    return query.empty ? null : query.docs[0];
  }

  /**
   * Verify the caller has a usable account (exists, not blocked, has credits).
   * Throws an error with a `code` the controllers map to an HTTP status.
   */
  async assertCanSpend(firebaseUid) {
    const userDoc = await this.resolveByFirebaseUid(firebaseUid);
    if (!userDoc) {
      const err = new Error('User not found. Please restart the app.');
      err.code = 'not-found';
      throw err;
    }

    const data = userDoc.data();
    if (data.isBlocked) {
      const err = new Error(data.blockReason || 'Your account has been suspended.');
      err.code = 'permission-denied';
      throw err;
    }
    if (!(data.credits > 0)) {
      const err = new Error('Insufficient credits. Please add credits to continue.');
      err.code = 'resource-exhausted';
      throw err;
    }
    return userDoc;
  }

  /**
   * Deduct credits from the account linked to a Firebase uid. Clamps the
   * balance at zero and records a transaction. No-op for non-positive amounts.
   */
  async deductCredits(firebaseUid, amount, { description, model } = {}) {
    if (!amount || amount <= 0) return;

    const userDoc = await this.resolveByFirebaseUid(firebaseUid);
    if (!userDoc) return;

    const userRef = userDoc.ref;
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const current = snap.data()?.credits || 0;
      const next = Math.max(0, current - amount);
      t.update(userRef, {
        credits: next,
        lastActiveAt: FieldValue.serverTimestamp(),
      });
    });

    await userRef.collection('transactions').doc().set({
      amount: -amount,
      type: 'usage',
      model: model || 'chat',
      description: description || 'Usage',
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}

module.exports = new UserService();
