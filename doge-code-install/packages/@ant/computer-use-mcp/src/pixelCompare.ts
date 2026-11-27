/**
 * Staleness guard ported from the Vercept acquisition.
 *
 * Compares the model's last-seen screenshot against a fresh-right-now
 * screenshot at the click target, so the model never clicks pixels it hasn't
 * seen. If the 9×9 patch around the target differs, the click is aborted and
 * the model is told to re-screenshot. This is NOT a popup detector.
 *
 * The host decodes a 9×9 patch from each JPEG. The Windows caller allows
 * modest JPEG variation and handles unavailable comparisons explicitly.
 */

import type { ScreenshotResult } from "./executor.js";
import type { Logger } from "./types.js";

/** Injected by the host. See `ComputerUseHostAdapter.cropRawPatch`. */
export type CropRawPatchFn = (
  jpegBase64: string,
  rect: { x: number; y: number; width: number; height: number },
) => Buffer | null | Promise<Buffer | null>;

/** 9×9 is empirically the sweet spot — large enough to catch a tooltip
 * appearing, small enough to not false-positive on surrounding animation.
 **/
const DEFAULT_GRID_SIZE = 9;

export interface PixelCompareResult {
  /** true → click may proceed. false → patch changed, abort the click. */
  valid: boolean;
  /** true → a comparison could not be performed. */
  skipped: boolean;
  /** Populated when valid === false. Returned to the model verbatim. */
  warning?: string;
}

/**
 * Compute the crop rect for a patch centered on (xPercent, yPercent).
 *
 * Dimensions come from ScreenshotResult.width/height (physical pixels). Both
 * screenshots have the same dimensions (same display, consecutive captures),
 * so the rect is the same for both.
 */
function computeCropRect(
  imgW: number,
  imgH: number,
  xPercent: number,
  yPercent: number,
  gridSize: number,
): { x: number; y: number; width: number; height: number } | null {
  if (!imgW || !imgH) return null;

  const clampedX = Math.max(0, Math.min(100, xPercent));
  const clampedY = Math.max(0, Math.min(100, yPercent));

  const centerX = Math.round((clampedX / 100.0) * imgW);
  const centerY = Math.round((clampedY / 100.0) * imgH);

  const halfGrid = Math.floor(gridSize / 2);
  const cropX = Math.max(0, centerX - halfGrid);
  const cropY = Math.max(0, centerY - halfGrid);
  const cropW = Math.min(gridSize, imgW - cropX);
  const cropH = Math.min(gridSize, imgH - cropY);
  if (cropW <= 0 || cropH <= 0) return null;

  return { x: cropX, y: cropY, width: cropW, height: cropH };
}

/**
 * Compare the same patch location between two screenshots.
 *
 * @returns true for identical pixels, false for a real mismatch, and null
 * when no comparison can be performed (invalid rect or unavailable crop).
 */
export async function comparePixelAtLocation(
  crop: CropRawPatchFn,
  lastScreenshot: ScreenshotResult,
  freshScreenshot: ScreenshotResult,
  xPercent: number,
  yPercent: number,
  gridSize = DEFAULT_GRID_SIZE,
  tolerance = 0,
): Promise<boolean | null> {
  // Both screenshots are of the same display — use the fresh one's
  // dimensions (less likely to be stale than last's).
  if (lastScreenshot.width !== freshScreenshot.width || lastScreenshot.height !== freshScreenshot.height ||
      lastScreenshot.displayWidth !== freshScreenshot.displayWidth || lastScreenshot.displayHeight !== freshScreenshot.displayHeight ||
      lastScreenshot.originX !== freshScreenshot.originX || lastScreenshot.originY !== freshScreenshot.originY ||
      lastScreenshot.displayId !== freshScreenshot.displayId || lastScreenshot.targetRevision !== freshScreenshot.targetRevision) return false;
  const rect = computeCropRect(freshScreenshot.width, freshScreenshot.height, xPercent, yPercent, gridSize);
  if (!rect) return null;
  const [previous, current] = await Promise.all([crop(lastScreenshot.base64, rect), crop(freshScreenshot.base64, rect)]);
  if (!previous || !current || previous.length === 0 || previous.length !== current.length) return null;
  if (tolerance === 0) return previous.equals(current);
  let difference = 0;
  for (let i = 0; i < previous.length; i++) difference += Math.abs(previous[i]! - current[i]!);
  return difference <= tolerance * previous.length;
}

/**
 * Battle-tested click-target validation ported from the Vercept acquisition,
 * with the fresh-screenshot capture delegated to the caller (we don't have
 * a global `SystemActions.takeScreenshot()` — the executor is injected).
 *
 * Skip conditions (any of these → `{ valid: true, skipped: true }`):
 *   - `lastScreenshot` is undefined (cold start).
 *   - `takeFreshScreenshot()` throws or returns null.
 *   - Injected crop function returns null (decode failure).
 *   - Any other exception.
 *
 * The caller decides whether to invoke this at all (sub-gate check lives
 * in toolCalls.ts, not here).
 */
export async function validateClickTarget(
  crop: CropRawPatchFn,
  lastScreenshot: ScreenshotResult | undefined,
  xPercent: number,
  yPercent: number,
  takeFreshScreenshot: () => Promise<ScreenshotResult | null>,
  logger: Logger,
  gridSize = DEFAULT_GRID_SIZE,
  tolerance = 0,
): Promise<PixelCompareResult> {
  if (!lastScreenshot) {
    return { valid: true, skipped: true };
  }

  try {
    const fresh = await takeFreshScreenshot();
    if (!fresh) {
      return { valid: true, skipped: true };
    }

    const pixelsMatch = await comparePixelAtLocation(
      crop,
      lastScreenshot,
      fresh,
      xPercent,
      yPercent,
      gridSize,
      tolerance,
    );

    if (pixelsMatch === null) {
      return { valid: true, skipped: true };
    }
    if (pixelsMatch) {
      return { valid: true, skipped: false };
    }
    return {
      valid: false,
      skipped: false,
      warning:
        "Screen content at the target location changed since the last screenshot. Take a new screenshot before clicking.",
    };
  } catch (err) {
    // The caller decides whether a skipped comparison can proceed.
    logger.debug("[pixelCompare] validation error, skipping", err);
    return { valid: true, skipped: true };
  }
}
