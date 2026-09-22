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

const DETECTION_TARGET_SAMPLES = 72;        // denser trajectory sampling along the clip
const DETECTION_MAX_SAMPLE_INTERVAL = 0.45; // seconds; clamps very long videos
const DETECTION_MIN_SAMPLE_INTERVAL = 0.08; // seconds; clamps very short videos

// Luminance threshold (0-255). Pixels brighter than this are watermark candidates.
const BRIGHT_THRESHOLD = 200;
// Saturation threshold (0-255 max-min). Below this is "white-ish".
const LOW_SATURATION_THRESHOLD = 60;
// Working resolution for detection (downscaled). Higher = more accurate logos/text.
const DETECTION_WORK_WIDTH = 640;

// Watermark size constraints, expressed as fractions of the video's longer side.
// Sora's logo is small relative to the frame.
const MIN_WATERMARK_FRAC = 0.02;
const MAX_WATERMARK_FRAC = 0.30;

// Sora logo+text strip aspect prior (width/height). Typical strip is wide.
const ASPECT_PRIOR_MIN = 1.4;
const ASPECT_PRIOR_MAX = 7.0;
const ASPECT_PRIOR_SOFT_MIN = 1.0;
const ASPECT_PRIOR_SOFT_MAX = 9.0;

// Reference frame counts per quality level. More references = better fill, more memory.
const REFERENCE_FRAME_COUNTS: Record<SoraRemovalQuality, number> = {
  fast: 8,
  balanced: 14,
  high: 22,
};

// Feathering radius (in pixels at full resolution) around the per-frame mask.
const FEATHER_PIXELS = 8;
// Dilate the bright-pixel mask so thin glyphs / soft AA edges are covered.
const MASK_DILATE_PX = 5;
// Extra morphological close radius after dilate (connects broken thin text strokes).
const MASK_CLOSE_PX = 2;

// Padding (in pixels at full resolution) added around each detected bbox to
// catch soft edges, antialiasing, thin text, and slight motion between samples.
const DEFAULT_PADDING = 20;
// Extra horizontal padding — Sora text strip is wider than the logo alone.
const DEFAULT_PADDING_X_EXTRA = 8;

// How many clean donor frames to blend for each patch (edge-aware multi-ref).
const MULTI_REF_BLEND = 3;

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
      const candidate = findBrightTranslucentCluster(imageData, workW, workH, prevBoxWork);
      if (candidate) {
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
      const bbox = bboxAtTime(detection.trajectory, t, W, H, detection.padding);

      patchRegion(ctx, maskCtx, maskCanvas, references, t, bbox, W, H);

      if (duration > 0) {
        const pct = 25 + (t / duration) * 75;
        onProgress?.(Math.min(99.9, pct), 'Reconstructing frames');
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
function findBrightTranslucentCluster(
  imageData: ImageData,
  W: number,
  H: number,
  prevBox: WatermarkCoords | null
): CandidateBox | null {
  const data = imageData.data;
  // 1. Build a binary mask of bright low-saturation pixels.
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum >= BRIGHT_THRESHOLD && sat <= LOW_SATURATION_THRESHOLD) {
        mask[y * W + x] = 1;
      }
    }
  }

  // 2. Connected components via flood fill.
  const longSide = Math.max(W, H);
  const minSize = Math.max(20, Math.round(MIN_WATERMARK_FRAC * longSide * MIN_WATERMARK_FRAC * longSide));
  const maxSize = Math.round(MAX_WATERMARK_FRAC * W * MAX_WATERMARK_FRAC * H);
  const visited = new Uint8Array(W * H);
  const candidates: { bbox: WatermarkCoords; pixelCount: number }[] = [];

  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i] || visited[i]) continue;
      // BFS / iterative flood
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
      if (count >= minSize && area <= maxSize && bw >= 4 && bh >= 4) {
        candidates.push({
          bbox: { x: minX, y: minY, width: bw, height: bh },
          pixelCount: count,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // 3. Score candidates: density, logo+text strip aspect prior, proximity to
  // previous box, and preference for boxes near edges (Sora logo bounces).
  let best: { score: number; bbox: WatermarkCoords; confidence: number } | null = null;
  for (const c of candidates) {
    const area = c.bbox.width * c.bbox.height;
    const density = c.pixelCount / area; // 0-1, higher = denser
    const cx = c.bbox.x + c.bbox.width / 2;
    const cy = c.bbox.y + c.bbox.height / 2;
    const distToEdge = Math.min(cx, W - cx, cy, H - cy);
    const edgeBonus = 1 - clamp(distToEdge / (Math.min(W, H) / 2), 0, 1);

    let motionBonus = 0;
    if (prevBox) {
      const pcx = prevBox.x + prevBox.width / 2;
      const pcy = prevBox.y + prevBox.height / 2;
      const dist = Math.hypot(cx - pcx, cy - pcy);
      motionBonus = 1 - clamp(dist / Math.hypot(W, H), 0, 1);
    }

    // Aspect prior: Sora watermark is a wide logo+text strip, not a square blob.
    const aspect = c.bbox.width / Math.max(1, c.bbox.height);
    let aspectBonus = 0.15;
    if (aspect >= ASPECT_PRIOR_MIN && aspect <= ASPECT_PRIOR_MAX) {
      aspectBonus = 1;
    } else if (aspect >= ASPECT_PRIOR_SOFT_MIN && aspect <= ASPECT_PRIOR_SOFT_MAX) {
      aspectBonus = 0.55;
    }

    // Score weights: density + aspect prior are key; edge/motion refine.
    const score = density * 0.40 + aspectBonus * 0.25 + edgeBonus * 0.15 + motionBonus * 0.20;
    const confidence = Math.round(clamp((density * 0.7 + aspectBonus * 0.3) * 100, 0, 100));
    if (!best || score > best.score) {
      best = { score, bbox: c.bbox, confidence };
    }
  }

  if (!best) return null;
  // Reject low-density / wrong-aspect blobs (likely a bright object, not a logo).
  if (best.score < 0.32) return null;
  return { bbox: best.bbox, confidence: best.confidence };
}

function dropOutliers(
  samples: SoraWatermarkSample[],
  W: number,
  H: number
): SoraWatermarkSample[] {
  if (samples.length < 4) return samples;
  // Compute median center and median size; drop samples whose center is far
  // from the median AND whose confidence is below average.
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

  return samples.filter((s, i) => {
    const dist = Math.hypot(cxs[i] - mcx, cys[i] - mcy);
    if (dist > diag * 0.55 && s.confidence < avgConf) return false;
    return true;
  });
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
  const lerp = (av: number, bv: number) => av + (bv - av) * u;
  const bbox: WatermarkCoords = {
    x: Math.round(lerp(a.bbox.x, b.bbox.x)),
    y: Math.round(lerp(a.bbox.y, b.bbox.y)),
    width: Math.round(lerp(a.bbox.width, b.bbox.width)),
    height: Math.round(lerp(a.bbox.height, b.bbox.height)),
  };
  return padBox(bbox, padding, W, H);
}

function padBox(b: WatermarkCoords, padding: number, W: number, H: number): WatermarkCoords {
  const padX = padding + DEFAULT_PADDING_X_EXTRA;
  const padY = padding;
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
 * Build a soft alpha mask of bright translucent watermark pixels inside the ROI.
 * Dilate + morphological close covers thin glyphs; feather softens edges.
 * Only these pixels are replaced — avoids ghosting from naive full-bbox paste on cuts.
 */
function buildBrightMaskInRoi(
  roi: ImageData,
  outAlpha: Uint8ClampedArray
): number {
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
    if (lum >= BRIGHT_THRESHOLD - 28 && sat <= LOW_SATURATION_THRESHOLD + 28) {
      binary[i] = 1;
      hitCount++;
    }
  }

  // Dilate aggressively, then morphological close (dilate+erode) to bridge thin text.
  let mask = dilateBinary(binary, bw, bh, MASK_DILATE_PX);
  if (MASK_CLOSE_PX > 0) {
    mask = dilateBinary(mask, bw, bh, MASK_CLOSE_PX);
    mask = erodeBinary(mask, bw, bh, MASK_CLOSE_PX);
  }

  // Distance-based feather: alpha falls off within FEATHER_PIXELS of mask edge.
  // Smoothstep for a softer blend into surrounding content.
  const feather = FEATHER_PIXELS;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      if (!mask[i]) {
        outAlpha[i] = 0;
        continue;
      }
      if (feather <= 0) {
        outAlpha[i] = 255;
        continue;
      }
      let minDist = feather;
      for (let dy = -feather; dy <= feather; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -feather; dx <= feather; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= bw) continue;
          if (!mask[yy * bw + xx]) {
            const d = Math.hypot(dx, dy);
            if (d < minDist) minDist = d;
          }
        }
      }
      const t = clamp(minDist / feather, 0, 1);
      // smoothstep
      const s = t * t * (3 - 2 * t);
      outAlpha[i] = Math.round(s * 255);
    }
  }
  return hitCount;
}

function patchRegion(
  ctx: CanvasRenderingContext2D,
  maskCtx: CanvasRenderingContext2D,
  maskCanvas: HTMLCanvasElement,
  references: { time: number; canvas: HTMLCanvasElement; bbox: WatermarkCoords }[],
  currentTime: number,
  bbox: WatermarkCoords,
  W: number,
  H: number
): void {
  if (bbox.width <= 0 || bbox.height <= 0) return;
  const refs = pickReferencesForBox(references, currentTime, bbox, MULTI_REF_BLEND);
  if (refs.length === 0) return;

  const bw = bbox.width;
  const bh = bbox.height;

  // Read current ROI (already drawn from the live frame).
  let roi: ImageData;
  try {
    roi = ctx.getImageData(bbox.x, bbox.y, bw, bh);
  } catch {
    return;
  }

  const alpha = new Uint8ClampedArray(bw * bh);
  const hitCount = buildBrightMaskInRoi(roi, alpha);
  // Nothing bright/translucent here — skip (avoids pasting on empty ROIs).
  if (hitCount === 0) return;

  if (!patchScratch.refCanvas) {
    patchScratch.refCanvas = document.createElement('canvas');
    patchScratch.refCtx = patchScratch.refCanvas.getContext('2d', { willReadFrequently: true });
  }
  const refCanvas = patchScratch.refCanvas!;
  const refCtx = patchScratch.refCtx;
  if (!refCtx) return;
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
    // Convert cost → weight; very mismatched donors get near-zero weight.
    const weight = 1 / (1 + cost / 18);
    if (weight < 0.08 && donors.length > 0) continue; // skip bad cut match if we have alternatives
    donors.push({ data: new Uint8ClampedArray(donor.data), weight });
  }
  if (donors.length === 0) return;

  // Normalize weights.
  let wSum = 0;
  for (const d of donors) wSum += d.weight;
  if (wSum <= 0) return;
  for (const d of donors) d.weight /= wSum;

  // Multi-ref blend ONLY where the per-frame mask is on; feather soft edges.
  const out = roi.data;
  for (let i = 0, p = 0; i < bw * bh; i++, p += 4) {
    const a = alpha[i];
    if (a === 0) continue;
    let sr = 0, sg = 0, sb = 0;
    for (const d of donors) {
      sr += d.data[p] * d.weight;
      sg += d.data[p + 1] * d.weight;
      sb += d.data[p + 2] * d.weight;
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
  ctx.putImageData(roi, bbox.x, bbox.y);

  // Keep mask canvas sized for any legacy callers / debugging overlays.
  if (maskCanvas.width !== bw || maskCanvas.height !== bh) {
    maskCanvas.width = bw;
    maskCanvas.height = bh;
  }
  void maskCtx;
  void W; void H;
}
