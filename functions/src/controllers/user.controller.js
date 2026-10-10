const { HttpsError } = require('firebase-functions/v2/https');
const userService = require('../services/user.service');

const identifyUserHandler = async (request) => {
  const { sharedCloudId, platform, migratedCredits } = request.data;
  
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'You must be authenticated to call this function.');
  }
  const firebaseUid = request.auth.uid;

  if (!sharedCloudId || typeof sharedCloudId !== 'string' || sharedCloudId.trim() === '') {
    throw new HttpsError('invalid-argument', 'A valid sharedCloudId is required.');
  }

  let userDoc = await userService.getUser(sharedCloudId);

  if (!userDoc) {
    const config = await userService.getAdminConfig();
    const freeCredits = config.freeCreditsOnSignup || 80;
    
    // Pass migrated credits from client on first launch
    const creditsToUse = migratedCredits && migratedCredits > 0 ? migratedCredits : freeCredits;

    await userService.createUser(sharedCloudId, platform, freeCredits, firebaseUid, migratedCredits);
    console.log(`New user registered: ${sharedCloudId} on ${platform} with ${creditsToUse} credits`);

    return {
      isNewUser: true,
      isBlocked: false,
      credits: creditsToUse,
      subscriptionTier: 'free',
      subscriptionEndDate: null,
    };
  }

  await userService.updateLastActiveAndLinkDevice(sharedCloudId, firebaseUid);
  let data = userDoc.data();

  data = await userService.expireSubscriptionIfNeeded(sharedCloudId, data);

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
