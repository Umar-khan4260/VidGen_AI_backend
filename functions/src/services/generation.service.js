const axios = require('axios');
const { db, FieldValue } = require('../config/firebase');
const pricing = require('./pricing.service');

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

// Status endpoint paired with each generate endpoint. Stored on the task
// record at creation so polling always uses the right one (the client used
// to send no endpoint, defaulting everything to the unified jobs/recordInfo).
const STATUS_ENDPOINT_FOR = {
  '/api/v1/jobs/createTask': '/api/v1/jobs/recordInfo',
  '/api/v1/gpt4o-image/generate': '/api/v1/gpt4o-image/record-info',
  '/api/v1/flux/kontext/generate': '/api/v1/flux/kontext/record-info',
  '/api/v1/veo/generate': '/api/v1/veo/record-info',
  '/api/v1/runway/generate': '/api/v1/runway/record-info',
  '/api/v1/aleph/generate': '/api/v1/aleph/record-info',
  '/api/v1/generate': '/api/v1/generate/record-info',
};

const DEFAULT_STATUS_ENDPOINT = '/api/v1/jobs/recordInfo';

/** Task recordInfo status values that mean the task failed. Mirrors the
 * client's TaskDetail.isFailed (models.dart) — KIE never charges for failed
 * tasks, so failures settle at zero. */
function isFailedStatus(taskData) {
  if (!taskData || typeof taskData !== 'object') return false;
  const state = String(taskData.state || taskData.status || '').trim();
  if (['failed', 'fail', 'error', 'GENERATE_FAILED', 'CREATE_TASK_FAILED'].includes(state)) {
    return true;
  }
  const successFlag = Number(taskData.successFlag);
  const errorCode = Number(taskData.errorCode);
  if (successFlag > 1) return true; // Veo / Aleph convention: 2-3 = failed
  if (successFlag === 0 && errorCode > 0) return true;
  return false;
}

function isCompletedStatus(taskData) {
  if (!taskData || typeof taskData !== 'object') return false;
  const state = String(taskData.state || taskData.status || '').trim();
  if (['completed', 'success', 'succeeded', 'SUCCESS'].includes(state)) return true;
  return Number(taskData.successFlag) === 1;
}

/** Actual credits KIE consumed for a task, when it reports them. The unified
 * Market recordInfo uses `creditsConsumed`; some dedicated endpoints use
 * `credits`. Returns null when not reported. */
function reportedCredits(taskData) {
  if (!taskData || typeof taskData !== 'object') return null;
  const raw = taskData.creditsConsumed != null ? taskData.creditsConsumed : taskData.credits;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

class GenerationService {
  constructor(kieApiKey) {
    this.kieApiKey = kieApiKey;
  }

  validateEndpoint(endpoint) {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      const err = new Error(`Endpoint not allowed: ${endpoint}`);
      err.code = 'invalid-argument';
      throw err;
    }
  }

  validateStatusEndpoint(endpoint) {
    if (!Object.values(STATUS_ENDPOINT_FOR).includes(endpoint)) {
      const err = new Error(`Status endpoint not allowed: ${endpoint}`);
      err.code = 'invalid-argument';
      throw err;
    }
  }

  async getUser(firebaseUid) {
    const query = await db.collection('users')
      .where('linkedFirebaseUids', 'array-contains', firebaseUid)
      .limit(1)
      .get();
    return query.empty ? null : query.docs[0];
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

  /** Deduct the settled amount, clamped at zero so a parallel-task shortfall
   * never produces a negative displayed balance. */
  async applyUsage(userId, amount, description) {
    const userRef = db.collection('users').doc(userId);

    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const current = Number(snap.data()?.credits) || 0;
      if (current < amount) {
        console.warn(
          `[billing] Settle shortfall for user ${userId}: owed ${amount}, balance ${current} (clamped at 0).`
        );
      }
      t.update(userRef, {
        credits: Math.max(0, current - amount),
        lastActiveAt: FieldValue.serverTimestamp(),
      });
    });

    await userRef.collection('transactions').doc().set({
      amount: -amount,
      type: 'usage',
      description,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  /** Best-effort extraction of the task id from a KIE create response. */
  extractTaskId(kieResponse) {
    const d = kieResponse && kieResponse.data;
    if (d && typeof d === 'object' && typeof d.taskId === 'string' && d.taskId) {
      return d.taskId;
    }
    if (kieResponse && typeof kieResponse.taskId === 'string' && kieResponse.taskId) {
      return kieResponse.taskId;
    }
    return null;
  }

  /** Record task ownership + billing metadata. Settled later from
   * recordInfo's creditsConsumed (or the flat fallback). */
  async recordTask(userId, taskId, kind, model, endpoint) {
    if (!taskId) return;
    try {
      await db.collection('users').doc(userId)
        .collection('tasks').doc(taskId)
        .set({
          model: model || 'unknown',
          kind,
          endpoint,
          statusEndpoint: STATUS_ENDPOINT_FOR[endpoint] || DEFAULT_STATUS_ENDPOINT,
          settled: false,
          settledAmount: null,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    } catch (e) {
      console.error(`recordTask failed for ${taskId}:`, e.message);
    }
  }

  /**
   * Settle a task from its recordInfo response — runs exactly once per task
   * (guarded by the `settled` flag inside a transaction):
   *   failed    -> 0 credits (KIE never charges for failed tasks)
   *   completed -> exactly `creditsConsumed` (flat fallback by kind when KIE
   *                reports none)
   */
  async settleTask(taskRef, kind, model, kieStatusResponse) {
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists || taskSnap.data().settled) return false;

    const taskData = kieStatusResponse && kieStatusResponse.data;

    if (!isCompletedStatus(taskData) && !isFailedStatus(taskData)) {
      return false; // still running — nothing to settle
    }

    let amount = 0;
    if (isCompletedStatus(taskData)) {
      const actual = reportedCredits(taskData);
      amount = actual != null ? actual : pricing.getFallbackCredits(kind);
    }

    // Claim the settlement atomically so concurrent polls / the scheduled
    // settler can never double-charge.
    const claimed = await db.runTransaction(async (t) => {
      const fresh = await t.get(taskRef);
      if (!fresh.exists || fresh.data().settled) return false;
      t.update(taskRef, {
        settled: true,
        settledAmount: amount,
        status: isFailedStatus(taskData) ? 'failed' : 'completed',
        settledAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!claimed) return false;

    if (amount > 0) {
      const userId = taskRef.parent.parent.id;
      await this.applyUsage(
        userId,
        amount,
        `${model || 'generation'} (actual creditsConsumed: ${amount})`
      );
    }
    console.log(`Settled task ${taskRef.id} (${kind}/${model}): ${amount} credits`);
    return true;
  }

  /** Scheduler entry point: settle one pending task by fetching its status. */
  async settlePendingTask(taskDoc) {
    const task = taskDoc.data();
    const kieStatus = await this.callKieStatusApi(
      task.statusEndpoint || DEFAULT_STATUS_ENDPOINT,
      taskDoc.id
    );
    return this.settleTask(taskDoc.ref, task.kind, task.model, kieStatus);
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

  /**
   * Create a generation task — pass-through billing:
   *   1. Enforce a minimum-balance floor (image 40 / video 80 credits) so a
   *      zero-balance user cannot launch tasks KIE charges us for.
   *   2. Deduct NOTHING up front.
   *   3. When the task finishes, bill exactly the creditsConsumed KIE
   *      reports (see settleTask). No per-model price list anywhere.
   */
  async generateContent(userId, endpoint, payload, model) {
    this.validateEndpoint(endpoint);

    if (!model || typeof model !== 'string') {
      const err = new Error('model is required');
      err.code = 'invalid-argument';
      throw err;
    }

    const kind = pricing.getModelKind(model);
    const floor = pricing.getFloor(kind);

    const userDoc = await this.getUser(userId);
    const userData = await this.checkUser(userDoc);

    const balance = Number(userData.credits) || 0;
    if (balance < floor) {
      const err = new Error(
        `Insufficient credits. You need at least ${floor} credits to start a ${kind} generation (you have ${balance}).`
      );
      err.code = 'resource-exhausted';
      throw err;
    }

    const docId = userDoc.id;
    const kieResponse = await this.callKieApi(endpoint, payload);
    await this.recordTask(docId, this.extractTaskId(kieResponse), kind, model, endpoint);
    return { success: true, data: kieResponse };
  }

  async getTaskStatus(userId, taskId, endpoint) {
    const userDoc = await this.getUser(userId);
    await this.checkUser(userDoc);

    // Ownership check: the task must belong to this user's account. Stops
    // one authenticated user polling (and reading the results of) another
    // user's tasks.
    const taskRef = userDoc.ref.collection('tasks').doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) {
      const err = new Error('Task not found for this account.');
      err.code = 'not-found';
      throw err;
    }
    const task = taskSnap.data();

    // A client-supplied endpoint is validated when present, but the one
    // recorded at creation always wins (it matches the model that made the
    // task; the client used to send none at all).
    if (endpoint) this.validateStatusEndpoint(endpoint);
    const statusEndpoint = task.statusEndpoint || endpoint || DEFAULT_STATUS_ENDPOINT;

    const data = await this.callKieStatusApi(statusEndpoint, taskId);
    await this.settleTask(taskRef, task.kind, task.model, data);
    return { success: true, data };
  }

  /**
   * Resolve a direct download URL for a generated file. Proxied so the KIE key
   * stays server-side. Only URLs on KIE's own storage hosts may be resolved.
   */
  async getDownloadUrl(fileUrl) {
    if (typeof fileUrl !== 'string' || !/^https:\/\//.test(fileUrl)) {
      const err = new Error('A valid https file URL is required.');
      err.code = 'invalid-argument';
      throw err;
    }

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
