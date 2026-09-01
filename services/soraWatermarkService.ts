import {
  SoraCorrection,
  SoraDwell,
  SoraFillMode,
  SoraRemovalQuality,
  SoraWatermarkDetection,
  WatermarkCoords,
} from '../types';
import {
  WORK_LONG_SIDE,
  buildDwells,
  bridgeDwells,
  findCandidates,
} from './soraDetection';
import { inpaintCanvasRegion } from './inpaint';

// ----------------------------------------------------------------------------
// Tunables
// ----------------------------------------------------------------------------

// Target number of frames sampled during detection, and the bounds on cadence.
const DETECTION_TARGET_SAMPLES = 48;
const DETECTION_MIN_INTERVAL = 0.12; // seconds
const DETECTION_MAX_INTERVAL = 0.60; // seconds

// Reference frames held in memory for temporal fill, per quality level.
const REFERENCE_FRAME_COUNTS: Record<SoraRemovalQuality, number> = {
  fast: 4,
  balanced: 10,
  high: 18,
};

// Feathering width (source pixels) around the patched region.
const FEATHER_PIXELS = 6;

// Padding around each detected box, to cover soft edges and antialiasing.
const DEFAULT_PADDING = 10;

// Output encoding. "Size doesn't matter" — bias hard towards quality.
const BITRATE_BITS_PER_PIXEL_PER_FRAME = 0.25;
const MIN_VIDEO_BITRATE = 8_000_000;
const MAX_VIDEO_BITRATE = 60_000_000;
const AUDIO_BITRATE = 256_000;
const FALLBACK_CAPTURE_FPS = 30;

// Preferred containers/codecs, best quality and most useful format first.
const MIME_PREFERENCES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // H.264 High profile
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2', // H.264 Main profile
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // H.264 Baseline
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

// ----------------------------------------------------------------------------
// Detection
// ----------------------------------------------------------------------------

interface SoraDetectionOptions {
  signal?: AbortSignal;
}

export async function detectSoraWatermark(
  videoFile: File,
  onProgress?: (progress: number, stage?: string) => void,
  options: SoraDetectionOptions = {}
): Promise<SoraWatermarkDetection> {
  const { signal } = options;
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const empty = (message: string, w = 0, h = 0, d = 0): SoraWatermarkDetection => ({
    detected: false,
    videoWidth: w, videoHeight: h, videoDuration: d,
    dwells: [],
    padding: DEFAULT_PADDING,
    logoSize: null,
    averageConfidence: 0,
    coverage: 0,
    samplesAnalyzed: 0,
    message,
  });

  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const videoDuration = isFinite(video.duration) ? video.duration : 0;

    if (!videoWidth || !videoHeight || videoDuration <= 0) {
      return empty('Could not read the video dimensions or duration.', videoWidth, videoHeight, videoDuration);
    }

    const interval = clamp(
      videoDuration / DETECTION_TARGET_SAMPLES,
      DETECTION_MIN_INTERVAL,
      DETECTION_MAX_INTERVAL
    );
    const sampleTimes: number[] = [];
    for (let t = interval / 2; t < videoDuration; t += interval) {
      sampleTimes.push(Math.min(videoDuration - 0.001, t));
    }
    if (sampleTimes.length === 0) sampleTimes.push(0);

    // Analyse at a normalised working resolution so thresholds behave the same
    // for portrait and landscape sources.
    const scale = Math.min(1, WORK_LONG_SIDE / Math.max(videoWidth, videoHeight));
    const workW = Math.max(64, Math.round(videoWidth * scale));
    const workH = Math.max(64, Math.round(videoHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return empty('Canvas 2D context unavailable.', videoWidth, videoHeight, videoDuration);

    const perFrame: { time: number; index: number; candidates: ReturnType<typeof findCandidates> }[] = [];

    for (let i = 0; i < sampleTimes.length; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const t = sampleTimes[i];
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, workW, workH);
      const imageData = ctx.getImageData(0, 0, workW, workH);
      perFrame.push({ time: t, index: i, candidates: findCandidates(imageData, workW, workH) });
      onProgress?.(((i + 1) / sampleTimes.length) * 100, 'Analysing frames');
    }

    const { dwells: workDwells, logoSize: workLogoSize } = buildDwells(perFrame, workW, workH);

    if (workDwells.length === 0) {
      return {
        ...empty(
          'No Sora-style watermark found. Play the video and click on the watermark to place it manually.',
          videoWidth, videoHeight, videoDuration
        ),
        samplesAnalyzed: sampleTimes.length,
      };
    }

    // Scale everything from working resolution back to source pixels.
    const up = (b: WatermarkCoords): WatermarkCoords => clampBox({
      x: Math.round(b.x / scale),
      y: Math.round(b.y / scale),
      width: Math.round(b.width / scale),
      height: Math.round(b.height / scale),
    }, videoWidth, videoHeight);

    const scaled: SoraDwell[] = workDwells.map((d) => ({
      ...d,
      bbox: up(d.bbox),
      samples: d.samples.map((s) => ({ ...s, bbox: up(s.bbox) })),
    }));

    const dwells = bridgeDwells(scaled, videoDuration);
    const covered = dwells.reduce((acc, d) => acc + (d.endTime - d.startTime), 0);
    const averageConfidence = Math.round(
      dwells.reduce((acc, d) => acc + d.confidence, 0) / dwells.length
    );

    return {
      detected: true,
      videoWidth, videoHeight, videoDuration,
      dwells,
      padding: DEFAULT_PADDING,
      logoSize: workLogoSize
        ? { width: Math.round(workLogoSize.width / scale), height: Math.round(workLogoSize.height / scale) }
        : null,
      averageConfidence,
      coverage: videoDuration > 0 ? Math.min(1, covered / videoDuration) : 0,
      samplesAnalyzed: sampleTimes.length,
      message: `Found ${dwells.length} watermark position${dwells.length === 1 ? '' : 's'} across ${sampleTimes.length} sampled frames.`,
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ----------------------------------------------------------------------------
// Timeline: detection + manual corrections -> the boxes actually used
// ----------------------------------------------------------------------------

/**
 * Merges manual corrections into the detected dwells.
 *
 * A correction overrides the dwell containing its timestamp — the user pointed
 * at the watermark, so their box wins for that whole stretch. A correction that
 * lands in a gap creates a manual dwell reaching to its neighbours.
 */
export function resolveTimeline(
  detection: SoraWatermarkDetection | null,
  corrections: SoraCorrection[],
  duration: number
): SoraDwell[] {
  const base = detection?.dwells ?? [];
  const sortedCorrections = [...corrections].sort((a, b) => a.time - b.time);

  if (sortedCorrections.length === 0) return base;

  const result: SoraDwell[] = base.map((d) => ({ ...d }));
  const orphans: SoraCorrection[] = [];

  for (const correction of sortedCorrections) {
    const hit = result.find((d) => correction.time >= d.startTime && correction.time <= d.endTime);
    if (hit) {
      hit.bbox = correction.bbox;
      hit.source = 'manual';
      hit.confidence = 100;
      hit.samples = [{ time: correction.time, bbox: correction.bbox, confidence: 100 }];
    } else {
      orphans.push(correction);
    }
  }

  for (const correction of orphans) {
    result.push({
      startTime: correction.time,
      endTime: correction.time,
      bbox: correction.bbox,
      samples: [{ time: correction.time, bbox: correction.bbox, confidence: 100 }],
      confidence: 100,
      source: 'manual',
    });
  }

  result.sort((a, b) => a.startTime - b.startTime);

  // Re-bridge so manual dwells inserted into gaps get a real span.
  return bridgeDwells(result, duration);
}

/**
 * The box covering the watermark at time `t`.
 *
 * Boxes are held per dwell rather than interpolated across dwells: the
 * watermark jumps between positions, and interpolating that jump would drag
 * the patched region across the middle of the frame.
 */
export function boxAtTime(
  dwells: SoraDwell[],
  t: number,
  padding: number,
  W: number,
  H: number
): WatermarkCoords | null {
  if (dwells.length === 0) return null;

  let active: SoraDwell | null = null;
  for (const dwell of dwells) {
    if (t >= dwell.startTime && t <= dwell.endTime) { active = dwell; break; }
  }
  if (!active) {
    // Outside every dwell: hold the nearest one rather than leaving a gap.
    let best = dwells[0];
    let bestDist = Infinity;
    for (const dwell of dwells) {
      const dist = t < dwell.startTime ? dwell.startTime - t : t - dwell.endTime;
      if (dist < bestDist) { bestDist = dist; best = dwell; }
    }
    active = best;
  }

  // Within a dwell the mark can drift a little; follow the samples.
  const samples = active.samples;
  let bbox = active.bbox;
  if (samples.length > 1) {
    if (t <= samples[0].time) bbox = samples[0].bbox;
    else if (t >= samples[samples.length - 1].time) bbox = samples[samples.length - 1].bbox;
    else {
      let lo = 0, hi = samples.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].time <= t) lo = mid; else hi = mid;
      }
      const a = samples[lo], b = samples[hi];
      const span = Math.max(1e-6, b.time - a.time);
      const u = clamp((t - a.time) / span, 0, 1);
      bbox = {
        x: Math.round(a.bbox.x + (b.bbox.x - a.bbox.x) * u),
        y: Math.round(a.bbox.y + (b.bbox.y - a.bbox.y) * u),
        width: Math.round(a.bbox.width + (b.bbox.width - a.bbox.width) * u),
        height: Math.round(a.bbox.height + (b.bbox.height - a.bbox.height) * u),
      };
    }
  }

  return padBox(bbox, padding, W, H);
}

/**
 * Snaps a click to the watermark under the cursor in the frame currently shown
 * by `video`. Falls back to a box of `fallbackSize` centred on the click, so a
 * click always produces something usable.
 */
export function snapBoxToClick(
  video: HTMLVideoElement,
  clickX: number,
  clickY: number,
  fallbackSize: { width: number; height: number } | null
): WatermarkCoords {
  const W = video.videoWidth;
  const H = video.videoHeight;
  const fallbackW = Math.max(24, fallbackSize?.width ?? Math.round(W * 0.20));
  const fallbackH = Math.max(12, fallbackSize?.height ?? Math.round(W * 0.055));
  const fallback = clampBox({
    x: Math.round(clickX - fallbackW / 2),
    y: Math.round(clickY - fallbackH / 2),
    width: fallbackW,
    height: fallbackH,
  }, W, H);

  if (!W || !H) return fallback;

  try {
    const scale = Math.min(1, WORK_LONG_SIDE / Math.max(W, H));
    const workW = Math.max(64, Math.round(W * scale));
    const workH = Math.max(64, Math.round(H * scale));
    const canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(video, 0, 0, workW, workH);
    const candidates = findCandidates(ctx.getImageData(0, 0, workW, workH), workW, workH);
    if (candidates.length === 0) return fallback;

    const cx = clickX * scale;
    const cy = clickY * scale;
    // Prefer a candidate containing the click; otherwise the nearest centre,
    // but only if the click is plausibly close to it.
    let best = candidates[0];
    let bestDist = Infinity;
    for (const cand of candidates) {
      const b = cand.bbox;
      const inside = cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
      const dist = inside
        ? 0
        : Math.hypot(cx - (b.x + b.width / 2), cy - (b.y + b.height / 2));
      if (dist < bestDist) { bestDist = dist; best = cand; }
    }
    if (bestDist > Math.max(workW, workH) * 0.12) return fallback;

    return clampBox({
      x: Math.round(best.bbox.x / scale),
      y: Math.round(best.bbox.y / scale),
      width: Math.round(best.bbox.width / scale),
      height: Math.round(best.bbox.height / scale),
    }, W, H);
  } catch {
    return fallback;
  }
}

// ----------------------------------------------------------------------------
// Fill preview
// ----------------------------------------------------------------------------

export interface FillPreview {
  beforeUrl: string;
  afterUrl: string;
  box: WatermarkCoords;
}

/**
 * Renders one frame with the fill applied, cropped around the watermark, so the
 * fill method can be judged before committing to a full re-encode.
 */
export async function renderFillPreview(
  videoFile: File,
  time: number,
  dwells: SoraDwell[],
  padding: number,
  fillMode: SoraFillMode,
  options: { signal?: AbortSignal } = {}
): Promise<FillPreview | null> {
  const { signal } = options;
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const W = video.videoWidth;
    const H = video.videoHeight;
    const box = boxAtTime(dwells, time, padding, W, H);
    if (!box) return null;

    // A handful of donor frames is enough to judge the look.
    const references = fillMode === 'inpaint'
      ? []
      : await extractReferences(video, dwells, padding, W, H, REFERENCE_FRAME_COUNTS.fast, signal);

    await seekTo(video, time);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, W, H);

    // Crop with generous margin so the blend into surrounding content is visible.
    const margin = Math.round(Math.max(box.width, box.height) * 0.6);
    const cropX = clamp(box.x - margin, 0, W - 1);
    const cropY = clamp(box.y - margin, 0, H - 1);
    const cropW = clamp(box.width + margin * 2, 1, W - cropX);
    const cropH = clamp(box.height + margin * 2, 1, H - cropY);

    const beforeUrl = cropToDataUrl(canvas, cropX, cropY, cropW, cropH);

    const scratch = createScratch();
    applyFill(ctx, scratch, references, time, box, W, H, fillMode);
    const afterUrl = cropToDataUrl(canvas, cropX, cropY, cropW, cropH);

    return { beforeUrl, afterUrl, box };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function cropToDataUrl(
  source: HTMLCanvasElement, x: number, y: number, w: number, h: number
): string {
  const out = document.createElement('canvas');
  // Upscale small crops so the fill quality is actually visible.
  const zoom = clamp(420 / Math.max(w, h), 1, 4);
  out.width = Math.round(w * zoom);
  out.height = Math.round(h * zoom);
  const octx = out.getContext('2d');
  if (!octx) return '';
  octx.imageSmoothingEnabled = true;
  octx.drawImage(source, x, y, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// ----------------------------------------------------------------------------
// Removal
// ----------------------------------------------------------------------------

interface SoraRemovalOptions {
  quality?: SoraRemovalQuality;
  fillMode?: SoraFillMode;
  signal?: AbortSignal;
}

export async function removeSoraWatermark(
  videoFile: File,
  dwells: SoraDwell[],
  padding: number,
  onProgress?: (progress: number, stage?: string) => void,
  options: SoraRemovalOptions = {}
): Promise<{ blob: Blob; mimeType: string }> {
  const { quality = 'balanced', fillMode = 'auto', signal } = options;
  if (dwells.length === 0) throw new Error('No watermark region to remove.');

  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  let mediaRecorder: MediaRecorder | null = null;
  let audioContext: AudioContext | null = null;
  let rafId = 0;
  let frameCallbackId = 0;
  let references: Reference[] = [];

  const cleanup = async () => {
    if (rafId) cancelAnimationFrame(rafId);
    if (frameCallbackId && typeof (video as any).cancelVideoFrameCallback === 'function') {
      (video as any).cancelVideoFrameCallback(frameCallbackId);
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close(); } catch { /* ignore */ }
    }
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    references = [];
  };

  try {
    await waitForMetadata(video);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const W = video.videoWidth;
    const H = video.videoHeight;
    const duration = isFinite(video.duration) ? video.duration : 0;

    if (fillMode !== 'inpaint') {
      onProgress?.(0, 'Collecting clean reference frames');
      references = await extractReferences(
        video, dwells, padding, W, H, REFERENCE_FRAME_COUNTS[quality], signal,
        (p) => onProgress?.(p * 25, 'Collecting clean reference frames')
      );
    }

    await seekTo(video, 0);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error('Could not allocate the recording canvas.');

    // Audio passthrough.
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    let audioTrack: MediaStreamTrack | undefined;
    try {
      const sourceNode = audioContext.createMediaElementSource(video);
      const dest = audioContext.createMediaStreamDestination();
      sourceNode.connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0];
    } catch {
      // No audio is fine — continue with a video-only output.
    }

    // When requestVideoFrameCallback is available, drive the canvas from
    // decoded frames and push each one explicitly. That reproduces the source
    // frame rate exactly instead of resampling everything to a fixed 30fps.
    const hasFrameCallback = typeof (video as any).requestVideoFrameCallback === 'function';
    const stream = canvas.captureStream(hasFrameCallback ? 0 : FALLBACK_CAPTURE_FPS);
    const videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const tracks: MediaStreamTrack[] = [videoTrack];
    if (audioTrack) tracks.push(audioTrack);

    const mime = pickFirstSupported(MIME_PREFERENCES);
    if (!mime) throw new Error('This browser cannot record video from a canvas in any supported format.');

    const bitrate = Math.round(clamp(
      W * H * FALLBACK_CAPTURE_FPS * BITRATE_BITS_PER_PIXEL_PER_FRAME,
      MIN_VIDEO_BITRATE,
      MAX_VIDEO_BITRATE
    ));

    mediaRecorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType: mime,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: AUDIO_BITRATE,
    });
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const recordingDone = new Promise<void>((resolve, reject) => {
      mediaRecorder!.onstop = () => resolve();
      mediaRecorder!.onerror = (ev: Event) => {
        const err = (ev as any).error || new Error('MediaRecorder error');
        reject(err instanceof Error ? err : new Error(String(err)));
      };
    });

    const scratch = createScratch();

    const renderAt = (t: number) => {
      ctx.drawImage(video, 0, 0, W, H);
      const box = boxAtTime(dwells, t, padding, W, H);
      if (box) applyFill(ctx, scratch, references, t, box, W, H, fillMode);
      if (duration > 0) {
        const base = fillMode === 'inpaint' ? 0 : 25;
        const pct = base + (t / duration) * (100 - base);
        onProgress?.(Math.min(99.5, pct), 'Reconstructing frames');
      }
    };

    const stop = () => { try { mediaRecorder?.stop(); } catch { /* ignore */ } };

    if (hasFrameCallback) {
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        if (signal?.aborted) { video.pause(); stop(); return; }
        if (video.ended) { stop(); return; }
        renderAt(meta.mediaTime);
        videoTrack.requestFrame?.();
        if (!video.paused && !video.ended) {
          frameCallbackId = (video as any).requestVideoFrameCallback(onFrame);
        }
      };
      video.onplay = () => {
        audioContext?.resume().catch(() => undefined);
        frameCallbackId = (video as any).requestVideoFrameCallback(onFrame);
      };
    } else {
      const drawFrame = () => {
        if (signal?.aborted) { video.pause(); stop(); return; }
        if (video.paused || video.ended) { stop(); return; }
        renderAt(video.currentTime);
        rafId = requestAnimationFrame(drawFrame);
      };
      video.onplay = () => {
        audioContext?.resume().catch(() => undefined);
        rafId = requestAnimationFrame(drawFrame);
      };
    }

    video.onended = () => stop();

    onProgress?.(fillMode === 'inpaint' ? 0 : 25, 'Reconstructing frames');
    mediaRecorder.start();
    await video.play();
    await recordingDone;

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress?.(100, 'Finalising');
    return { blob: new Blob(chunks, { type: mime }), mimeType: mime };
  } finally {
    await cleanup();
  }
}

// ----------------------------------------------------------------------------
// Fill
// ----------------------------------------------------------------------------

interface Reference {
  time: number;
  canvas: HTMLCanvasElement;
  box: WatermarkCoords | null;
}

interface Scratch {
  mask: HTMLCanvasElement;
  maskCtx: CanvasRenderingContext2D | null;
  patch: HTMLCanvasElement;
  patchCtx: CanvasRenderingContext2D | null;
}

function createScratch(): Scratch {
  const mask = document.createElement('canvas');
  const patch = document.createElement('canvas');
  return {
    mask,
    maskCtx: mask.getContext('2d'),
    patch,
    patchCtx: patch.getContext('2d'),
  };
}

/**
 * Grabs donor frames. Reference times are spread across the clip; each one
 * records where the watermark was at that moment so overlapping donors can be
 * rejected at fill time.
 */
async function extractReferences(
  video: HTMLVideoElement,
  dwells: SoraDwell[],
  padding: number,
  W: number,
  H: number,
  count: number,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void
): Promise<Reference[]> {
  const duration = isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) return [];

  const references: Reference[] = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const t = clamp(duration * ((i + 0.5) / count), 0, Math.max(0, duration - 0.001));
    await seekTo(video, t);
    const refCanvas = document.createElement('canvas');
    refCanvas.width = W;
    refCanvas.height = H;
    const refCtx = refCanvas.getContext('2d', { alpha: false });
    if (!refCtx) continue;
    refCtx.drawImage(video, 0, 0, W, H);
    references.push({ time: t, canvas: refCanvas, box: boxAtTime(dwells, t, padding, W, H) });
    onProgress?.((i + 1) / count);
  }
  return references;
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

function applyFill(
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
    inpaintCanvasRegion(ctx, box.x, box.y, box.width, box.height, W, H);
    return;
  }

  const ref = pickCleanReference(references, currentTime, box);
  if (!ref) {
    // `temporal` promised real pixels and there are none clean enough; falling
    // back beats stamping the watermark back over itself from a bad donor.
    inpaintCanvasRegion(ctx, box.x, box.y, box.width, box.height, W, H);
    return;
  }

  const { maskCtx, patchCtx, mask, patch } = scratch;
  if (!maskCtx || !patchCtx) return;

  const feather = Math.min(FEATHER_PIXELS, Math.floor(Math.min(box.width, box.height) / 2));

  if (mask.width !== box.width || mask.height !== box.height) {
    mask.width = box.width;
    mask.height = box.height;
  } else {
    maskCtx.clearRect(0, 0, box.width, box.height);
  }
  if (feather <= 0) {
    maskCtx.fillStyle = 'white';
    maskCtx.fillRect(0, 0, box.width, box.height);
  } else {
    const grad = maskCtx.createRadialGradient(
      box.width / 2, box.height / 2, 0,
      box.width / 2, box.height / 2, Math.max(box.width, box.height) / 2
    );
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(Math.max(0, 1 - feather / Math.max(box.width, box.height)), 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    maskCtx.fillStyle = grad;
    maskCtx.fillRect(0, 0, box.width, box.height);
  }

  if (patch.width !== box.width || patch.height !== box.height) {
    patch.width = box.width;
    patch.height = box.height;
  } else {
    patchCtx.clearRect(0, 0, box.width, box.height);
  }
  patchCtx.globalCompositeOperation = 'source-over';
  patchCtx.drawImage(ref.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  patchCtx.globalCompositeOperation = 'destination-in';
  patchCtx.drawImage(mask, 0, 0);
  patchCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(patch, box.x, box.y);
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clampBox(b: WatermarkCoords, W: number, H: number): WatermarkCoords {
  const x = clamp(Math.round(b.x), 0, Math.max(0, W - 1));
  const y = clamp(Math.round(b.y), 0, Math.max(0, H - 1));
  return {
    x,
    y,
    width: clamp(Math.round(b.width), 1, Math.max(1, W - x)),
    height: clamp(Math.round(b.height), 1, Math.max(1, H - y)),
  };
}

function padBox(b: WatermarkCoords, padding: number, W: number, H: number): WatermarkCoords {
  const x = clamp(b.x - padding, 0, Math.max(0, W - 1));
  const y = clamp(b.y - padding, 0, Math.max(0, H - 1));
  return {
    x,
    y,
    width: clamp(b.width + padding * 2, 1, Math.max(1, W - x)),
    height: clamp(b.height + padding * 2, 1, Math.max(1, H - y)),
  };
}

export function pickFirstSupported(candidates: string[]): string | null {
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

/** Human-readable label for the container/codec actually used. */
export function describeMimeType(mime: string | null): string {
  if (!mime) return 'unknown';
  if (mime.includes('mp4')) return 'MP4 (H.264)';
  if (mime.includes('vp9')) return 'WEBM (VP9)';
  if (mime.includes('vp8')) return 'WEBM (VP8)';
  if (mime.includes('webm')) return 'WEBM';
  return mime;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.videoWidth > 0) { resolve(); return; }
    const done = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => { done(); resolve(); };
    const onError = () => { done(); reject(new Error(video.error?.message || 'Failed to load video.')); };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = isFinite(video.duration) ? video.duration : time;
    const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)));
    if (Math.abs(video.currentTime - target) < 1 / 240 && video.readyState >= 2) { resolve(); return; }
    const done = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => { done(); resolve(); };
    const onError = () => { done(); reject(new Error('Seek failed.')); };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try { video.currentTime = target; } catch (e) { done(); reject(e as Error); }
  });
}
