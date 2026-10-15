const axios = require('axios');
const { db, FieldValue } = require('../config/firebase');

const KIE_BASE_URL = 'https://api.kie.ai';
const KIE_DOWNLOAD_URL_PATH = '/api/v1/common/download-url';

const ALLOWED_ENDPOINTS = [
  '/api/v1/jobs/createTask',
  '/api/v1/gpt4o-image/generate',
  '/api/v1/flux/kontext/generate',
  '/api/v1/veo/generate',
  '/api/v1/runway/generate',
  '/api/v1/aleph/generate',
  '/api/v1/generate',
];

const ALLOWED_STATUS_ENDPOINTS = [
  '/api/v1/jobs/recordInfo',
  '/api/v1/gpt4o-image/record-info',
  '/api/v1/flux/kontext/record-info',
  '/api/v1/veo/record-info',
  '/api/v1/runway/record-info',
  '/api/v1/aleph/record-info',
  '/api/v1/generate/record-info',
];

class GenerationService {
  constructor(kieApiKey) {
    this.kieApiKey = kieApiKey;
  }

  validateEndpoint(endpoint) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Endpoint not allowed: ${endpoint}`);
    }
  }

  validateStatusEndpoint(endpoint) {
    if (!ALLOWED_STATUS_ENDPOINTS.includes(endpoint)) {
      throw new Error(`Status endpoint not allowed: ${endpoint}`);
    }
  }

  async getUser(userId) {
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists ? userDoc : null;
  }

  async checkUser(userDoc) {
    if (!userDoc) {
      const err = new Error('User not found. Please restart the app.');
      err.code = 'not-found';
      throw err;
    }

    const data = userDoc.data();
    if (data.isBlocked) {
      const err = new Error(data.blockReason || 'Your account has been suspended.');
      err.code = 'permission-denied';
      throw err;
    }

    return data;
  }

  async checkCredits(userData, creditCost) {
    if (userData.credits < creditCost) {
      const err = new Error(
        `Insufficient credits. You have ${userData.credits} but need ${creditCost}.`
      );
      err.code = 'resource-exhausted';
      throw err;
    }
  }

  async deductCredits(userId, creditCost, model, endpoint) {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      credits: FieldValue.increment(-creditCost),
      totalGenerations: FieldValue.increment(1),
      lastActiveAt: FieldValue.serverTimestamp(),
    });

    const txRef = userRef.collection('transactions').doc();
    await txRef.set({
      amount: -creditCost,
      type: 'usage',
      model: model || 'unknown',
      endpoint: endpoint,
      createdAt: FieldValue.serverTimestamp(),
      description: `Generated using ${model}`,
    });
  }

  async refundCredits(userId, creditCost) {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      credits: FieldValue.increment(creditCost),
    });

    const txRef = userRef.collection('transactions').doc();
    await txRef.set({
      amount: creditCost,
      type: 'refund',
      description: 'Refund for failed generation',
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  async callKieApi(endpoint, payload) {
    try {
      const response = await axios.post(
        `${KIE_BASE_URL}${endpoint}`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.kieApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 300000,
        }
      );
      return response.data;
    } catch (apiError) {
      const status = apiError.response?.status;
      const msg = apiError.response?.data?.msg || apiError.message;
      throw new Error(`KIE API error (${status}): ${msg}`);
    }
  }

  async callKieStatusApi(endpoint, taskId) {
    try {
      const response = await axios.get(
        `${KIE_BASE_URL}${endpoint}`,
        {
          params: { taskId },
          headers: { 'Authorization': `Bearer ${this.kieApiKey}` },
          timeout: 30000,
        }
      );
      return response.data;
    } catch (apiError) {
      const status = apiError.response?.status;
      const msg = apiError.response?.data?.msg || apiError.message;
      throw new Error(`KIE API status error (${status}): ${msg}`);
    }
  }

  async generateContent(userId, endpoint, payload, creditCost, model) {
    this.validateEndpoint(endpoint);

    const userDoc = await this.getUser(userId);
    const userData = await this.checkUser(userDoc);
    await this.checkCredits(userData, creditCost);

    await this.deductCredits(userId, creditCost, model, endpoint);

    try {
      const kieResponse = await this.callKieApi(endpoint, payload);
      return { success: true, data: kieResponse };
    } catch (apiError) {
      await this.refundCredits(userId, creditCost);
      throw apiError;
    }
  }

  async getTaskStatus(userId, taskId, endpoint) {
    const statusEndpoint = endpoint || '/api/v1/jobs/recordInfo';
    this.validateStatusEndpoint(statusEndpoint);

    const userDoc = await this.getUser(userId);
    await this.checkUser(userDoc);

    const data = await this.callKieStatusApi(statusEndpoint, taskId);
    return { success: true, data };
  }

  /**
   * Resolve a direct download URL for a generated file. Proxied so the KIE key
   * stays server-side.
   */
  async getDownloadUrl(fileUrl) {
    try {
      const response = await axios.post(
        `${KIE_BASE_URL}${KIE_DOWNLOAD_URL_PATH}`,
        { url: fileUrl },
        {
          headers: {
            'Authorization': `Bearer ${this.kieApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      return { success: true, data: response.data };
    } catch (apiError) {
      const status = apiError.response?.status;
      const msg = apiError.response?.data?.msg || apiError.message;
      throw new Error(`KIE download-url error (${status}): ${msg}`);
    }
  }
}

module.exports = GenerationService;
