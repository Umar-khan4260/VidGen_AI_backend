'use strict';

/**
 * Billing policy for generation tasks — pass-through model.
 *
 * There is NO per-model price list. Users are billed exactly what KIE
 * reports (`creditsConsumed` from recordInfo / callbacks) — the business
 * margin comes from the credit exchange rate (we sell fewer credits per
 * dollar than KIE does), not from a price map.
 *
 * What this service provides:
 *  - `getModelKind(model)` — coarse image / video / music classification,
 *    used only for the pre-generation balance floor and the rare fallback
 *    deduction when KIE reports no `creditsConsumed`.
 *  - Floors: minimum balance required BEFORE a generation starts (KIE
 *    charges our account at task creation, so a zero-balance user must not
 *    be able to launch tasks).
 *  - Fallbacks: flat deduction when a terminal task reports no
 *    `creditsConsumed` (some dedicated endpoints don't return it).
 *
 * All values are env-tunable without a redeploy of logic.
 */

const KIND_IMAGE = 'image';
const KIND_VIDEO = 'video';
const KIND_MUSIC = 'music';

// Coarse classifier — NOT prices. Everything not listed here is an image
// model; unknown models get the (highest) video floor to be safe.
const VIDEO_MODELS = new Set([
  'grok-imagine/text-to-video',
  'grok-imagine-video-1.5-preview',
  'grok-imagine/image-to-video',
  'kling-2.6/text-to-video',
  'kling/v2-5-turbo-text-to-video-pro',
  'kling/v2-1-master-text-to-video',
  'kling/v2-1-pro-text-to-video',
  'kling/v2-1-standard-text-to-video',
  'kling-2.6/image-to-video',
  'kling/v2-5-turbo-image-to-video-pro',
  'kling/v2-1-master-image-to-video',
  'kling/v2-1-pro',
  'kling/v2-1-standard',
  'kling-2.6/motion-control',
  'bytedance/v1-pro-text-to-video',
  'bytedance/v1-lite-text-to-video',
  'bytedance/seedance-1.5-pro-text-to-video',
  'bytedance/seedance-1.5-lite-text-to-video',
  'bytedance/seedance-1.5-pro',
  'bytedance/v1-pro-fast-image-to-video',
  'bytedance/v1-pro-image-to-video',
  'bytedance/v1-lite-image-to-video',
  'bytedance/seedance-2',
  'hailuo/02-text-to-video-pro',
  'hailuo/02-text-to-video-standard',
  'hailuo/2-3-text-to-video-pro',
  'hailuo/2-3-text-to-video-standard',
  'hailuo/2-3-image-to-video-pro',
  'hailuo/2-3-image-to-video-standard',
  'hailuo/02-image-to-video-pro',
  'hailuo/02-image-to-video-standard',
  'sora-2-text-to-video',
  'sora-2-pro-text-to-video',
  'sora-2-image-to-video',
  'sora-2-pro-image-to-video',
  'wan/2-6-text-to-video',
  'wan/2-2-a14b-text-to-video-turbo',
  'wan/2-5b-text-to-video',
  'wan/2-6-image-to-video',
  'wan/2-2-a14b-image-to-video-turbo',
  'wan/2-6-video-to-video',
  'runway/gen3-alpha-turbo',
  'runway-gen3',
  'runway-gen3-image-to-video',
  'aleph',
  'pika-1.5-text-to-video',
  'pika-1.5-image-to-video',
  'pixverse/v4-5-text-to-video',
  'pixverse/v5-text-to-video',
  'pixverse/v4-5-image-to-video',
  'pixverse/v5-image-to-video',
  'happy-horse/text-to-video',
  'happy-horse/image-to-video',
  'omnihuman/1-5-text-to-video',
  'omnihuman/1-5-image-to-video',
  'volcengine/text-to-video',
  'volcengine/image-to-video',
  'minimax-h3/reference-to-video',
  'gemini-omni-video',
  'veo3',
  'veo3_fast',
  'veo3_lite',
]);

// Suno music generation goes through /api/v1/generate with these model ids.
const MUSIC_MODELS = new Set([
  'V4',
  'V4_5',
  'V4_5PLUS',
  'V4_5ALL',
  'V5',
  'V5_5',
]);

/** Minimum balance required before a generation may start. */
const FLOORS = {
  [KIND_IMAGE]: Number(process.env.IMAGE_FLOOR_CREDITS) || 40,
  [KIND_VIDEO]: Number(process.env.VIDEO_FLOOR_CREDITS) || 80,
  [KIND_MUSIC]: Number(process.env.MUSIC_FLOOR_CREDITS) || 10,
};

/** Flat deduction when a finished task reports no creditsConsumed. */
const FALLBACKS = {
  [KIND_IMAGE]: Number(process.env.IMAGE_FALLBACK_CREDITS) || 5,
  [KIND_VIDEO]: Number(process.env.VIDEO_FALLBACK_CREDITS) || 25,
  [KIND_MUSIC]: Number(process.env.MUSIC_FALLBACK_CREDITS) || 8,
};

class PricingService {
  getModelKind(model) {
    if (VIDEO_MODELS.has(model)) return KIND_VIDEO;
    if (MUSIC_MODELS.has(model)) return KIND_MUSIC;
    if (typeof model === 'string' && model) return KIND_IMAGE;
    // Unknown/absent model — the task will fail at KIE anyway; use the
    // highest floor so nothing slips through cheaply.
    return KIND_VIDEO;
  }

  getFloor(kind) {
    return FLOORS[kind] || FLOORS[KIND_VIDEO];
  }

  getFallbackCredits(kind) {
    return FALLBACKS[kind] || FALLBACKS[KIND_VIDEO];
  }
}

module.exports = new PricingService();
module.exports.KIND_IMAGE = KIND_IMAGE;
module.exports.KIND_VIDEO = KIND_VIDEO;
module.exports.KIND_MUSIC = KIND_MUSIC;
