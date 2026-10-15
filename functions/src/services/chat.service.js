const axios = require('axios');
const FormData = require('form-data');

const KIE_BASE_URL = 'https://api.kie.ai';
const KIE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload';

// Only these chat/completions endpoints may be proxied. The client can never
// point the proxy at an arbitrary URL.
const ALLOWED_CHAT_ENDPOINTS = new Set([
  '/gpt-5-2/v1/chat/completions',
  '/gemini-3.1-pro/v1/chat/completions',
  '/claude/v1/messages',
  '/grok/v1/responses',
  '/api/v1/responses',
]);

/**
 * ChatService — server-side proxy to KIE's chat-completion + file-upload APIs.
 *
 * The KIE API key lives only on the server (Firebase Secret Manager in
 * production, .env locally). The Flutter client never sees it.
 */
class ChatService {
  constructor(kieApiKey) {
    this.kieApiKey = kieApiKey;
  }

  assertAllowedEndpoint(endpoint) {
    if (!ALLOWED_CHAT_ENDPOINTS.has(endpoint)) {
      const err = new Error(`Endpoint not allowed: ${endpoint}`);
      err.code = 'invalid-argument';
      throw err;
    }
  }

  authHeaders() {
    return {
      Authorization: `Bearer ${this.kieApiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /** Non-streaming chat completion. Returns KIE's raw JSON payload. */
  async chatCompletion(endpoint, payload) {
    this.assertAllowedEndpoint(endpoint);
    try {
      const response = await axios.post(
        `${KIE_BASE_URL}${endpoint}`,
        payload || {},
        { headers: this.authHeaders(), timeout: 300000 }
      );
      return response.data;
    } catch (apiError) {
      const status = apiError.response?.status;
      const msg = apiError.response?.data?.msg || apiError.message;
      throw new Error(`KIE chat error (${status}): ${msg}`);
    }
  }

  /** Streaming chat completion. Returns the upstream Node Readable stream. */
  async streamChat(endpoint, payload) {
    this.assertAllowedEndpoint(endpoint);
    const response = await axios.post(
      `${KIE_BASE_URL}${endpoint}`,
      { ...(payload || {}), stream: true },
      {
        headers: { ...this.authHeaders(), Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: 300000,
      }
    );
    return response.data;
  }

  /** Forward an uploaded file to KIE's storage. Returns KIE's raw JSON. */
  async uploadFile(buffer, fileName, uploadPath) {
    const form = new FormData();
    form.append('uploadPath', uploadPath || 'user-uploads');
    form.append('fileName', fileName || 'upload');
    form.append('file', buffer, { filename: fileName || 'upload' });

    try {
      const response = await axios.post(KIE_UPLOAD_URL, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${this.kieApiKey}` },
        // KIE's upload server is slow; large videos can take many minutes.
        timeout: 2400000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return response.data;
    } catch (apiError) {
      const status = apiError.response?.status;
      const msg = apiError.response?.data?.msg || apiError.message;
      throw new Error(`KIE upload error (${status}): ${msg}`);
    }
  }
}

module.exports = ChatService;
