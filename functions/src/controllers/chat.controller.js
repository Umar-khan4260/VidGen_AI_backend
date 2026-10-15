const ChatService = require('../services/chat.service');

let chatService = null;

const initService = (kieApiKey) => {
  if (!chatService) {
    chatService = new ChatService(kieApiKey);
  }
  return chatService;
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

/** Non-streaming chat completion. */
const chatCompletion = async (req, res) => {
  try {
    const { endpoint, payload } = req.body;
    const userId = req.auth && req.auth.uid;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

    const service = initService(req.app.locals.kieApiKey);
    const data = await service.chatCompletion(endpoint, payload);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(getStatusCode(error.code)).json({ error: error.message, code: error.code });
  }
};

/** Streaming (SSE) chat completion — transparently pipes KIE's stream. */
const chatStream = async (req, res) => {
  const { endpoint, payload } = req.body;
  const userId = req.auth && req.auth.uid;

  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

  let upstream;
  try {
    const service = initService(req.app.locals.kieApiKey);
    upstream = await service.streamChat(endpoint, payload);
  } catch (error) {
    return res.status(getStatusCode(error.code)).json({ error: error.message, code: error.code });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  upstream.on('data', (chunk) => res.write(chunk));
  upstream.on('end', () => res.end());
  upstream.on('error', (err) => {
    try {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    } catch (_) { /* client already gone */ }
    res.end();
  });
  req.on('close', () => upstream.destroy());
};

/** Forward an uploaded file (multipart/form-data, field name "file"). */
const uploadFile = async (req, res) => {
  try {
    const userId = req.auth && req.auth.uid;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const service = initService(req.app.locals.kieApiKey);
    const data = await service.uploadFile(
      req.file.buffer,
      req.file.originalname,
      req.body.uploadPath
    );
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(getStatusCode(error.code)).json({ error: error.message, code: error.code });
  }
};

module.exports = { chatCompletion, chatStream, uploadFile };
