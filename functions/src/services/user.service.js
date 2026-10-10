const { db, FieldValue } = require('../config/firebase');

class UserService {
  async getUser(userId) {
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists ? userDoc : null;
  }

  async createUser(userId, platform, freeCredits, firebaseUid, migratedCredits) {
    const initialCredits = migratedCredits > 0 ? migratedCredits : freeCredits;
    
    const newUser = {
      sharedUserId: userId,
      linkedFirebaseUids: [firebaseUid], // Security link
      createdAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp(),
      isBlocked: false,
      blockReason: null,
      subscriptionTier: 'free',
      credits: initialCredits,
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
}

module.exports = new UserService();
