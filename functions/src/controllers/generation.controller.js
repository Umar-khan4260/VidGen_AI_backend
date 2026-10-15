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
    const { endpoint, payload, creditCost, model } = req.body;
    const userId = req.auth.uid;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    if (!creditCost || creditCost <= 0) {
      return res.status(400).json({ error: 'creditCost must be a positive number' });
    }

    const service = initService(req.app.locals.kieApiKey);
    const result = await service.generateContent(userId, endpoint, payload, creditCost, model);
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
