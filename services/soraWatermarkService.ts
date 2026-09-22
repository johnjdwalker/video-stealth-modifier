import {
  SoraRemovalQuality,
  SoraWatermarkDetection,
  SoraWatermarkSample,
  WatermarkCoords,
} from '../types';

// ----------------------------------------------------------------------------
// Tunable detection / removal constants for Sora 2-style watermarks.
//
// Sora's animated watermark is a small white-ish translucent logo that bounces
// across the frame. We exploit two facts:
//
//   1. Bright translucent overlay: brighter and lower-saturation than the
//      typical content underneath, with a fairly uniform luminance.
//   2. It moves continuously, so any pixel it covers right now was uncovered
//      at some other moment in time. That gives us a clean "donor" pixel for
//      every covered pixel.
// ----------------------------------------------------------------------------

const DETECTION_TARGET_SAMPLES = 110;       // denser — Sora logo teleports between corners
const DETECTION_MAX_SAMPLE_INTERVAL = 0.28; // seconds; clamps very long videos
const DETECTION_MIN_SAMPLE_INTERVAL = 0.05; // seconds; clamps very short videos

// Luminance threshold (0-255). Pixels brighter than this are watermark candidates.
const BRIGHT_THRESHOLD = 200;
// Saturation threshold (0-255 max-min). Below this is "white-ish".
const LOW_SATURATION_THRESHOLD = 60;
// Working resolution for detection (downscaled). Higher = more accurate logos/text.
const DETECTION_WORK_WIDTH = 640;

// Watermark size constraints, expressed as fractions of the video's longer side.
// Sora's logo is small relative to the frame.
const MIN_WATERMARK_FRAC = 0.015;
// Hard cap: reject huge sky/asphalt/face blobs that drown the small logo+text strip.
const MAX_WATERMARK_FRAC = 0.16;
const MAX_WATERMARK_HEIGHT_FRAC = 0.14;

// Sora logo+text strip aspect prior (width/height). Typical strip is wide.
const ASPECT_PRIOR_MIN = 1.4;
const ASPECT_PRIOR_MAX = 7.0;
const ASPECT_PRIOR_SOFT_MIN = 1.0;
const ASPECT_PRIOR_SOFT_MAX = 9.0;

// Reference frame counts per quality level. More references = better fill, more memory.
const REFERENCE_FRAME_COUNTS: Record<SoraRemovalQuality, number> = {
  fast: 12,
  balanced: 22,
  high: 32,
};

// Feathering radius (in pixels at full resolution) around the per-frame mask.
const FEATHER_PIXELS = 10;
// Dilate the bright-pixel mask hard so thin glyphs / soft AA edges are covered.
const MASK_DILATE_PX = 11;
// Extra morphological close radius after dilate (connects broken thin text strokes).
const MASK_CLOSE_PX = 4;

// Padding (in pixels at full resolution) added around each detected bbox to
// catch soft edges, antialiasing, thin text, and slight motion between samples.
const DEFAULT_PADDING = 34;
// Extra horizontal padding — Sora text strip + @username is wider than the logo alone.
const DEFAULT_PADDING_X_EXTRA = 28;
// Extra vertical padding — handle line sits below "Sora".
const DEFAULT_PADDING_Y_EXTRA = 14;
// Morphological close radius (work-res) before connected components — merges glyph strokes.
const DETECT_CLOSE_PX = 5;
// (Trajectory is piecewise-constant across slot hops; no spatial lerp.)
// Per-frame snap: search pad around predicted bbox (full-res px).
const SNAP_SEARCH_PAD = 140;
const SNAP_MIN_SCORE = 0.34;

// ---------------------------------------------------------------------------
// 9-slot dwell prior (Sora hops between edge/corner cells; multi-second holds).
// Slots: TL TC TR / ML C MR / BL BC BR. Corners & edges preferred over center.
// Trajectory is piecewise-constant across slot changes — never lerp mid-frame.
// ---------------------------------------------------------------------------
const SLOT_IDS = ['TL','TC','TR','ML','C','MR','BL','BC','BR'] as const;
type SlotId = typeof SLOT_IDS[number];
/** Soft prior weight per slot (corners highest, center lowest). */
const SLOT_EDGE_WEIGHT: Record<SlotId, number> = {
  TL: 1.00, TC: 0.78, TR: 1.00,
  ML: 0.78, C: 0.35, MR: 0.78,
  BL: 1.00, BC: 0.78, BR: 1.00,
};
/** Hysteresis: new slot must beat current by this margin to switch. */
const SLOT_SWITCH_MARGIN = 0.08;
/** Stickiness bonus for remaining in the previous slot. */
const SLOT_STICK_BONUS = 0.12;

// How many clean donor frames to blend for each patch (edge-aware multi-ref).
const MULTI_REF_BLEND = 5;

// Soft logo+text strip prior alpha (unioned with dilated bright mask).
const STRIP_PRIOR_PEAK = 235;
// Surround-sample (Telea-like) radius in ROI pixels.
const SURROUND_RADIUS = 7;
// After first fill, if ROI bright fraction still exceeds this → nuclear box fill.
const NUCLEAR_BRIGHT_FRAC = 0.06;
// Outer ring (px) preserved / feathered during nuclear full-ROI paste.
const NUCLEAR_EDGE_FEATHER = 14;

// Residual verification: tighter thresholds + denser trajectory sampling.
// Average ROI bright fraction above this fails; any single sample above MAX fails.
const RESIDUAL_FAIL_FRACTION = 0.018;
const RESIDUAL_FAIL_FRACTION_MAX = 0.035;
const RESIDUAL_SAMPLE_COUNT = 24;
// Minimum connected bright cluster (px) inside ROI that matches logo+text prior → fail.
const RESIDUAL_CLUSTER_MIN_PX = 28;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

interface SoraDetectionOptions {
  /** Optional manual region to seed/anchor detection. If provided, detection
   *  is skipped and the manual region is used as a constant trajectory. */
  manualRegion?: WatermarkCoords;
  signal?: AbortSignal;
}

/**
 * Detects the Sora 2 / ChatGPT animated watermark by sampling frames evenly
 * across the video and tracking a small bright translucent cluster. Returns a
 * trajectory (time, bbox) used by `removeSoraWatermark` to drive temporal fill.
 */
export async function detectSoraWatermark(
  videoFile: File,
  onProgress?: (progress: number, stage?: string) => void,
  options: SoraDetectionOptions = {}
): Promise<SoraWatermarkDetection> {
  const { manualRegion, signal } = options;
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  video.crossOrigin = 'anonymous';

  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const videoDuration = isFinite(video.duration) ? video.duration : 0;

    if (!videoWidth || !videoHeight || videoDuration <= 0) {
      return {
        detected: false,
        videoWidth, videoHeight, videoDuration,
        trajectory: [],
        padding: DEFAULT_PADDING,
        averageConfidence: 0,
        message: 'Could not read video dimensions or duration.',
      };
    }

    if (manualRegion) {
      const clamped = clampBox(manualRegion, videoWidth, videoHeight);
      // For a manual region we still emit a couple of samples so the trajectory
      // interpolation logic stays uniform.
      const trajectory: SoraWatermarkSample[] = [
        { time: 0, bbox: clamped, confidence: 100 },
        { time: videoDuration, bbox: clamped, confidence: 100 },
      ];
      return {
        detected: true,
        videoWidth, videoHeight, videoDuration,
        trajectory,
        padding: DEFAULT_PADDING,
        averageConfidence: 100,
        message: 'Manual watermark region.',
      };
    }

    const sampleInterval = clamp(
      videoDuration / DETECTION_TARGET_SAMPLES,
      DETECTION_MIN_SAMPLE_INTERVAL,
      DETECTION_MAX_SAMPLE_INTERVAL
    );
    const sampleTimes: number[] = [];
    for (let t = sampleInterval / 2; t < videoDuration; t += sampleInterval) {
      sampleTimes.push(Math.min(videoDuration - 0.001, t));
    }
    if (sampleTimes.length === 0) sampleTimes.push(0);

    // Working canvas at downscaled resolution
    const scale = Math.min(1, DETECTION_WORK_WIDTH / videoWidth);
    const workW = Math.max(64, Math.round(videoWidth * scale));
    const workH = Math.max(64, Math.round(videoHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return {
        detected: false,
        videoWidth, videoHeight, videoDuration,
        trajectory: [],
        padding: DEFAULT_PADDING,
        averageConfidence: 0,
        message: 'Canvas 2D context unavailable.',
      };
    }

    const samples: SoraWatermarkSample[] = [];
    let prevBoxWork: WatermarkCoords | null = null;

    for (let i = 0; i < sampleTimes.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = sampleTimes[i];
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, workW, workH);
      const imageData = ctx.getImageData(0, 0, workW, workH);
      const prevSlot = prevBoxWork
        ? slotIdOfPoint(
            prevBoxWork.x + prevBoxWork.width / 2,
            prevBoxWork.y + prevBoxWork.height / 2,
            workW, workH
          )
        : null;
      // 9-slot dwell prior: score logo+text inside each edge/corner cell.
      const candidate = pickBestSlot(imageData, workW, workH, prevSlot);
      if (candidate && candidate.score >= SNAP_MIN_SCORE * 0.85) {
        // Scale work-resolution box back to video resolution.
        const bbox: WatermarkCoords = {
          x: Math.round(candidate.bbox.x / scale),
          y: Math.round(candidate.bbox.y / scale),
          width: Math.round(candidate.bbox.width / scale),
          height: Math.round(candidate.bbox.height / scale),
        };
        samples.push({ time: t, bbox: clampBox(bbox, videoWidth, videoHeight), confidence: candidate.confidence });
        prevBoxWork = candidate.bbox;
      }
      onProgress?.((i + 1) / sampleTimes.length * 100, 'Detecting watermark');
    }

    if (samples.length === 0) {
      return {
        detected: false,
        videoWidth, videoHeight, videoDuration,
        trajectory: [],
        padding: DEFAULT_PADDING,
        averageConfidence: 0,
        message: 'No bouncing bright cluster matching a Sora-style watermark was found.',
      };
    }

    // Drop sparse outliers: if a sample's center jumps far from neighbors and
    // its confidence is low, it's probably a false positive (e.g. a bright object).
    const cleaned = dropOutliers(samples, videoWidth, videoHeight);
    const avgConfidence =
      cleaned.reduce((acc, s) => acc + s.confidence, 0) / Math.max(1, cleaned.length);

    return {
      detected: cleaned.length >= 2,
      videoWidth, videoHeight, videoDuration,
      trajectory: cleaned,
      padding: DEFAULT_PADDING,
      averageConfidence: Math.round(avgConfidence),
      message: cleaned.length >= 2
        ? `Tracked watermark across ${cleaned.length} samples.`
        : 'Detection signal too weak to lock a trajectory. Try Manual mode.',
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

interface SoraRemovalOptions {
  quality?: SoraRemovalQuality;
  outputMimeType?: string;
  signal?: AbortSignal;
}

/**
 * Removes a moving Sora-style watermark by re-encoding the video, replacing
 * each frame's watermarked region with content sourced from another point in
 * time when the watermark was elsewhere. Edges are feathered for seamless blending.
 */
export async function removeSoraWatermark(
  videoFile: File,
  detection: SoraWatermarkDetection,
  onProgress?: (progress: number, stage?: string) => void,
  options: SoraRemovalOptions = {}
): Promise<{ blob: Blob; mimeType: string; residualPassed: boolean; residualFraction: number }> {
  const { quality = 'balanced', outputMimeType, signal } = options;
  if (!detection.detected || detection.trajectory.length === 0) {
    throw new Error('No watermark trajectory to remove.');
  }

  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  // Reference frame canvases (kept on offscreen canvases for cheap drawImage).
  type Reference = {
    time: number;
    canvas: HTMLCanvasElement;
    bbox: WatermarkCoords;
  };
  let references: Reference[] = [];

  let mediaRecorder: MediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let rafId = 0;

  const cleanup = async () => {
    if (rafId) cancelAnimationFrame(rafId);
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close(); } catch { /* ignore */ }
    }
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const W = video.videoWidth;
    const H = video.videoHeight;
    const duration = isFinite(video.duration) ? video.duration : detection.videoDuration;

    // Pick reference frame times spread across the video.
    const refCount = REFERENCE_FRAME_COUNTS[quality];
    const refTimes: number[] = [];
    for (let i = 0; i < refCount; i++) {
      const t = duration * ((i + 0.5) / refCount);
      refTimes.push(Math.min(duration - 0.001, Math.max(0, t)));
    }

    // Pre-extract reference frames into offscreen canvases.
    onProgress?.(0, 'Extracting reference frames');
    for (let i = 0; i < refTimes.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = refTimes[i];
      await seekTo(video, t);
      const refCanvas = document.createElement('canvas');
      refCanvas.width = W;
      refCanvas.height = H;
      const refCtx = refCanvas.getContext('2d', { alpha: false });
      if (!refCtx) throw new Error('Could not allocate canvas for reference frame.');
      refCtx.drawImage(video, 0, 0, W, H);
      references.push({
        time: t,
        canvas: refCanvas,
        bbox: bboxAtTime(detection.trajectory, t, W, H, detection.padding),
      });
      onProgress?.(((i + 1) / refTimes.length) * 25, 'Extracting reference frames');
    }

    // Reset video to start for the recording pass.
    await seekTo(video, 0);

    // Recording canvas
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not allocate recording canvas.');

    // Feather mask canvas (radial alpha gradient, sized once).
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) throw new Error('Could not allocate mask canvas.');

    // Audio passthrough
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    let audioTrack: MediaStreamTrack | undefined;
    try {
      const sourceNode = audioContext.createMediaElementSource(video);
      const dest = audioContext.createMediaStreamDestination();
      sourceNode.connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0];
    } catch {
      // No audio is fine — silently continue with video-only output.
    }

    const stream = canvas.captureStream(30);
    const tracks: MediaStreamTrack[] = stream.getVideoTracks();
    if (audioTrack) tracks.push(audioTrack);
    const combinedStream = new MediaStream(tracks);

    const mime = outputMimeType
      || pickFirstSupported(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    if (!mime) throw new Error('No supported MediaRecorder MIME type for WEBM in this browser.');

    mediaRecorder = new MediaRecorder(combinedStream, { mimeType: mime });
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const recordingDone = new Promise<void>((resolve, reject) => {
      mediaRecorder!.onstop = () => resolve();
      mediaRecorder!.onerror = (ev: Event) => {
        const err = (ev as any).error || new Error('MediaRecorder error');
        reject(err instanceof Error ? err : new Error(String(err)));
      };
    });

    let snapCount = 0;
    let lastSlotId: SlotId | null = null;
    let nuclearAppliedTotal = 0;
    const drawFrame = () => {
      if (signal?.aborted) {
        try { mediaRecorder?.stop(); } catch { /* ignore */ }
        return;
      }
      if (video.paused || video.ended) {
        try { mediaRecorder?.stop(); } catch { /* ignore */ }
        return;
      }
      ctx.drawImage(video, 0, 0, W, H);

            const t = video.currentTime;
      const predicted = bboxAtTime(detection.trajectory, t, W, H, detection.padding);

      // Per-frame 9-slot dwell re-score: hold on edge/corner until evidence hops.
      let bbox = predicted;
      let localized = false;
      try {
        const frame = ctx.getImageData(0, 0, W, H);
        const pick = pickBestSlot(frame, W, H, lastSlotId);
        if (pick && pick.score >= SNAP_MIN_SCORE) {
          bbox = padBox(pick.bbox, detection.padding, W, H);
          lastSlotId = pick.slot;
          localized = true;
          snapCount++;
        }
      } catch { /* getImageData can throw on tainted canvas — fall through */ }
      if (!localized) {
        const snap = snapBboxToLocalBright(ctx, predicted, W, H, detection.padding);
        bbox = snap.bbox;
        if (snap.snapped) {
          snapCount++;
          localized = true;
          lastSlotId = slotIdOfPoint(
            bbox.x + bbox.width / 2, bbox.y + bbox.height / 2, W, H
          );
        }
      }

      const nuclearApplied = patchRegion(ctx, maskCtx, maskCanvas, references, t, bbox, W, H, quality);
      if (nuclearApplied) nuclearAppliedTotal++;

      if (duration > 0) {
        const pct = 25 + (t / duration) * 75;
        const note = localized
          ? `Reconstructing frames (slot=${lastSlotId ?? '?'}, nuclearApplied=${nuclearAppliedTotal})`
          : `Reconstructing frames (hold predict, nuclearApplied=${nuclearAppliedTotal})`;
        onProgress?.(Math.min(99.9, pct), note);
      }
      rafId = requestAnimationFrame(drawFrame);
    };

    video.onplay = () => {
      audioContext?.resume().catch(() => undefined);
      rafId = requestAnimationFrame(drawFrame);
    };
    video.onended = () => { try { mediaRecorder?.stop(); } catch { /* ignore */ } };

    onProgress?.(25, 'Reconstructing frames');
    mediaRecorder.start();
    await video.play();
    await recordingDone;

    onProgress?.(96, 'Checking residual watermark');
    const blob = new Blob(chunks, { type: mime });
    const residual = await verifyResidualWatermark(blob, detection, signal);
    onProgress?.(100, residual.passed ? 'Finalizing' : 'Partial removal — residual detected');
    return {
      blob,
      mimeType: mime,
      residualPassed: residual.passed,
      residualFraction: residual.fraction,
    };
  } finally {
    await cleanup();
    references = [];
  }
}

/**
 * Build sample times denser along the known trajectory (plus uniform coverage)
 * so residual checks don't miss the bouncing logo between sparse points.
 */
function residualSampleTimes(
  trajectory: SoraWatermarkSample[],
  duration: number,
  count: number
): number[] {
  const times: number[] = [];
  const seen = new Set<number>();
  const push = (t: number) => {
    const clamped = Math.min(duration - 0.001, Math.max(0, t));
    const key = Math.round(clamped * 1000);
    if (seen.has(key)) return;
    seen.add(key);
    times.push(clamped);
  };

  // Uniform coverage across the clip.
  for (let i = 0; i < count; i++) {
    push(duration * ((i + 0.5) / count));
  }
  // Extra samples at and between trajectory keypoints (where the logo was tracked).
  for (let i = 0; i < trajectory.length; i++) {
    push(trajectory[i].time);
    if (i + 1 < trajectory.length) {
      const a = trajectory[i].time;
      const b = trajectory[i + 1].time;
      push((a + b) / 2);
      // Quarter points when the gap is large (fast bounce).
      if (b - a > 0.35) {
        push(a + (b - a) * 0.25);
        push(a + (b - a) * 0.75);
      }
    }
  }
  times.sort((a, b) => a - b);
  return times;
}

/**
 * Largest connected bright/low-sat cluster inside ROI. Returns pixel count and
 * bbox aspect — used to catch readable logo+text residuals that a raw fraction misses.
 */
function largestBrightClusterInRoi(
  roi: ImageData
): { pixels: number; aspect: number; density: number } | null {
  const bw = roi.width;
  const bh = roi.height;
  const data = roi.data;
  const mask = new Uint8Array(bw * bh);
  for (let i = 0, p = 0; i < bw * bh; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Slightly softer residual thresholds — catch partially cleaned translucent glyphs.
    if (lum >= BRIGHT_THRESHOLD - 8 && sat <= LOW_SATURATION_THRESHOLD + 10) {
      mask[i] = 1;
    }
  }

  const visited = new Uint8Array(bw * bh);
  const stack: number[] = [];
  let bestPixels = 0;
  let bestAspect = 0;
  let bestDensity = 0;

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const start = y * bw + x;
      if (!mask[start] || visited[start]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      stack.length = 0;
      stack.push(start);
      visited[start] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        const cy = (idx / bw) | 0;
        const cx = idx - cy * bw;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        count++;
        if (cx > 0)     { const n = idx - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cx < bw - 1){ const n = idx + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy > 0)     { const n = idx - bw; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy < bh - 1){ const n = idx + bw; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }
      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      const aspect = boxW / Math.max(1, boxH);
      const density = count / Math.max(1, boxW * boxH);
      if (count > bestPixels) {
        bestPixels = count;
        bestAspect = aspect;
        bestDensity = density;
      }
    }
  }
  if (bestPixels <= 0) return null;
  return { pixels: bestPixels, aspect: bestAspect, density: bestDensity };
}

function clusterMatchesLogoTextPrior(cluster: { pixels: number; aspect: number; density: number }): boolean {
  if (cluster.pixels < RESIDUAL_CLUSTER_MIN_PX) return false;
  const aspectOk =
    (cluster.aspect >= ASPECT_PRIOR_SOFT_MIN && cluster.aspect <= ASPECT_PRIOR_SOFT_MAX);
  // Logo+text residuals are mid-density translucent strips (not solid white blobs).
  const densityOk = cluster.density >= 0.08 && cluster.density <= 0.85;
  return aspectOk && densityOk;
}

/**
 * Sample frames from the cleaned output along the watermark trajectory and
 * measure remaining bright translucent clusters inside the expected ROI.
 * Fails (so UI shows Partial) if residual logo+text prior still matches.
 */
export async function verifyResidualWatermark(
  cleanedBlob: Blob,
  detection: SoraWatermarkDetection,
  signal?: AbortSignal
): Promise<{ passed: boolean; fraction: number }> {
  if (!detection.detected || detection.trajectory.length === 0) {
    return { passed: false, fraction: 1 };
  }
  const url = URL.createObjectURL(cleanedBlob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const W = video.videoWidth || detection.videoWidth;
    const H = video.videoHeight || detection.videoHeight;
    const duration = isFinite(video.duration) && video.duration > 0
      ? video.duration
      : detection.videoDuration;
    if (!W || !H || duration <= 0) return { passed: false, fraction: 1 };

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { passed: false, fraction: 1 };

    const sampleTimes = residualSampleTimes(
      detection.trajectory,
      duration,
      RESIDUAL_SAMPLE_COUNT
    );

    let totalMask = 0;
    let totalArea = 0;
    let maxFraction = 0;
    let clusterHit = false;

    for (const t of sampleTimes) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, W, H);
      const bbox = bboxAtTime(detection.trajectory, t, W, H, detection.padding);
      if (bbox.width <= 0 || bbox.height <= 0) continue;
      let roi: ImageData;
      try {
        roi = ctx.getImageData(bbox.x, bbox.y, bbox.width, bbox.height);
      } catch {
        continue;
      }
      const data = roi.data;
      let hits = 0;
      const area = bbox.width * bbox.height;
      for (let p = 0; p < data.length; p += 4) {
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC - minC;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= BRIGHT_THRESHOLD - 8 && sat <= LOW_SATURATION_THRESHOLD + 10) hits++;
      }
      const frac = area > 0 ? hits / area : 0;
      if (frac > maxFraction) maxFraction = frac;
      totalMask += hits;
      totalArea += area;

      const cluster = largestBrightClusterInRoi(roi);
      if (cluster && clusterMatchesLogoTextPrior(cluster)) {
        clusterHit = true;
      }
    }

    const fraction = totalArea > 0 ? totalMask / totalArea : 1;
    const passed =
      !clusterHit &&
      fraction <= RESIDUAL_FAIL_FRACTION &&
      maxFraction <= RESIDUAL_FAIL_FRACTION_MAX;
    return { passed, fraction: Math.max(fraction, maxFraction) };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clampBox(b: WatermarkCoords, W: number, H: number): WatermarkCoords {
  const x = clamp(Math.round(b.x), 0, W - 1);
  const y = clamp(Math.round(b.y), 0, H - 1);
  const width = clamp(Math.round(b.width), 1, W - x);
  const height = clamp(Math.round(b.height), 1, H - y);
  return { x, y, width, height };
}

function pickFirstSupported(candidates: string[]): string | null {
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth > 0) { resolve(); return; }
    const onLoaded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(video.error?.message || 'Failed to load video.')); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(time, (isFinite(video.duration) ? video.duration : time) - 0.001));
    if (Math.abs(video.currentTime - target) < 1 / 240) { resolve(); return; }
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Seek failed.')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try { video.currentTime = target; } catch (e) { cleanup(); reject(e as Error); }
  });
}

interface CandidateBox {
  bbox: WatermarkCoords;
  confidence: number;
}

/**
 * Find a small bright low-saturation cluster — the visual signature of Sora's
 * translucent white logo. Returns null if no plausible candidate is found.
 */

/** Axis-aligned ROI for a dwell slot (overlapping thirds so edge marks aren't clipped). */
function slotRect(id: SlotId, W: number, H: number): WatermarkCoords {
  const col = (id === 'TL' || id === 'ML' || id === 'BL') ? 0
    : (id === 'TC' || id === 'C' || id === 'BC') ? 1 : 2;
  const row = (id === 'TL' || id === 'TC' || id === 'TR') ? 0
    : (id === 'ML' || id === 'C' || id === 'MR') ? 1 : 2;
  const x0 = Math.floor(W * (col === 0 ? 0 : col === 1 ? 0.28 : 0.58));
  const x1 = Math.ceil(W * (col === 0 ? 0.42 : col === 1 ? 0.72 : 1));
  const y0 = Math.floor(H * (row === 0 ? 0 : row === 1 ? 0.28 : 0.58));
  const y1 = Math.ceil(H * (row === 0 ? 0.42 : row === 1 ? 0.72 : 1));
  return {
    x: clamp(x0, 0, W - 1),
    y: clamp(y0, 0, H - 1),
    width: clamp(x1 - x0, 1, W - x0),
    height: clamp(y1 - y0, 1, H - y0),
  };
}

function slotIdOfPoint(x: number, y: number, W: number, H: number): SlotId {
  const col = x < W * 0.33 ? 0 : x < W * 0.66 ? 1 : 2;
  const row = y < H * 0.33 ? 0 : y < H * 0.66 ? 1 : 2;
  return SLOT_IDS[row * 3 + col];
}

interface SlotPick {
  slot: SlotId;
  bbox: WatermarkCoords;
  score: number;
  confidence: number;
}

/**
 * Score logo+text bright clusters inside each of the 9 dwell slots (and
 * optionally boost the previous slot). Returns the best slot's cluster bbox
 * in full-image coordinates. Piecewise-constant tracking prior for Sora hops.
 */
function pickBestSlot(
  imageData: ImageData,
  W: number,
  H: number,
  prevSlot: SlotId | null
): SlotPick | null {
  let best: SlotPick | null = null;
  for (const id of SLOT_IDS) {
    const rect = slotRect(id, W, H);
    // Extract slot crop into a temporary ImageData for the cluster finder.
    const crop = new ImageData(rect.width, rect.height);
    const src = imageData.data;
    const dst = crop.data;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const si = ((rect.y + y) * W + (rect.x + x)) * 4;
        const di = (y * rect.width + x) * 4;
        dst[di] = src[si]; dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
      }
    }
    const hit = findBrightTranslucentCluster(crop, rect.width, rect.height, null);
    if (!hit) continue;
    // Normalize confidence to 0..1 and apply edge prior + stickiness.
    // Eye-pair signature on the full-frame crop strongly prefers real Sora logo.
    // Expand horizontally — cloud icon often CC-separates from "Sora"/@handle.
    const ex = Math.max(6, Math.round(hit.bbox.width * 0.55));
    const eyeBox = {
      x: Math.max(0, rect.x + hit.bbox.x - ex),
      y: Math.max(0, rect.y + hit.bbox.y - 2),
      width: Math.min(W - Math.max(0, rect.x + hit.bbox.x - ex), hit.bbox.width + ex * 2),
      height: Math.min(H - Math.max(0, rect.y + hit.bbox.y - 2), hit.bbox.height + 4),
    };
    const eye = soraIconEyeBonus(src, W, eyeBox);
    let score = (hit.confidence / 100) * SLOT_EDGE_WEIGHT[id] * (0.55 + 0.45 * Math.max(eye, 0.15));
    score += eye * 0.55; // decisive: cloud-eyes beat sky/asphalt blobs
    if (prevSlot === id) score += SLOT_STICK_BONUS;
    if (!best || score > best.score) {
      best = {
        slot: id,
        bbox: {
          x: rect.x + hit.bbox.x,
          y: rect.y + hit.bbox.y,
          width: hit.bbox.width,
          height: hit.bbox.height,
        },
        score,
        confidence: hit.confidence,
      };
    }
  }
  if (!best) return null;
  // Hysteresis: keep previous slot unless challenger beats it by margin.
  // Exception: if challenger has strong cloud-eye evidence and prev does not,
  // allow the hop (Sora teleports to a new corner/edge).
  if (prevSlot && best.slot !== prevSlot) {
    const prevRect = slotRect(prevSlot, W, H);
    const crop = new ImageData(prevRect.width, prevRect.height);
    const src = imageData.data;
    const dst = crop.data;
    for (let y = 0; y < prevRect.height; y++) {
      for (let x = 0; x < prevRect.width; x++) {
        const si = ((prevRect.y + y) * W + (prevRect.x + x)) * 4;
        const di = (y * prevRect.width + x) * 4;
        dst[di] = src[si]; dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
      }
    }
    const prevHit = findBrightTranslucentCluster(crop, prevRect.width, prevRect.height, null);
    if (prevHit) {
      const ex = Math.max(6, Math.round(prevHit.bbox.width * 0.55));
      const prevEyeBox = {
        x: Math.max(0, prevRect.x + prevHit.bbox.x - ex),
        y: Math.max(0, prevRect.y + prevHit.bbox.y - 2),
        width: Math.min(W, prevHit.bbox.width + ex * 2),
        height: Math.min(H, prevHit.bbox.height + 4),
      };
      const prevEye = soraIconEyeBonus(src, W, prevEyeBox);
      const prevScore =
        (prevHit.confidence / 100) * SLOT_EDGE_WEIGHT[prevSlot] * (0.55 + 0.45 * Math.max(prevEye, 0.15))
        + prevEye * 0.55
        + SLOT_STICK_BONUS;
      const challengerHasEyes = best.score > 0.9; // eye-boosted scores land higher
      const prevLostEyes = prevEye < 0.3;
      const allowHop = challengerHasEyes && prevLostEyes;
      if (!allowHop && best.score < prevScore + SLOT_SWITCH_MARGIN) {
        return {
          slot: prevSlot,
          bbox: {
            x: prevRect.x + prevHit.bbox.x,
            y: prevRect.y + prevHit.bbox.y,
            width: prevHit.bbox.width,
            height: prevHit.bbox.height,
          },
          score: prevScore,
          confidence: prevHit.confidence,
        };
      }
    }
  }
  return best;
}


/**
 * Sora's cloud logo has two dark "eye" ovals inside a bright blob. Sky/asphalt
 * bright clusters lack this signature. Returns 0..1 bonus.
 */
function soraIconEyeBonus(
  data: Uint8ClampedArray,
  W: number,
  bbox: WatermarkCoords
): number {
  const x0 = bbox.x, y0 = bbox.y, bw = bbox.width, bh = bbox.height;
  if (bw < 12 || bh < 10) return 0;
  // Dark pixels that sit inside / adjacent to bright white (holes in the logo).
  const dark = new Uint8Array(bw * bh);
  let darkCount = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const p = ((y0 + y) * W + (x0 + x)) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const hole = lum <= 110 && sat <= 80;
      if (!hole) continue;
      // Require a bright neighbor so we score holes-in-white, not dark asphalt.
      let nearBright = false;
      for (let dy = -2; dy <= 2 && !nearBright; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const q = ((y0 + yy) * W + (x0 + xx)) * 4;
          const rr = data[q], gg = data[q + 1], bb = data[q + 2];
          const l2 = 0.299 * rr + 0.587 * gg + 0.114 * bb;
          const s2 = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
          if (l2 >= BRIGHT_THRESHOLD - 10 && s2 <= LOW_SATURATION_THRESHOLD + 20) {
            nearBright = true;
          }
        }
      }
      if (nearBright) { dark[y * bw + x] = 1; darkCount++; }
    }
  }
  if (darkCount < 8) return 0;

  // Connected components of dark holes — expect ~2 eye blobs.
  const vis = new Uint8Array(bw * bh);
  const holes: { cx: number; cy: number; n: number; w: number; h: number }[] = [];
  const stack: number[] = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (!dark[i] || vis[i]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, n = 0, sx = 0, sy = 0;
      stack.length = 0; stack.push(i); vis[i] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        const cy = (idx / bw) | 0, cx = idx - cy * bw;
        n++; sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        if (cx > 0) { const k = idx - 1; if (dark[k] && !vis[k]) { vis[k] = 1; stack.push(k); } }
        if (cx < bw - 1) { const k = idx + 1; if (dark[k] && !vis[k]) { vis[k] = 1; stack.push(k); } }
        if (cy > 0) { const k = idx - bw; if (dark[k] && !vis[k]) { vis[k] = 1; stack.push(k); } }
        if (cy < bh - 1) { const k = idx + bw; if (dark[k] && !vis[k]) { vis[k] = 1; stack.push(k); } }
      }
      const hw = maxX - minX + 1, hh = maxY - minY + 1;
      if (n >= 4 && n <= 400 && hw <= bw * 0.5 && hh <= bh * 0.7) {
        holes.push({ cx: sx / n, cy: sy / n, n, w: hw, h: hh });
      }
    }
  }
  if (holes.length < 2) return holes.length === 1 ? 0.15 : 0;
  holes.sort((a, b) => b.n - a.n);
  const a = holes[0], b = holes[1];
  const sizeRatio = Math.min(a.n, b.n) / Math.max(a.n, b.n);
  const dx = Math.abs(a.cx - b.cx), dy = Math.abs(a.cy - b.cy);
  const horizontallyPaired = dx >= 3 && dx <= bw * 0.55 && dy <= Math.max(6, bh * 0.35);
  if (!horizontallyPaired || sizeRatio < 0.35) return 0.2;
  // Strong match for two similar dark eyes side-by-side inside bright logo.
  return clamp(0.55 + sizeRatio * 0.35 + (dy < bh * 0.2 ? 0.1 : 0), 0, 1);
}

function findBrightTranslucentCluster(
  imageData: ImageData,
  W: number,
  H: number,
  prevBox: WatermarkCoords | null
): CandidateBox | null {
  const data = imageData.data;
  // 1. Build a binary mask of bright low-saturation pixels.
  const raw = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum >= BRIGHT_THRESHOLD && sat <= LOW_SATURATION_THRESHOLD) {
        raw[y * W + x] = 1;
      }
    }
  }

  // Morphological close merges thin glyph strokes into one logo+text strip
  // before connected components (otherwise "Sora" / "@user" shatter into tiny blobs).
  const mask = DETECT_CLOSE_PX > 0
    ? erodeBinary(dilateBinary(raw, W, H, DETECT_CLOSE_PX), W, H, DETECT_CLOSE_PX)
    : raw;

  // 2. Connected components via flood fill.
  const longSide = Math.max(W, H);
  const minSize = Math.max(16, Math.round(MIN_WATERMARK_FRAC * longSide * MIN_WATERMARK_FRAC * longSide));
  const maxArea = Math.round(MAX_WATERMARK_FRAC * longSide * MAX_WATERMARK_HEIGHT_FRAC * longSide);
  const maxW = Math.round(MAX_WATERMARK_FRAC * longSide);
  const maxH = Math.round(MAX_WATERMARK_HEIGHT_FRAC * longSide);
  const visited = new Uint8Array(W * H);
  const candidates: { bbox: WatermarkCoords; pixelCount: number }[] = [];

  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i] || visited[i]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      stack.length = 0;
      stack.push(i);
      visited[i] = 1;
      while (stack.length) {
        const idx = stack.pop()!;
        const cy = (idx / W) | 0;
        const cx = idx - cy * W;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        count++;
        if (cx > 0)        { const n = idx - 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cx < W - 1)    { const n = idx + 1; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy > 0)        { const n = idx - W; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
        if (cy < H - 1)    { const n = idx + W; if (mask[n] && !visited[n]) { visited[n] = 1; stack.push(n); } }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const area = bw * bh;
      // Reject huge sky/face/asphalt blobs and tiny noise.
      if (count < minSize || area > maxArea || bw > maxW || bh > maxH || bw < 4 || bh < 4) continue;
      candidates.push({
        bbox: { x: minX, y: minY, width: bw, height: bh },
        pixelCount: count,
      });
    }
  }

  if (candidates.length === 0) return null;

  // 3. Score: prefer mid-density wide strips of watermark size near edges.
  // Solid bright blobs (sky, specular asphalt, vest glare) score poorly.
  let best: { score: number; bbox: WatermarkCoords; confidence: number } | null = null;
  const idealW = longSide * 0.12;
  const idealH = longSide * 0.055;
  for (const c of candidates) {
    const area = c.bbox.width * c.bbox.height;
    const density = c.pixelCount / area;
    const cx = c.bbox.x + c.bbox.width / 2;
    const cy = c.bbox.y + c.bbox.height / 2;
    const distToEdge = Math.min(cx, W - cx, cy, H - cy);
    const edgeBonus = 1 - clamp(distToEdge / (Math.min(W, H) / 2), 0, 1);

    let motionBonus = 0;
    if (prevBox) {
      const pcx = prevBox.x + prevBox.width / 2;
      const pcy = prevBox.y + prevBox.height / 2;
      const dist = Math.hypot(cx - pcx, cy - pcy);
      // Soft motion prior — do NOT lock onto a wrong prev (vest/face).
      motionBonus = 1 - clamp(dist / (Math.hypot(W, H) * 0.55), 0, 1);
    }

    const aspect = c.bbox.width / Math.max(1, c.bbox.height);
    let aspectBonus = 0.1;
    if (aspect >= ASPECT_PRIOR_MIN && aspect <= ASPECT_PRIOR_MAX) {
      aspectBonus = 1;
    } else if (aspect >= ASPECT_PRIOR_SOFT_MIN && aspect <= ASPECT_PRIOR_SOFT_MAX) {
      aspectBonus = 0.5;
    }

    // Text strips are mid-density; reject near-solid fills (sky/glare).
    let densBonus = 0;
    if (density >= 0.08 && density <= 0.55) densBonus = 1;
    else if (density > 0.55 && density <= 0.72) densBonus = 0.45;
    else if (density < 0.08) densBonus = clamp(density / 0.08, 0, 1) * 0.35;
    else densBonus = 0.15; // very solid

    // Size prior around typical logo+handle footprint.
    const sizeErr =
      Math.abs(c.bbox.width - idealW) / idealW +
      Math.abs(c.bbox.height - idealH) / idealH;
    const sizeBonus = clamp(1 - sizeErr * 0.55, 0, 1);

    const score =
      densBonus * 0.22 +
      aspectBonus * 0.28 +
      edgeBonus * 0.22 +
      sizeBonus * 0.18 +
      motionBonus * 0.10;
    const confidence = Math.round(clamp(
      (densBonus * 0.35 + aspectBonus * 0.35 + sizeBonus * 0.30) * 100,
      0, 100
    ));
    if (!best || score > best.score) {
      best = { score, bbox: c.bbox, confidence };
    }
  }

  if (!best) return null;
  if (best.score < SNAP_MIN_SCORE) return null;
  return { bbox: best.bbox, confidence: best.confidence };
}

function dropOutliers(
  samples: SoraWatermarkSample[],
  W: number,
  H: number
): SoraWatermarkSample[] {
  if (samples.length < 4) return samples;
  const cxs = samples.map(s => s.bbox.x + s.bbox.width / 2);
  const cys = samples.map(s => s.bbox.y + s.bbox.height / 2);
  const median = (arr: number[]): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const mcx = median(cxs);
  const mcy = median(cys);
  const diag = Math.hypot(W, H);
  const avgConf = samples.reduce((a, s) => a + s.confidence, 0) / samples.length;

  // Pass 1: drop far-from-median low-confidence blobs (faces/vests/sky).
  const pass1 = samples.filter((s, i) => {
    const dist = Math.hypot(cxs[i] - mcx, cys[i] - mcy);
    if (dist > diag * 0.55 && s.confidence < avgConf) return false;
    // Reject absurdly large "watermarks".
    const longSide = Math.max(W, H);
    if (s.bbox.width > MAX_WATERMARK_FRAC * longSide * 1.15) return false;
    if (s.bbox.height > MAX_WATERMARK_HEIGHT_FRAC * longSide * 1.25) return false;
    return true;
  });
  if (pass1.length < 3) return pass1.length >= 2 ? pass1 : samples;

  // Pass 2: velocity gate — keep teleports (Sora jumps corners) but drop
  // isolated spikes that don't match neighbors on either side (false locks).
  const kept: SoraWatermarkSample[] = [];
  for (let i = 0; i < pass1.length; i++) {
    const s = pass1[i];
    const cx = s.bbox.x + s.bbox.width / 2;
    const cy = s.bbox.y + s.bbox.height / 2;
    const prev = i > 0 ? pass1[i - 1] : null;
    const next = i + 1 < pass1.length ? pass1[i + 1] : null;
    if (prev && next) {
      const pcx = prev.bbox.x + prev.bbox.width / 2;
      const pcy = prev.bbox.y + prev.bbox.height / 2;
      const ncx = next.bbox.x + next.bbox.width / 2;
      const ncy = next.bbox.y + next.bbox.height / 2;
      const dPrev = Math.hypot(cx - pcx, cy - pcy);
      const dNext = Math.hypot(cx - ncx, cy - ncy);
      const dPN = Math.hypot(ncx - pcx, ncy - pcy);
      // Spike: far from both neighbors while neighbors agree with each other.
      if (dPrev > diag * 0.35 && dNext > diag * 0.35 && dPN < diag * 0.25 && s.confidence < avgConf + 5) {
        continue;
      }
    }
    kept.push(s);
  }
  return kept.length >= 2 ? kept : pass1;
}

/**
 * Interpolate the trajectory to find the watermark bbox at time `t`. Adds the
 * given padding around the box, clamped to the frame.
 */
function bboxAtTime(
  trajectory: SoraWatermarkSample[],
  t: number,
  W: number,
  H: number,
  padding: number
): WatermarkCoords {
  if (trajectory.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (t <= trajectory[0].time) return padBox(trajectory[0].bbox, padding, W, H);
  if (t >= trajectory[trajectory.length - 1].time) return padBox(trajectory[trajectory.length - 1].bbox, padding, W, H);

  // Binary search for surrounding samples.
  let lo = 0, hi = trajectory.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trajectory[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = trajectory[lo];
  const b = trajectory[hi];
  const span = Math.max(1e-6, b.time - a.time);
  const u = clamp((t - a.time) / span, 0, 1);

  // Sora dwells for multi-second stretches on edge/corner slots, then hops.
  // Piecewise-constant trajectory: hold A until the midpoint, then B.
  // Never linearly interpolate across the frame (that paints empty mid-screen).
  const hold = u < 0.5 ? a.bbox : b.bbox;
  return padBox(hold, padding, W, H);
}

function padBox(b: WatermarkCoords, padding: number, W: number, H: number): WatermarkCoords {
  const padX = padding + DEFAULT_PADDING_X_EXTRA;
  const padY = padding + DEFAULT_PADDING_Y_EXTRA;
  const x = clamp(b.x - padX, 0, W - 1);
  const y = clamp(b.y - padY, 0, H - 1);
  const width = clamp(b.width + padX * 2, 1, W - x);
  const height = clamp(b.height + padY * 2, 1, H - y);
  return { x, y, width, height };
}

function boxesOverlap(a: WatermarkCoords, b: WatermarkCoords): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

type RefFrame = { time: number; canvas: HTMLCanvasElement; bbox: WatermarkCoords };

/**
 * Rank clean donor frames for the current ROI. Prefers non-overlapping
 * watermark bboxes (donor is clean), then temporal proximity. Returns up to
 * `MULTI_REF_BLEND` candidates for multi-ref blending.
 */
function pickReferencesForBox(
  references: RefFrame[],
  currentTime: number,
  bbox: WatermarkCoords,
  limit: number = MULTI_REF_BLEND
): RefFrame[] {
  const scored: { ref: RefFrame; score: number }[] = [];
  for (const ref of references) {
    const dt = Math.abs(ref.time - currentTime);
    // Skip near-identical times (same frame / almost same watermark pose).
    if (dt < 0.04) continue;
    const clean = !boxesOverlap(ref.bbox, bbox);
    // Higher is better: clean donors strongly preferred; nearer in time next.
    const score = (clean ? 1000 : 0) - dt;
    scored.push({ ref, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(1, limit)).map(s => s.ref);
  if (picked.length > 0) return picked;
  // Absolute fallback: temporally closest even if overlapping / same time.
  let bestAny: RefFrame | null = null;
  let bestAnyDt = Infinity;
  for (const ref of references) {
    const dt = Math.abs(ref.time - currentTime);
    if (dt < bestAnyDt) { bestAnyDt = dt; bestAny = ref; }
  }
  return bestAny ? [bestAny] : [];
}

/** Mean absolute RGB error on non-mask border ring — lower = better scene match. */
function edgeMatchCost(
  current: ImageData,
  donor: ImageData,
  alpha: Uint8ClampedArray,
  bw: number,
  bh: number
): number {
  let sum = 0;
  let n = 0;
  const ring = 2;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (alpha[i] > 40) continue; // only compare outside / soft edge of mask
      const onBorder =
        x < ring || y < ring || x >= bw - ring || y >= bh - ring ||
        (alpha[i] > 0 && alpha[i] < 180);
      if (!onBorder && alpha[i] === 0) {
        // Sample a sparse interior-clean check too (every 4th pixel).
        if ((x + y) % 4 !== 0) continue;
      } else if (!onBorder) {
        continue;
      }
      const p = i * 4;
      sum += Math.abs(current.data[p] - donor.data[p])
           + Math.abs(current.data[p + 1] - donor.data[p + 1])
           + Math.abs(current.data[p + 2] - donor.data[p + 2]);
      n++;
    }
  }
  return n > 0 ? sum / n : 1e9;
}

/**
 * Scratch canvases for compositing the donor patch. Reused across frames.
 */
const patchScratch: {
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  refCtx: CanvasRenderingContext2D | null;
  refCanvas: HTMLCanvasElement | null;
} = {
  canvas: null,
  ctx: null,
  refCtx: null,
  refCanvas: null,
};

/**
 * Morphological dilate (square kernel) of a binary mask.
 */
function dilateBinary(src: Uint8Array, bw: number, bh: number, radius: number): Uint8Array {
  if (radius <= 0) return src;
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= bw) continue;
          if (src[yy * bw + xx]) { on = 1; break; }
        }
      }
      out[y * bw + x] = on;
    }
  }
  return out;
}

/**
 * Morphological erode (square kernel) of a binary mask.
 */
function erodeBinary(src: Uint8Array, bw: number, bh: number, radius: number): Uint8Array {
  if (radius <= 0) return src;
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let on = 1;
      for (let dy = -radius; dy <= radius && on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) { on = 0; break; }
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= bw || !src[yy * bw + xx]) { on = 0; break; }
        }
      }
      out[y * bw + x] = on;
    }
  }
  return out;
}

/**
 * Soft rounded-rect / ellipse prior covering the logo+text strip inside the
 * (already padded) ROI. Bright detection alone is too sparse for thin glyphs;
 * this prior forces fill across the tracked strip aspect.
 */
function softStripPriorAlpha(bw: number, bh: number, out: Uint8Array): void {
  // Inset slightly so the outer ROI ring can still feather into scene content.
  const insetX = Math.max(2, Math.round(bw * 0.04));
  const insetY = Math.max(2, Math.round(bh * 0.08));
  const cx = (bw - 1) * 0.5;
  const cy = (bh - 1) * 0.5;
  // Superellipse / rounded-rect radius (higher n → squarer).
  const rx = Math.max(1, (bw - 1) * 0.5 - insetX);
  const ry = Math.max(1, (bh - 1) * 0.5 - insetY);
  const n = 3.2;
  const feather = Math.max(4, Math.min(FEATHER_PIXELS + 2, Math.round(Math.min(rx, ry) * 0.35)));
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const nx = Math.abs(x - cx) / rx;
      const ny = Math.abs(y - cy) / ry;
      const d = Math.pow(Math.pow(nx, n) + Math.pow(ny, n), 1 / n);
      let a = 0;
      if (d <= 1) {
        // Distance-to-boundary in pixel-ish units for soft falloff.
        const distIn = (1 - d) * Math.min(rx, ry);
        const s = clamp(distIn / feather, 0, 1);
        const smooth = s * s * (3 - 2 * s);
        a = Math.round(STRIP_PRIOR_PEAK * Math.max(smooth, d < 0.82 ? 1 : smooth));
      }
      out[y * bw + x] = a;
    }
  }
}

/**
 * Build a soft alpha mask of bright translucent watermark pixels inside the ROI.
 * Hard dilate + morphological close covers thin glyphs; union with a soft
 * strip prior (ellipse/rounded-rect) fills the full logo+text track when the
 * bright mask alone is too sparse. Feather softens edges.
 */
function buildBrightMaskInRoi(
  roi: ImageData,
  outAlpha: Uint8ClampedArray,
  hardMaskOut?: Uint8Array
): { hitCount: number; maskCoverage: number } {
  const { width: bw, height: bh, data } = roi;
  const binary = new Uint8Array(bw * bh);
  let hitCount = 0;
  for (let i = 0, p = 0; i < bw * bh; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Softer than detection so thin glyphs and soft AA edges are covered.
    if (lum >= BRIGHT_THRESHOLD - 36 && sat <= LOW_SATURATION_THRESHOLD + 36) {
      binary[i] = 1;
      hitCount++;
    }
  }

  // Dilate hard, then morphological close (dilate+erode) to bridge thin text.
  let mask = dilateBinary(binary, bw, bh, MASK_DILATE_PX);
  if (MASK_CLOSE_PX > 0) {
    mask = dilateBinary(mask, bw, bh, MASK_CLOSE_PX);
    mask = erodeBinary(mask, bw, bh, MASK_CLOSE_PX);
  }

  // Soft strip prior over the padded bbox — fallback / union for sparse glyphs.
  const prior = new Uint8Array(bw * bh);
  softStripPriorAlpha(bw, bh, prior);

  // Union: binary mask OR prior (prior already feathered).
  const unionBin = new Uint8Array(bw * bh);
  let covered = 0;
  for (let i = 0; i < bw * bh; i++) {
    if (mask[i] || prior[i] >= 40) {
      unionBin[i] = 1;
      covered++;
    }
  }

  // Distance-based feather on the union binary, then lift with prior alpha.
  const feather = FEATHER_PIXELS;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      let a = 0;
      if (unionBin[i]) {
        if (feather <= 0) {
          a = 255;
        } else {
          let minDist = feather;
          for (let dy = -feather; dy <= feather; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= bh) continue;
            for (let dx = -feather; dx <= feather; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= bw) continue;
              if (!unionBin[yy * bw + xx]) {
                const d = Math.hypot(dx, dy);
                if (d < minDist) minDist = d;
              }
            }
          }
          const t = clamp(minDist / feather, 0, 1);
          const s = t * t * (3 - 2 * t);
          a = Math.round(s * 255);
        }
      }
      // Ensure prior contribution even if feather of sparse binary missed a pixel.
      if (prior[i] > a) a = prior[i];
      // Hard core of dilated bright mask stays fully on.
      if (mask[i] && a < 220) a = Math.max(a, 220);
      outAlpha[i] = a;
      if (hardMaskOut) hardMaskOut[i] = mask[i];
    }
  }
  return { hitCount, maskCoverage: covered / Math.max(1, bw * bh) };
}

/** Bright translucent fraction inside ROI (same thresholds as residual check). */
function brightFractionInRoi(roi: ImageData): number {
  const data = roi.data;
  let hits = 0;
  const n = roi.width * roi.height;
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum >= BRIGHT_THRESHOLD - 8 && sat <= LOW_SATURATION_THRESHOLD + 10) hits++;
  }
  return n > 0 ? hits / n : 0;
}

/**
 * Telea-like surround sample: average nearby *unmasked* pixels in the current
 * frame, weighted by inverse distance. Returns null if too few donors.
 */
function surroundSampleRgb(
  data: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  x: number,
  y: number,
  bw: number,
  bh: number,
  radius: number,
  hardMask?: Uint8Array
): { r: number; g: number; b: number; w: number } | null {
  let sr = 0, sg = 0, sb = 0, sw = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= bh) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= bw) continue;
      const j = yy * bw + xx;
      // Skip hard bright-core pixels; soft strip-prior pixels may still donate.
      if (hardMask) {
        if (hardMask[j]) continue;
      } else if (alpha[j] > 48) {
        continue;
      }
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const w = 1 / (dist + 0.25);
      const p = j * 4;
      sr += data[p] * w;
      sg += data[p + 1] * w;
      sb += data[p + 2] * w;
      sw += w;
      count++;
    }
  }
  if (count < 3 || sw <= 0) return null;
  return { r: sr / sw, g: sg / sw, b: sb / sw, w: sw };
}

/**
 * Mean RGB sampled from the ROI border ring (outside the hard mask core).
 * Used as a last-resort nuclear fill so text becomes unreadable.
 */
function borderMeanRgb(
  data: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  bw: number,
  bh: number,
  ring: number
): { r: number; g: number; b: number } | null {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const onRing = x < ring || y < ring || x >= bw - ring || y >= bh - ring;
      if (!onRing) continue;
      const i = y * bw + x;
      if (alpha[i] > 80) continue;
      const p = i * 4;
      sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
      n++;
    }
  }
  if (n < 8) {
    // Fallback: any border pixel regardless of alpha.
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const onRing = x < ring || y < ring || x >= bw - ring || y >= bh - ring;
        if (!onRing) continue;
        const p = (y * bw + x) * 4;
        sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
        n++;
      }
    }
  }
  if (n <= 0) return null;
  return { r: sr / n, g: sg / n, b: sb / n };
}

/**
 * Nuclear pass: gaussian-feathered full-ROI paste from best donor, blended with
 * border mean so translucent logo+handle text is unreadable even if imperfect.
 */
function applyNuclearFill(
  out: Uint8ClampedArray,
  donors: { data: Uint8ClampedArray; weight: number }[],
  bw: number,
  bh: number,
  border: { r: number; g: number; b: number } | null
): void {
  // Pick strongest donor.
  let best = donors[0];
  for (const d of donors) {
    if (d.weight > best.weight) best = d;
  }
  const feather = NUCLEAR_EDGE_FEATHER;
  const cx = (bw - 1) * 0.5;
  const cy = (bh - 1) * 0.5;
  const rx = Math.max(1, bw * 0.5);
  const ry = Math.max(1, bh * 0.5);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const edgeDist = Math.min(x, y, bw - 1 - x, bh - 1 - y);
      let t = feather <= 0 ? 1 : clamp(edgeDist / feather, 0, 1);
      t = t * t * (3 - 2 * t);
      // Extra strength toward center of strip.
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const radial = clamp(1 - Math.sqrt(nx * nx + ny * ny), 0, 1);
      // Hard core of the ROI is fully covered (opacity 1); only the outer feather
      // ring blends. White glyphs cannot remain sharp inside the tracked bbox.
      const strength = t >= 1 ? 1 : clamp(t * (0.88 + 0.12 * radial), 0, 1);
      if (strength < 0.02) continue;
      const p = (y * bw + x) * 4;
      let sr = best.data[p];
      let sg = best.data[p + 1];
      let sb = best.data[p + 2];
      // Mix a little multi-ref + border mean so cuts don't leave a hard stamp.
      if (donors.length > 1) {
        let wr = 0, wg = 0, wb = 0, ww = 0;
        for (const d of donors) {
          wr += d.data[p] * d.weight;
          wg += d.data[p + 1] * d.weight;
          wb += d.data[p + 2] * d.weight;
          ww += d.weight;
        }
        if (ww > 0) {
          sr = sr * 0.45 + (wr / ww) * 0.55;
          sg = sg * 0.45 + (wg / ww) * 0.55;
          sb = sb * 0.45 + (wb / ww) * 0.55;
        }
      }
      if (border) {
        sr = sr * 0.72 + border.r * 0.28;
        sg = sg * 0.72 + border.g * 0.28;
        sb = sb * 0.72 + border.b * 0.28;
      }
      out[p]     = Math.round(sr * strength + out[p] * (1 - strength));
      out[p + 1] = Math.round(sg * strength + out[p + 1] * (1 - strength));
      out[p + 2] = Math.round(sb * strength + out[p + 2] * (1 - strength));
    }
  }
}


/**
 * Re-detect the watermark inside a search window around the predicted bbox.
 * Trajectory interpolation (even with teleport hold) drifts; snapping each
 * frame to the local bright logo+text cluster keeps the ROI on the glyphs.
 */
function snapBboxToLocalBright(
  ctx: CanvasRenderingContext2D,
  predicted: WatermarkCoords,
  W: number,
  H: number,
  padding: number
): { bbox: WatermarkCoords; snapped: boolean; score: number } {
  if (predicted.width <= 0 || predicted.height <= 0) {
    return { bbox: predicted, snapped: false, score: 0 };
  }
  const pad = SNAP_SEARCH_PAD;
  const sx = clamp(predicted.x - pad, 0, W - 1);
  const sy = clamp(predicted.y - pad, 0, H - 1);
  const sw = clamp(predicted.width + pad * 2, 1, W - sx);
  const sh = clamp(predicted.height + pad * 2, 1, H - sy);
  let search: ImageData;
  try {
    search = ctx.getImageData(sx, sy, sw, sh);
  } catch {
    return { bbox: predicted, snapped: false, score: 0 };
  }
  // Run cluster find in search-window coordinates (prev = predicted, shifted).
  const prevLocal: WatermarkCoords = {
    x: predicted.x - sx,
    y: predicted.y - sy,
    width: predicted.width,
    height: predicted.height,
  };
  const hit = findBrightTranslucentCluster(search, sw, sh, prevLocal);
  if (!hit || hit.confidence / 100 < SNAP_MIN_SCORE) {
    // Also accept by raw score path: confidence already encodes quality.
    if (!hit || hit.confidence < 34) {
      return { bbox: predicted, snapped: false, score: hit ? hit.confidence / 100 : 0 };
    }
  }
  const raw: WatermarkCoords = {
    x: sx + hit.bbox.x,
    y: sy + hit.bbox.y,
    width: hit.bbox.width,
    height: hit.bbox.height,
  };
  return {
    bbox: padBox(raw, padding, W, H),
    snapped: true,
    score: hit.confidence / 100,
  };
}

function patchRegion(
  ctx: CanvasRenderingContext2D,
  maskCtx: CanvasRenderingContext2D,
  maskCanvas: HTMLCanvasElement,
  references: { time: number; canvas: HTMLCanvasElement; bbox: WatermarkCoords }[],
  currentTime: number,
  bbox: WatermarkCoords,
  W: number,
  H: number,
  quality: SoraRemovalQuality = 'balanced'
): boolean {
  if (bbox.width <= 0 || bbox.height <= 0) return false;
  const blendCount = quality === 'high' ? MULTI_REF_BLEND + 2
    : quality === 'balanced' ? MULTI_REF_BLEND + 1
    : MULTI_REF_BLEND;
  const refs = pickReferencesForBox(references, currentTime, bbox, blendCount);
  if (refs.length === 0) return false;

  const bw = bbox.width;
  const bh = bbox.height;

  // Read current ROI (already drawn from the live frame).
  let roi: ImageData;
  try {
    roi = ctx.getImageData(bbox.x, bbox.y, bw, bh);
  } catch {
    return false;
  }

  // Snapshot original ROI for surround sampling (pre-fill neighbors).
  const original = new Uint8ClampedArray(roi.data);

  const alpha = new Uint8ClampedArray(bw * bh);
  const hardMask = new Uint8Array(bw * bh);
  const { hitCount, maskCoverage } = buildBrightMaskInRoi(roi, alpha, hardMask);
  // Always fill when strip prior covers the tracked ROI (even if bright hits
  // are sparse / zero — translucent text is often under the bright threshold).
  if (hitCount === 0 && maskCoverage < 0.05) return false;

  if (!patchScratch.refCanvas) {
    patchScratch.refCanvas = document.createElement('canvas');
    patchScratch.refCtx = patchScratch.refCanvas.getContext('2d', { willReadFrequently: true });
  }
  const refCanvas = patchScratch.refCanvas!;
  const refCtx = patchScratch.refCtx;
  if (!refCtx) return false;
  if (refCanvas.width !== bw || refCanvas.height !== bh) {
    refCanvas.width = bw;
    refCanvas.height = bh;
  }

  // Pull donor ROIs and score by edge color match (reject cut-mismatched pastes).
  type ScoredDonor = { data: Uint8ClampedArray; weight: number };
  const donors: ScoredDonor[] = [];
  for (const ref of refs) {
    refCtx.clearRect(0, 0, bw, bh);
    refCtx.drawImage(ref.canvas, bbox.x, bbox.y, bw, bh, 0, 0, bw, bh);
    let donor: ImageData;
    try {
      donor = refCtx.getImageData(0, 0, bw, bh);
    } catch {
      continue;
    }
    const cost = edgeMatchCost(roi, donor, alpha, bw, bh);
    const weight = 1 / (1 + cost / 18);
    if (weight < 0.08 && donors.length > 0) continue;
    donors.push({ data: new Uint8ClampedArray(donor.data), weight });
  }
  if (donors.length === 0) return false;

  let wSum = 0;
  for (const d of donors) wSum += d.weight;
  if (wSum <= 0) return false;
  for (const d of donors) d.weight /= wSum;

  const surroundR = quality === 'fast' ? Math.max(4, SURROUND_RADIUS - 2) : SURROUND_RADIUS;
  const out = roi.data;

  // Pass 1: surround-sample (current frame) preferentially + multi-ref blend.
  for (let i = 0, p = 0; i < bw * bh; i++, p += 4) {
    const a = alpha[i];
    if (a === 0) continue;
    const x = i % bw;
    const y = (i / bw) | 0;

    let sr = 0, sg = 0, sb = 0;
    for (const d of donors) {
      sr += d.data[p] * d.weight;
      sg += d.data[p + 1] * d.weight;
      sb += d.data[p + 2] * d.weight;
    }

    const surround = surroundSampleRgb(original, alpha, x, y, bw, bh, surroundR, hardMask);
    if (surround) {
      // Prefer local surround when available — matches lighting/grain better.
      const sw = clamp(surround.w / (surround.w + 4), 0.35, 0.85);
      sr = surround.r * sw + sr * (1 - sw);
      sg = surround.g * sw + sg * (1 - sw);
      sb = surround.b * sw + sb * (1 - sw);
    }

    if (a === 255) {
      out[p] = Math.round(sr);
      out[p + 1] = Math.round(sg);
      out[p + 2] = Math.round(sb);
      continue;
    }
    const t = a / 255;
    out[p]     = Math.round(sr * t + out[p] * (1 - t));
    out[p + 1] = Math.round(sg * t + out[p + 1] * (1 - t));
    out[p + 2] = Math.round(sb * t + out[p + 2] * (1 - t));
  }

  // Pass 2 (nuclear): if bright residual in ROI still high, force feathered
  // full-bbox fill so logo+handle text is unreadable.
  const residualFrac = brightFractionInRoi(roi);
  const nuclearThresh = quality === 'high'
    ? NUCLEAR_BRIGHT_FRAC * 0.7
    : quality === 'fast'
      ? NUCLEAR_BRIGHT_FRAC * 1.35
      : NUCLEAR_BRIGHT_FRAC;
  // Nuclear when residual bright fraction stays high after surround+donor fill,
  // or always (moderated) on balanced/high — sparse bright masks leave readable text.
  const forceNuclear =
    residualFrac >= nuclearThresh ||
    (hitCount >= 8 && residualFrac >= nuclearThresh * 0.45) ||
    quality !== 'fast';
  if (forceNuclear) {
    const border = borderMeanRgb(original, alpha, bw, bh, Math.max(2, Math.round(Math.min(bw, bh) * 0.08)));
    applyNuclearFill(out, donors, bw, bh, border);
  }

  ctx.putImageData(roi, bbox.x, bbox.y);

  if (maskCanvas.width !== bw || maskCanvas.height !== bh) {
    maskCanvas.width = bw;
    maskCanvas.height = bh;
  }
  void maskCtx;
  void W; void H;
  return forceNuclear;
}
