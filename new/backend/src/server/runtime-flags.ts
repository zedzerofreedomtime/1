import { config } from '../config.js';

/**
 * Effective Flow feature flags for this service process.
 *
 * Values are resolved when Node loads config. Exposing the exact in-memory
 * values makes a stale service process visible after `.env` changes.
 */
export function readFlowRuntimeFlags() {
  return {
    ingredientsModeEnabled: config.ingredientsModeEnabled,
    endFrameEnabled: config.endFrameEnabled,
    firstImageSource: config.firstImageSource,
    referenceImagesEnabled: config.referenceImagesEnabled,
    referenceImageCount: config.referenceImageCount,
    ingredientReferenceCount: config.ingredientReferenceCount,
    clipFidelityCheckEnabled: config.clipFidelityCheckEnabled,
  };
}
