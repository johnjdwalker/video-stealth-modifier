import { SoraFillMode, WatermarkCoords } from '../types';
import { inpaintCanvasRegion } from './inpaint';

/**
 * The fill engine: everything that decides what replaces the watermark's pixels.
 *
 * Shared by all three consumers — the single-frame preview, the real-time
 * MediaRecorder export and the WebCodecs export — so what the user judges in
 * the preview is exactly what lands in the file, whichever pipeline runs.
 */

// Feathering width (source pixels) around the patched region.
const FEATHER_PIXELS = 6;

// Donor validation for temporal fill. A donor is only usable while the pixels
// around the mark still match the live frame; past this mean per-channel
// difference the scene has moved and borrowing would smear stale content in.
// 18/255 tolerates compression noise and lighting drift but not real motion.
const RING_MATCH_MAX_DIFF = 18;
const RING_SAMPLE_STRIDE = 2;
// How often the donor check runs, in seconds of media time.
const DONOR_RECHECK_SECONDS = 0.25;

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface Reference {
  time: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  box: WatermarkCoords | null;
}

export interface Scratch {
  mask: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D | null;
  patch: HTMLCanvasElement;
  patchCtx: CanvasRenderingContext2D | null;
  // Whether the current donor still matches the live frame. Re-checked at most
  // every DONOR_RECHECK_SECONDS so the pixel readback stays off the hot path.
  donorCheckedAt: number;
  donorUsable: boolean;
}

export function createScratch(): Scratch {
  const mask = document.createElement('canvas');
  const patch = document.createElement('canvas');
  return {
    mask,
    maskCtx: mask.getContext('2d', { willReadFrequently: true }),
    patch,
    patchCtx: patch.getContext('2d', { willReadFrequently: true }),
    donorCheckedAt: -Infinity,
    donorUsable: false,
  };
}

/** Resizes a scratch canvas, or clears it when it is already the right size. */
function sizeScratch(
  cvs: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number
): void {
  if (cvs.width !== w || cvs.height !== h) {
    cvs.width = w;
    cvs.height = h;
  } else {
    ctx.clearRect(0, 0, w, h);
  }
}

/**
 * Paints a rectangular feather mask of `w`x`h`.
 *
 * `core` makes the middle opaque and fades the outermost `feather` pixels to
 * nothing; `rim` is the exact inverse. The falloff runs per edge rather than
 * radially: a circle inscribed in a rectangle leaves the corners outside its
 * radius, which let the original watermark bleed back through the corners of
 * every patch.
 */
function paintFeatherMask(
  ctx: CanvasRenderingContext2D, w: number, h: number, feather: number, kind: 'core' | 'rim'
): void {
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    return grad;
  };

  if (kind === 'core') {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.fillStyle = edge(0, 0, feather, 0);         ctx.fillRect(0, 0, feather, h);
  ctx.fillStyle = edge(w, 0, w - feather, 0);     ctx.fillRect(w - feather, 0, feather, h);
  ctx.fillStyle = edge(0, 0, 0, feather);         ctx.fillRect(0, 0, w, feather);
  ctx.fillStyle = edge(0, h, 0, h - feather);     ctx.fillRect(0, h - feather, w, feather);

  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Mean per-channel difference between the live frame and a donor frame over the
 * ring of pixels surrounding `box` — the mark itself is excluded, since the
 * donor is by definition clean there and the live frame is not.
 *
 * Temporal fill copies donor pixels from the same coordinates at a different
 * time, so it is only valid while the background under the mark has not moved.
 * A large ring difference means the scene shifted and those coordinates now hold
 * something else entirely; borrowing would stamp a stale patch over live content.
 */
function donorRingMismatch(
  ctx: CanvasRenderingContext2D,
  ref: Reference,
  box: WatermarkCoords,
  W: number,
  H: number
): number {
  const margin = clamp(Math.round(Math.max(box.width, box.height) * 0.35), 6, 48);
  const rx = clamp(box.x - margin, 0, Math.max(0, W - 1));
  const ry = clamp(box.y - margin, 0, Math.max(0, H - 1));
  const rw = clamp(box.width + margin * 2, 1, W - rx);
  const rh = clamp(box.height + margin * 2, 1, H - ry);
  if (rw < 4 || rh < 4) return 0;

  const live = ctx.getImageData(rx, ry, rw, rh).data;
  const donor = ref.ctx.getImageData(rx, ry, rw, rh).data;

  // The mark's own box, in coordinates local to the sampled region.
  const ix0 = box.x - rx, iy0 = box.y - ry;
  const ix1 = ix0 + box.width, iy1 = iy0 + box.height;

  let total = 0;
  let samples = 0;
  for (let y = 0; y < rh; y += RING_SAMPLE_STRIDE) {
    const insideY = y >= iy0 && y < iy1;
    for (let x = 0; x < rw; x += RING_SAMPLE_STRIDE) {
      if (insideY && x >= ix0 && x < ix1) continue;
      const p = (y * rw + x) * 4;
      total += Math.abs(live[p] - donor[p]) +
               Math.abs(live[p + 1] - donor[p + 1]) +
               Math.abs(live[p + 2] - donor[p + 2]);
      samples += 3;
    }
  }
  return samples > 0 ? total / samples : 0;
}

function boxesOverlap(a: WatermarkCoords, b: WatermarkCoords): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

/** The temporally closest reference whose own watermark box misses `box`. */
function pickCleanReference(
  references: Reference[], currentTime: number, box: WatermarkCoords
): Reference | null {
  let best: Reference | null = null;
  let bestDt = Infinity;
  for (const ref of references) {
    if (ref.box && boxesOverlap(ref.box, box)) continue;
    const dt = Math.abs(ref.time - currentTime);
    if (dt < bestDt) { bestDt = dt; best = ref; }
  }
  return best;
}

/**
 * Inpaints the region and feathers its rim back into the untouched pixels, so
 * the reconstruction fades out instead of ending on a visible rectangle edge.
 */
function inpaintFeathered(
  ctx: CanvasRenderingContext2D,
  scratch: Scratch,
  box: WatermarkCoords,
  W: number,
  H: number
): void {
  const { patch, patchCtx, mask, maskCtx } = scratch;
  const feather = Math.min(FEATHER_PIXELS, Math.floor(Math.min(box.width, box.height) / 2));
  if (feather <= 0 || !patchCtx || !maskCtx) {
    inpaintCanvasRegion(ctx, box.x, box.y, box.width, box.height, W, H);
    return;
  }

  // Keep the untouched pixels before the fill overwrites them.
  sizeScratch(patch, patchCtx, box.width, box.height);
  patchCtx.globalCompositeOperation = 'source-over';
  patchCtx.drawImage(ctx.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);

  inpaintCanvasRegion(ctx, box.x, box.y, box.width, box.height, W, H);

  // Mask is clear in the core and opaque at the rim, so drawing the saved
  // originals back restores the outer edge and leaves the fill in the middle.
  sizeScratch(mask, maskCtx, box.width, box.height);
  paintFeatherMask(maskCtx, box.width, box.height, feather, 'rim');

  patchCtx.globalCompositeOperation = 'destination-in';
  patchCtx.drawImage(mask, 0, 0);
  patchCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(patch, box.x, box.y);
}

export function applyFill(
  ctx: CanvasRenderingContext2D,
  scratch: Scratch,
  references: Reference[],
  currentTime: number,
  box: WatermarkCoords,
  W: number,
  H: number,
  fillMode: SoraFillMode
): void {
  if (box.width <= 0 || box.height <= 0) return;

  if (fillMode === 'inpaint') {
    inpaintFeathered(ctx, scratch, box, W, H);
    return;
  }

  const ref = pickCleanReference(references, currentTime, box);
  if (!ref) {
    // `temporal` promised real pixels and there are none clean enough; falling
    // back beats stamping the watermark back over itself from a bad donor.
    inpaintFeathered(ctx, scratch, box, W, H);
    return;
  }

  // `auto` only borrows while the donor still lines up with the live frame.
  // `temporal` is an explicit request for real pixels, so it borrows regardless.
  if (fillMode === 'auto') {
    if (Math.abs(currentTime - scratch.donorCheckedAt) >= DONOR_RECHECK_SECONDS) {
      scratch.donorCheckedAt = currentTime;
      scratch.donorUsable = donorRingMismatch(ctx, ref, box, W, H) <= RING_MATCH_MAX_DIFF;
    }
    if (!scratch.donorUsable) {
      inpaintFeathered(ctx, scratch, box, W, H);
      return;
    }
  }

  const { maskCtx, patchCtx, mask, patch } = scratch;
  if (!maskCtx || !patchCtx) return;

  const feather = Math.min(FEATHER_PIXELS, Math.floor(Math.min(box.width, box.height) / 2));

  sizeScratch(mask, maskCtx, box.width, box.height);
  if (feather <= 0) {
    maskCtx.fillStyle = 'white';
    maskCtx.fillRect(0, 0, box.width, box.height);
  } else {
    paintFeatherMask(maskCtx, box.width, box.height, feather, 'core');
  }

  sizeScratch(patch, patchCtx, box.width, box.height);
  patchCtx.globalCompositeOperation = 'source-over';
  patchCtx.drawImage(ref.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  patchCtx.globalCompositeOperation = 'destination-in';
  patchCtx.drawImage(mask, 0, 0);
  patchCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(patch, box.x, box.y);
}
