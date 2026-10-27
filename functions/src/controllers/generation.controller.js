const GenerationService = require('../services/generation.service');

let generationService = null;

const initService = (kieApiKey) => {
  if (!generationService) {
    generationService = new GenerationService(kieApiKey);
  }
  return generationService;
};

const generateContent = async (req, res) => {
  try {
    // NOTE: `creditCost` from the client is intentionally NOT read here.
    // Pricing lives server-side (pricing.service.js) so a modified client
    // cannot generate for free.
    const { endpoint, payload, model } = req.body;
    const userId = req.auth.uid;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'model is required' });
    }

    const service = initService(req.app.locals.kieApiKey);
    const result = await service.generateContent(userId, endpoint, payload, model);
    return res.json(result);
  } catch (error) {
    const statusCode = getStatusCode(error.code);
    return res.status(statusCode).json({ error: error.message, code: error.code });
  }
};

const getTaskStatus = async (req, res) => {
  try {
    const { taskId, endpoint } = req.body;
    const userId = req.auth.uid;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    const service = initService(req.app.locals.kieApiKey);
    const result = await service.getTaskStatus(userId, taskId, endpoint);
    return res.json(result);
  } catch (error) {
    const statusCode = getStatusCode(error.code);
    return res.status(statusCode).json({ error: error.message, code: error.code });
  }
};

const getStatusCode = (code) => {
  switch (code) {
    case 'not-found': return 404;
    case 'permission-denied': return 403;
    case 'resource-exhausted': return 429;
    case 'invalid-argument': return 400;
    default: return 500;
  }
};

const getDownloadUrl = async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.auth.uid;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    const service = initService(req.app.locals.kieApiKey);
    const result = await service.getDownloadUrl(url);
    return res.json(result);
  } catch (error) {
    const statusCode = getStatusCode(error.code);
    return res.status(statusCode).json({ error: error.message, code: error.code });
  }
};

module.exports = { generateContent, getTaskStatus, getDownloadUrl };
