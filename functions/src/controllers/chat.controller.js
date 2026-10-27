const ChatService = require('../services/chat.service');
const userService = require('../services/user.service');
const { StringDecoder } = require('string_decoder');

// How long we keep draining an upstream chat stream after the client has
// disconnected, hoping to capture the final credits_consumed and bill it.
const DISCONNECT_DRAIN_MS = 60 * 1000;

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

/** Pull KIE's reported credit usage out of a chat payload. */
const extractCreditsConsumed = (json) => {
  if (!json || typeof json !== 'object') return 0;
  if (typeof json.credits_consumed === 'number') return json.credits_consumed;
  const response = json.response;
  if (response && typeof response === 'object' &&
      typeof response.credits_consumed === 'number') {
    return response.credits_consumed;
  }
  return 0;
};

/** Extract credits from a single SSE `data:` line (0 when not applicable). */
const extractCreditsFromSseLine = (line) => {
  if (!line.startsWith('data:')) return 0;
  const body = line.slice(5).trim();
  if (!body || body === '[DONE]') return 0;
  try {
    return extractCreditsConsumed(JSON.parse(body));
  } catch (_) {
    return 0;
  }
};

/** Non-streaming chat completion. */
const chatCompletion = async (req, res) => {
  try {
    const { endpoint, payload } = req.body;
    const userId = req.auth && req.auth.uid;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

    await userService.assertCanSpend(userId);

    const service = initService(req.app.locals.kieApiKey);
    const data = await service.chatCompletion(endpoint, payload);

    const creditsConsumed = extractCreditsConsumed(data);
    if (creditsConsumed > 0) {
      await userService.deductCredits(userId, creditsConsumed, {
        description: 'Chat completion',
        model: payload && payload.model,
      });
    }

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

  try {
    await userService.assertCanSpend(userId);
  } catch (error) {
    return res.status(getStatusCode(error.code)).json({ error: error.message, code: error.code });
  }

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

  // Parse the SSE stream as it passes through so we can bill the actual
  // credits KIE reports, without buffering the response for the client.
  // StringDecoder buffers partial UTF-8 sequences so a multi-byte character
  // split across chunks cannot corrupt the billing parse.
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let creditsConsumed = 0;
  let billed = false;
  let clientGone = false;
  let drainTimer = null;

  const bill = async (why) => {
    if (billed || creditsConsumed <= 0) return;
    billed = true;
    try {
      await userService.deductCredits(userId, creditsConsumed, {
        description: `Chat completion${why ? ` (${why})` : ''}`,
        model: payload && payload.model,
      });
    } catch (e) {
      console.error('chatStream deduction error:', e);
    }
  };

  const processLine = (line) => {
    const credits = extractCreditsFromSseLine(line);
    if (credits > creditsConsumed) creditsConsumed = credits;
  };

  upstream.on('data', (chunk) => {
    if (!clientGone) res.write(chunk);
    buffer += decoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
    }
  });
  upstream.on('end', async () => {
    // Flush any trailing partial line, then deduct BEFORE ending the
    // response: the runtime may freeze this instance once the response is
    // closed, so the write must be awaited first.
    const tail = decoder.end();
    if (tail) processLine(tail.trim());
    if (drainTimer) clearTimeout(drainTimer);
    await bill();
    res.end();
  });
  upstream.on('error', (err) => {
    if (drainTimer) clearTimeout(drainTimer);
    // Bill what KIE reported before the stream broke — it may still have
    // charged us for the partial generation.
    bill('stream error').finally(() => {
      try {
        if (!clientGone) {
          res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        }
      } catch (_) { /* client already gone */ }
      res.end();
    });
  });
  req.on('close', () => {
    // Client disconnected mid-stream. KIE already has the request and will
    // bill us for the full completion, so keep draining the upstream (without
    // writing to the dead socket) to capture the final credits_consumed, and
    // force-bill after a grace window if the model runs long.
    clientGone = true;
    drainTimer = setTimeout(() => {
      upstream.destroy();
      bill('client disconnected');
    }, DISCONNECT_DRAIN_MS);
  });
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
