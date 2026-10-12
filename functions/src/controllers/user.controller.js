const userService = require('../services/user.service');

const identifyUser = async (req, res) => {
  try {
    const { sharedCloudId, platform, migratedCredits } = req.body;
    const firebaseUid = req.auth.uid;

    if (!firebaseUid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sharedCloudId || typeof sharedCloudId !== 'string' || sharedCloudId.trim() === '') {
      return res.status(400).json({ error: 'A valid sharedCloudId is required' });
    }

    let userDoc = await userService.getUser(sharedCloudId);

    if (!userDoc) {
      const config = await userService.getAdminConfig();
      const freeCredits = config.freeCreditsOnSignup || 80;

      const creditsToUse = migratedCredits && migratedCredits > 0 ? migratedCredits : freeCredits;

      await userService.createUser(sharedCloudId, platform, freeCredits, firebaseUid, migratedCredits);
      console.log(`New user registered: ${sharedCloudId} on ${platform} with ${creditsToUse} credits`);

      return res.json({
        isNewUser: true,
        isBlocked: false,
        credits: creditsToUse,
        subscriptionTier: 'free',
        subscriptionEndDate: null,
      });
    }

    await userService.updateLastActiveAndLinkDevice(sharedCloudId, firebaseUid);
    let data = userDoc.data();

    data = await userService.expireSubscriptionIfNeeded(sharedCloudId, data);

    const config = await userService.getAdminConfig();
    const maintenanceMode = config.maintenanceMode === true;
    if (maintenanceMode && !(data.isAdmin === true)) {
      return res.status(503).json({ error: 'The app is currently under maintenance. Please try again later.' });
    }

    return res.json({
      isNewUser: false,
      isBlocked: data.isBlocked || false,
      blockReason: data.blockReason || null,
      credits: data.credits || 0,
      subscriptionTier: data.subscriptionTier || 'free',
      subscriptionEndDate: data.subscriptionEndDate
        ? data.subscriptionEndDate.toDate().toISOString()
        : null,
    });
  } catch (error) {
    console.error('identifyUser error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { identifyUser };
