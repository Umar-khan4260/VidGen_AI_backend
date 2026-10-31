const userService = require('../services/user.service');

const identifyUser = async (req, res) => {
  try {
    const { sharedCloudId, platform } = req.body;
    const firebaseUid = req.auth.uid;

    if (!firebaseUid) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!sharedCloudId || typeof sharedCloudId !== 'string' || sharedCloudId.trim() === '') {
      return res.status(400).json({ error: 'A valid sharedCloudId is required' });
    }

    let userDoc = await userService.getUser(sharedCloudId);
    const config = await userService.getAdminConfig();
    const maintenanceMode = config.maintenanceMode === true;

    if (!userDoc) {
      if (maintenanceMode) {
        return res.status(503).json({ error: 'The app is currently under maintenance. Please try again later.' });
      }

      // Read admin-configured default free credits (defaults to 0 if not set in admin/config)
      const initialCredits = Number(config.defaultCredits ?? config.freeCredits ?? 0) || 0;

      await userService.createUser(sharedCloudId, platform, firebaseUid, initialCredits);
      console.log(`New user registered: ${sharedCloudId} on ${platform} with ${initialCredits} credits`);

      return res.json({
        isNewUser: true,
        isBlocked: false,
        credits: initialCredits,
        subscriptionTier: 'free',
        subscriptionEndDate: null,
      });
    }

    await userService.updateLastActiveAndLinkDevice(sharedCloudId, firebaseUid);
    let data = userDoc.data();

    data = await userService.expireSubscriptionIfNeeded(sharedCloudId, data);

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
