import { SoraDwell, SoraWatermarkSample, WatermarkCoords } from '../types';

/**
 * Sora 2 watermark detection.
 *
 * The previous detector looked for "bright and low-saturation" blobs, which
 * also describes an overcast sky, a white phone UI, a white shirt — so it
 * locked onto ordinary content constantly. Two things separate a composited
 * watermark from bright content, and this detector uses both:
 *
 *  1. LOCAL CONTRAST (white top-hat). The watermark is a small bright mark laid
 *     *on top of* whatever is underneath. Subtracting a local mean leaves it
 *     standing out while the interior of any large bright region (sky, wall,
 *     phone screen) collapses to roughly zero. This is what kills the false
 *     positives that raw brightness cannot.
 *
 *  2. PERSISTENCE. The watermark holds one position for seconds at a time while
 *     the content behind it changes. Transient bright things fail this.
 *
 * On top of that we apply hard Sora-specific priors: the mark is small, much
 * wider than it is tall (icon + "Sora" wordmark), and sits near a frame edge.
 */

// Working resolution: the long side is scaled to this before analysis.
export const WORK_LONG_SIDE = 480;

// Top-hat radius as a fraction of the long side. Must comfortably exceed the
// watermark's stroke thickness but stay well under the size of a sky/wall.
const TOPHAT_RADIUS_FRAC = 0.035;
// Minimum local-contrast response (0-255) for a pixel to be watermark-like.
// Sora marks are sometimes rendered at partial opacity, so keep this low.
const TOPHAT_MIN = 14;
// The mark is white-ish: a floor on absolute luminance and a ceiling on saturation.
// Partial-opacity marks on bright backgrounds can be dimmer than expected.
const MIN_LUMINANCE = 110;
const MAX_SATURATION = 110;

// Horizontal closing radius (fraction of long side) used to merge the icon and
// the individual letters of "Sora" into a single connected blob.
const CLOSE_RADIUS_X_FRAC = 0.018;
const CLOSE_RADIUS_Y_FRAC = 0.004;

// Shape priors for the Sora mark, relative to the frame's *width*.
const MIN_MARK_W_FRAC = 0.05;
const MAX_MARK_W_FRAC = 0.45;
const MIN_MARK_H_FRAC = 0.012;
const MAX_MARK_H_FRAC = 0.14;
// Icon + wordmark is a wide, short shape.
const MIN_ASPECT = 1.4;
const MAX_ASPECT = 8.0;

// Fraction of a candidate's box that should be watermark-like. Below the band
// is noise; above it is a solid shape rather than an icon plus lettering.
const DENSITY_IDEAL_MIN = 0.10;
const DENSITY_IDEAL_MAX = 0.70;

// The mark hugs an edge: its centre must fall in the outer band of the frame
// on at least one axis.  0.45 is generous enough for marks that sit near (but
// not at) a corner, including marks near a face in the upper portion of the frame.
const EDGE_BAND_FRAC = 0.45;

// Candidates kept per sampled frame, so clustering can recover when the best
// scoring blob in one frame is a fluke.
const CANDIDATES_PER_FRAME = 4;

// Clustering: candidates join a dwell if their centres are within this
// fraction of the frame diagonal and they are close enough in time.
const DWELL_CENTRE_TOLERANCE_FRAC = 0.05;
const DWELL_MAX_SAMPLE_GAP = 2;
// A dwell needs at least this many samples to be believed.
// 2 is enough to confirm persistence; 3 risks missing the mark in short clips.
const MIN_DWELL_SAMPLES = 2;

export interface DetectionCandidate {
  bbox: WatermarkCoords;   // work-resolution pixels
  score: number;           // 0-1
  contrast: number;        // mean top-hat response inside the box
}

/** Integral image over a Float32 plane, for O(1) box sums. */
function buildIntegral(src: Float32Array, W: number, H: number): Float64Array {
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += src[y * W + x];
      integral[(y + 1) * (W + 1) + (x + 1)] = integral[y * (W + 1) + (x + 1)] + rowSum;
    }
  }
  return integral;
}

function boxMean(
  integral: Float64Array, W: number, H: number,
  cx: number, cy: number, radius: number
): number {
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const x1 = Math.min(W - 1, cx + radius);
  const y1 = Math.min(H - 1, cy + radius);
  const stride = W + 1;
  const sum =
    integral[(y1 + 1) * stride + (x1 + 1)] -
    integral[y0 * stride + (x1 + 1)] -
    integral[(y1 + 1) * stride + x0] +
    integral[y0 * stride + x0];
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  return area > 0 ? sum / area : 0;
}

/** Separable binary dilation, used to close gaps between the logo's glyphs. */
function dilate(mask: Uint8Array, W: number, H: number, rx: number, ry: number): Uint8Array {
  let src = mask;
  if (rx > 0) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        if (!src[row + x]) continue;
        const from = Math.max(0, x - rx);
        const to = Math.min(W - 1, x + rx);
        for (let k = from; k <= to; k++) out[row + k] = 1;
      }
    }
    src = out;
  }
  if (ry > 0) {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const from = Math.max(0, y - ry);
      const to = Math.min(H - 1, y + ry);
      for (let x = 0; x < W; x++) {
        if (!src[y * W + x]) continue;
        for (let k = from; k <= to; k++) out[k * W + x] = 1;
      }
    }
    src = out;
  }
  return src;
}

/**
 * Finds watermark candidates in one frame. Returns up to
 * CANDIDATES_PER_FRAME boxes in work-resolution pixels, best first.
 */
export function findCandidates(imageData: ImageData, W: number, H: number): DetectionCandidate[] {
  const data = imageData.data;
  const lum = new Float32Array(W * H);
  const sat = new Float32Array(W * H);

  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const longSide = Math.max(W, H);
  const radius = Math.max(4, Math.round(TOPHAT_RADIUS_FRAC * longSide));
  const integral = buildIntegral(lum, W, H);

  // White top-hat: how much brighter each pixel is than its neighbourhood.
  const tophat = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const response = lum[i] - boxMean(integral, W, H, x, y, radius);
      tophat[i] = response;
      if (response >= TOPHAT_MIN && lum[i] >= MIN_LUMINANCE && sat[i] <= MAX_SATURATION) {
        mask[i] = 1;
      }
    }
  }

  // Close horizontally so "S o r a" and the icon become one component.
  const closed = dilate(
    mask, W, H,
    Math.max(1, Math.round(CLOSE_RADIUS_X_FRAC * longSide)),
    Math.max(1, Math.round(CLOSE_RADIUS_Y_FRAC * longSide))
  );

  // Connected components.
  const visited = new Uint8Array(W * H);
  const stack: number[] = [];
  const candidates: DetectionCandidate[] = [];

  const minW = MIN_MARK_W_FRAC * W;
  const maxW = MAX_MARK_W_FRAC * W;
  const minH = MIN_MARK_H_FRAC * W;
  const maxH = MAX_MARK_H_FRAC * W;
  const diag = Math.hypot(W, H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const start = y * W + x;
      if (!closed[start] || visited[start]) continue;

      // Bounds are tracked over the *original* mask pixels, not the dilated
      // ones: the closing exists only to join the glyphs, and letting it widen
      // the reported box would patch a noticeably larger area than the mark.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let count = 0, contrastSum = 0, corePixels = 0;
      stack.length = 0;
      stack.push(start);
      visited[start] = 1;

      while (stack.length) {
        const idx = stack.pop()!;
        const cy = (idx / W) | 0;
        const cx = idx - cy * W;
        count++;
        if (mask[idx]) {
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          contrastSum += tophat[idx];
          corePixels++;
        }

        if (cx > 0)     { const n = idx - 1; if (closed[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cx < W - 1) { const n = idx + 1; if (closed[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy > 0)     { const n = idx - W; if (closed[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy < H - 1) { const n = idx + W; if (closed[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }

      if (corePixels === 0) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < minW || bw > maxW || bh < minH || bh > maxH) continue;

      const aspect = bw / bh;
      if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;

      // Must hug an edge on at least one axis.
      const cxc = minX + bw / 2;
      const cyc = minY + bh / 2;
      const nearX = cxc < W * EDGE_BAND_FRAC || cxc > W * (1 - EDGE_BAND_FRAC);
      const nearY = cyc < H * EDGE_BAND_FRAC || cyc > H * (1 - EDGE_BAND_FRAC);
      if (!nearX && !nearY) continue;

      const meanContrast = contrastSum / corePixels;
      // Fraction of the box that is genuinely watermark-like. A real mark is
      // sparse (glyphs), so mid-range density scores best; a solid slab of
      // white scores poorly.
      const density = corePixels / (bw * bh);
      // An icon plus a wordmark fills much, but not all, of its box. Accept a
      // band rather than a single value: too sparse is noise, too solid is a
      // filled shape rather than a logo.
      const densityFit =
        density < DENSITY_IDEAL_MIN ? Math.max(0, 1 - (DENSITY_IDEAL_MIN - density) / 0.20) :
        density > DENSITY_IDEAL_MAX ? Math.max(0, 1 - (density - DENSITY_IDEAL_MAX) / 0.30) :
        1;
      // Sora's icon+wordmark sits around 3-4:1.
      const aspectFit = 1 - Math.min(1, Math.abs(aspect - 3.4) / 3.4);
      const distToEdge = Math.min(cxc, W - cxc, cyc, H - cyc);
      const edgeFit = 1 - Math.min(1, distToEdge / (Math.min(W, H) * EDGE_BAND_FRAC));
      const contrastFit = Math.min(1, meanContrast / 70);

      const score =
        contrastFit * 0.40 +
        densityFit  * 0.20 +
        aspectFit   * 0.22 +
        edgeFit     * 0.18;

      candidates.push({
        bbox: { x: minX, y: minY, width: bw, height: bh },
        score,
        contrast: meanContrast,
      });
      void diag;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CANDIDATES_PER_FRAME);
}

interface Track {
  samples: SoraWatermarkSample[];
  lastIndex: number;
  scoreSum: number;
}

function centreOf(b: WatermarkCoords): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Groups per-frame candidates into dwells: runs of samples that stay in one
 * place. This is what turns "34 unrelated bright blobs" into "the watermark sat
 * bottom-left for 6s, then top-left for 9s".
 */
export function buildDwells(
  perFrame: { time: number; index: number; candidates: DetectionCandidate[] }[],
  videoWidth: number,
  videoHeight: number
): { dwells: SoraDwell[]; logoSize: { width: number; height: number } | null } {
  const tolerance = Math.hypot(videoWidth, videoHeight) * DWELL_CENTRE_TOLERANCE_FRAC;
  const tracks: Track[] = [];

  for (const frame of perFrame) {
    for (const cand of frame.candidates) {
      const centre = centreOf(cand.bbox);
      let best: Track | null = null;
      let bestDist = Infinity;

      for (const track of tracks) {
        if (frame.index - track.lastIndex > DWELL_MAX_SAMPLE_GAP) continue;
        if (frame.index === track.lastIndex) continue; // one sample per frame per track
        const last = centreOf(track.samples[track.samples.length - 1].bbox);
        const dist = Math.hypot(centre.x - last.x, centre.y - last.y);
        if (dist <= tolerance && dist < bestDist) {
          bestDist = dist;
          best = track;
        }
      }

      const sample: SoraWatermarkSample = {
        time: frame.time,
        bbox: cand.bbox,
        confidence: Math.round(Math.max(0, Math.min(1, cand.score)) * 100),
      };

      if (best) {
        best.samples.push(sample);
        best.lastIndex = frame.index;
        best.scoreSum += cand.score;
      } else {
        tracks.push({ samples: [sample], lastIndex: frame.index, scoreSum: cand.score });
      }
    }
  }

  const viable = tracks.filter((t) => t.samples.length >= MIN_DWELL_SAMPLES);
  if (viable.length === 0) return { dwells: [], logoSize: null };

  // The watermark has one size for the whole clip. Use the median size across
  // all viable tracks to reject tracks with an inconsistent footprint.
  const allWidths = viable.flatMap((t) => t.samples.map((s) => s.bbox.width));
  const allHeights = viable.flatMap((t) => t.samples.map((s) => s.bbox.height));
  const medianW = median(allWidths);
  const medianH = median(allHeights);

  const scored = viable.map((track) => {
    const widths = track.samples.map((s) => s.bbox.width);
    const heights = track.samples.map((s) => s.bbox.height);
    const tw = median(widths);
    const th = median(heights);
    const sizeDeviation =
      Math.abs(tw - medianW) / Math.max(1, medianW) +
      Math.abs(th - medianH) / Math.max(1, medianH);
    const sizeFit = Math.max(0, 1 - sizeDeviation);
    const meanScore = track.scoreSum / track.samples.length;
    // Longer dwells with consistent geometry win.
    const rank = meanScore * 0.5 + sizeFit * 0.3 + Math.min(1, track.samples.length / 8) * 0.2;

    const cxs = track.samples.map((s) => s.bbox.x + s.bbox.width / 2);
    const cys = track.samples.map((s) => s.bbox.y + s.bbox.height / 2);
    const bbox: WatermarkCoords = {
      x: Math.round(median(cxs) - tw / 2),
      y: Math.round(median(cys) - th / 2),
      width: Math.round(tw),
      height: Math.round(th),
    };

    return {
      rank,
      bbox,
      samples: track.samples,
      confidence: Math.round(Math.max(0, Math.min(1, meanScore * sizeFit)) * 100),
    };
  });

  // One watermark at a time: accept the best tracks that do not overlap in time.
  scored.sort((a, b) => b.rank - a.rank);
  const accepted: typeof scored = [];
  for (const track of scored) {
    const start = track.samples[0].time;
    const end = track.samples[track.samples.length - 1].time;
    const clashes = accepted.some((a) => {
      const aStart = a.samples[0].time;
      const aEnd = a.samples[a.samples.length - 1].time;
      return !(end < aStart || aEnd < start);
    });
    if (!clashes) accepted.push(track);
  }

  accepted.sort((a, b) => a.samples[0].time - b.samples[0].time);

  const dwells: SoraDwell[] = accepted.map((track) => ({
    startTime: track.samples[0].time,
    endTime: track.samples[track.samples.length - 1].time,
    bbox: track.bbox,
    samples: track.samples,
    confidence: track.confidence,
    source: 'auto' as const,
  }));

  return {
    dwells,
    logoSize: { width: Math.round(medianW), height: Math.round(medianH) },
  };
}

/**
 * Extends each dwell to meet its neighbours so the whole clip is covered.
 * The watermark fades between positions; leaving the midpoint uncovered would
 * let the tail of the fade through.
 */
export function bridgeDwells(dwells: SoraDwell[], duration: number): SoraDwell[] {
  if (dwells.length === 0) return dwells;
  return dwells.map((dwell, i) => {
    const prev = dwells[i - 1];
    const next = dwells[i + 1];
    const start = prev ? (prev.endTime + dwell.startTime) / 2 : 0;
    const end = next ? (dwell.endTime + next.startTime) / 2 : duration;
    return { ...dwell, startTime: start, endTime: end };
  });
}
