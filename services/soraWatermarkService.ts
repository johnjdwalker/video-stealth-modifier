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

const DETECTION_TARGET_SAMPLES = 36;        // how many frames to sample for detection
const DETECTION_MAX_SAMPLE_INTERVAL = 1.0;  // seconds; clamps very long videos
const DETECTION_MIN_SAMPLE_INTERVAL = 0.15; // seconds; clamps very short videos

// Luminance threshold (0-255). Pixels brighter than this are watermark candidates.
const BRIGHT_THRESHOLD = 200;
// Saturation threshold (0-255 max-min). Below this is "white-ish".
const LOW_SATURATION_THRESHOLD = 60;
// Working resolution for detection (downscaled). Smaller = faster, less accurate.
const DETECTION_WORK_WIDTH = 320;

// Watermark size constraints, expressed as fractions of the video's longer side.
// Sora's logo is small relative to the frame.
const MIN_WATERMARK_FRAC = 0.02;
const MAX_WATERMARK_FRAC = 0.30;

// Reference frame counts per quality level. More references = better fill, more memory.
const REFERENCE_FRAME_COUNTS: Record<SoraRemovalQuality, number> = {
  fast: 4,
  balanced: 8,
  high: 14,
};

// Feathering width (in pixels at full resolution) around the patched region.
const FEATHER_PIXELS = 6;

// Padding (in pixels at full resolution) added around each detected bbox to
// catch soft edges, antialiasing and slight motion between sampled frames.
const DEFAULT_PADDING = 10;

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
): Promise<{ blob: Blob; mimeType: string }> {
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

    onProgress?.(100, 'Finalizing');
    const blob = new Blob(chunks, { type: mime });
    return { blob, mimeType: mime };
  } finally {
    await cleanup();
    references = [];
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

  // 3. Score candidates: density (filled fraction), proximity to previous box,
  // and preference for boxes near edges (Sora logo bounces along edges).
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

    // Score weights: density is paramount (logos are dense), edge bias and
    // motion continuity refine the choice between similar candidates.
    const score = density * 0.55 + edgeBonus * 0.20 + motionBonus * 0.25;
    const confidence = Math.round(clamp(density * 100, 0, 100));
    if (!best || score > best.score) {
      best = { score, bbox: c.bbox, confidence };
    }
  }

  if (!best) return null;
  // Reject low-density blobs (likely a bright object, not a logo).
  if (best.score < 0.35) return null;
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
  const x = clamp(b.x - padding, 0, W - 1);
  const y = clamp(b.y - padding, 0, H - 1);
  const width = clamp(b.width + padding * 2, 1, W - x);
  const height = clamp(b.height + padding * 2, 1, H - y);
  return { x, y, width, height };
}

function boxesOverlap(a: WatermarkCoords, b: WatermarkCoords): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function pickReferenceForBox(
  references: { time: number; canvas: HTMLCanvasElement; bbox: WatermarkCoords }[],
  currentTime: number,
  bbox: WatermarkCoords
): { time: number; canvas: HTMLCanvasElement; bbox: WatermarkCoords } | null {
  // Prefer references whose own watermark bbox does NOT overlap the current
  // bbox (so the donor pixels are clean). Among those, prefer the temporally
  // closest one. Fall back to the temporally closest reference even if
  // overlapping (rare with reasonable refCount).
  let bestClean: typeof references[number] | null = null;
  let bestCleanDt = Infinity;
  let bestAny: typeof references[number] | null = null;
  let bestAnyDt = Infinity;
  for (const ref of references) {
    const dt = Math.abs(ref.time - currentTime);
    if (dt < bestAnyDt) { bestAnyDt = dt; bestAny = ref; }
    if (!boxesOverlap(ref.bbox, bbox) && dt < bestCleanDt) {
      bestCleanDt = dt;
      bestClean = ref;
    }
  }
  return bestClean ?? bestAny;
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
  const ref = pickReferenceForBox(references, currentTime, bbox);
  if (!ref) return;

  const feather = Math.min(FEATHER_PIXELS, Math.floor(Math.min(bbox.width, bbox.height) / 2));

  // Build the feather mask (white center fading to transparent edges).
  maskCanvas.width = bbox.width;
  maskCanvas.height = bbox.height;
  maskCtx.clearRect(0, 0, bbox.width, bbox.height);

  // Solid white core with soft edges. We achieve this by stroking a series of
  // increasingly transparent rectangles.
  if (feather <= 0) {
    maskCtx.fillStyle = 'white';
    maskCtx.fillRect(0, 0, bbox.width, bbox.height);
  } else {
    const grad = maskCtx.createRadialGradient(
      bbox.width / 2, bbox.height / 2, 0,
      bbox.width / 2, bbox.height / 2, Math.max(bbox.width, bbox.height) / 2
    );
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    const innerStop = Math.max(0, 1 - feather / Math.max(bbox.width, bbox.height));
    grad.addColorStop(innerStop, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    maskCtx.fillStyle = grad;
    maskCtx.fillRect(0, 0, bbox.width, bbox.height);
  }

  // Compose the donor patch into a small canvas so we can mask it cheaply.
  const patchCanvas = document.createElement('canvas');
  patchCanvas.width = bbox.width;
  patchCanvas.height = bbox.height;
  const patchCtx = patchCanvas.getContext('2d');
  if (!patchCtx) return;
  patchCtx.drawImage(
    ref.canvas,
    bbox.x, bbox.y, bbox.width, bbox.height,
    0, 0, bbox.width, bbox.height
  );
  // Apply the feather mask to the patch using destination-in.
  patchCtx.globalCompositeOperation = 'destination-in';
  patchCtx.drawImage(maskCanvas, 0, 0);
  patchCtx.globalCompositeOperation = 'source-over';

  // Draw masked patch over the recording canvas.
  ctx.drawImage(patchCanvas, bbox.x, bbox.y);

  // Avoid unused-var warning on H (kept for future per-frame validation).
  void W; void H;
}
