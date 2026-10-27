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

    if (!userDoc) {
      // No free credits on signup — new accounts start at 0 and must
      // purchase credits before generating anything. (The old free-80
      // default and the client-claimed "migrated credits" were both free
      // credit vectors: with anonymous auth, a fresh install could claim
      // them at will.)
      await userService.createUser(sharedCloudId, platform, firebaseUid);
      console.log(`New user registered: ${sharedCloudId} on ${platform} with 0 credits`);

      return res.json({
        isNewUser: true,
        isBlocked: false,
        credits: 0,
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
