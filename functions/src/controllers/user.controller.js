const { HttpsError } = require('firebase-functions/v2/https');
const userService = require('../services/user.service');

const identifyUserHandler = async (request) => {
  const { sharedCloudId, platform } = request.data;
  
  // Security: Ensure the request comes from an authenticated Firebase user
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'You must be authenticated to call this function.');
  }
  const firebaseUid = request.auth.uid;

  if (!sharedCloudId || typeof sharedCloudId !== 'string' || sharedCloudId.trim() === '') {
    throw new HttpsError('invalid-argument', 'A valid sharedCloudId is required.');
  }

  let userDoc = await userService.getUser(sharedCloudId);

  if (!userDoc) {
    // ── NEW USER: read free credit amount from admin config ──
    const config = await userService.getAdminConfig();
    const freeCredits = config.freeCreditsOnSignup || 80;

    await userService.createUser(sharedCloudId, platform, freeCredits, firebaseUid);
    console.log(`New user registered: ${sharedCloudId} on ${platform}`);

    return {
      isNewUser: true,
      isBlocked: false,
      credits: freeCredits,
      subscriptionTier: 'free',
      subscriptionEndDate: null,
    };
  }

  // ── EXISTING USER: update last active & link Firebase device UID ──
  await userService.updateLastActiveAndLinkDevice(sharedCloudId, firebaseUid);
  let data = userDoc.data();

  // Auto-expire subscription if past end date
  data = await userService.expireSubscriptionIfNeeded(sharedCloudId, data);

  // Check maintenance mode
  const config = await userService.getAdminConfig();
  const maintenanceMode = config.maintenanceMode === true;
  if (maintenanceMode && !(data.isAdmin === true)) {
    throw new HttpsError(
      'unavailable',
      'The app is currently under maintenance. Please try again later.'
    );
  }

  return {
    isNewUser: false,
    isBlocked: data.isBlocked || false,
    blockReason: data.blockReason || null,
    credits: data.credits || 0,
    subscriptionTier: data.subscriptionTier || 'free',
    subscriptionEndDate: data.subscriptionEndDate
      ? data.subscriptionEndDate.toDate().toISOString()
      : null,
  };
};

module.exports = {
  identifyUserHandler
};
