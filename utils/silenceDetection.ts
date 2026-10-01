/**
 * Silence detection for one-click dead-air removal.
 *
 * Probes the file's duration from metadata first (cheap), then decodes the
 * audio track at a low sample rate (8 kHz — plenty for energy detection,
 * ~2MB per minute of audio) inside an OfflineAudioContext and windows the
 * PCM into 100ms RMS energy buckets. All channels are mixed down before the
 * RMS computation so a voice panned hard to one side still counts as sound.
 *
 * Consecutive sub-threshold buckets become silence regions. The silence
 * threshold is derived from the track's own noise floor (10th percentile of
 * window RMS + margin), so it adapts to rooms with louder HVAC/fans instead
 * of relying on a fixed -45dB absolute value.
 *
 * Each cut is padded ~100ms into the silence on both sides so word edges
 * survive, and short speech bursts ("no", "ok", laughs) between silences are
 * always kept — only actual silence runs are merged into regions.
 *
 * Runs entirely on-device; the file is never uploaded.
 */

export interface SilenceRegion {
  /** Start of the silent stretch, in seconds. */
  start: number;
  /** End of the silent stretch, in seconds. */
  end: number;
}

export interface SilenceDetectionResult {
  regions: SilenceRegion[];
  /** Total audio duration analyzed, in seconds. */
  duration: number;
}

export interface SilenceDetectionOptions {
  /**
   * Absolute threshold (dBFS) overriding the adaptive noise-floor threshold.
   * Default: derived per-file (10th percentile window RMS + 8dB margin).
   */
  thresholdDb?: number;
  /** Silence runs shorter than this are ignored. Default 0.5s. */
  minSilenceSeconds?: number;
  /**
   * Head/tail padding kept around speech: each cut starts this far into the
   * silence and ends this far before it, so word edges aren't clipped.
   * Default 0.1s.
   */
  silencePaddingSeconds?: number;
  /** Cooperative cancellation (e.g. the user swapped files mid-detect). */
  signal?: AbortSignal;
}

const DETECTION_SAMPLE_RATE = 8000; // Hz — resampled during decode, keeps memory tiny
const WINDOW_SECONDS = 0.1;
// Decoded audio is 8kHz float32: ~1.9MB per minute. Cap the *decoded* size,
// not the encoded file: decodeAudioData materializes the whole track, so a
// 3-hour low-bitrate file can explode to gigabytes even when the file itself
// is small.
const MAX_DETECTION_MINUTES = 60;
const MAX_DECODED_BYTES = MAX_DETECTION_MINUTES * 60 * DETECTION_SAMPLE_RATE * 4;
// Adaptive threshold tuning: this percentile of window RMS approximates the
// room's noise floor; buckets this far above it count as sound.
const NOISE_FLOOR_PERCENTILE = 0.1;
const THRESHOLD_MARGIN_DB = 8;
const THRESHOLD_MIN_DB = -60;
const THRESHOLD_MAX_DB = -25;
const PROBE_TIMEOUT_MS = 10000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Silence detection cancelled.', 'AbortError');
  }
}

/**
 * Read the media duration from metadata only — no audio decoding, so this is
 * cheap even for huge files. Used to cap the decoded size before we commit
 * to materializing the whole track as float32.
 */
function probeMediaDuration(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let done = false;
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    const finish = (duration: number | null) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      if (duration == null || !isFinite(duration) || duration <= 0) {
        reject(new Error('Could not read the audio duration for silence detection.'));
      } else {
        resolve(duration);
      }
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort);
    el.onloadedmetadata = () => finish(el.duration);
    el.onerror = () => finish(null);
    window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    el.src = url;
  });
}

export async function detectSilences(
  file: File,
  opts?: SilenceDetectionOptions
): Promise<SilenceDetectionResult> {
  const minSilence = opts?.minSilenceSeconds ?? 0.5;
  const padding = Math.max(0, opts?.silencePaddingSeconds ?? 0.1);
  const signal = opts?.signal;

  // Gate on decoded size, not encoded file size (see constant comment).
  const duration = await probeMediaDuration(file, signal);
  throwIfAborted(signal);
  const estimatedBytes = duration * DETECTION_SAMPLE_RATE * 4;
  if (estimatedBytes > MAX_DECODED_BYTES) {
    throw new Error(
      `Silence detection is limited to ${MAX_DETECTION_MINUTES} minutes of audio; this file is about ${Math.round(duration / 60)} minutes.`
    );
  }

  let audioBuffer: AudioBuffer;
  try {
    const raw = await file.arrayBuffer();
    throwIfAborted(signal);
    const Ctor: typeof OfflineAudioContext | undefined =
      window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Ctor) {
      throw new Error('OfflineAudioContext is not supported in this browser.');
    }
    // The decode resamples to the context's rate; the context length is
    // irrelevant to decodeAudioData (it allocates its own buffer).
    const decodeCtx = new Ctor(1, DETECTION_SAMPLE_RATE, DETECTION_SAMPLE_RATE);
    audioBuffer = await decodeCtx.decodeAudioData(raw);
  } catch (e) {
    throwIfAborted(signal);
    if (e instanceof Error && /not supported|limited to/.test(e.message)) throw e;
    throw new Error('Could not decode the audio track for silence detection.');
  }
  throwIfAborted(signal);

  // Mix down ALL channels before RMS. decodeAudioData keeps the source's
  // channel count, so getChannelData(0) alone would be left-channel-only and
  // a voice panned right would read as silence.
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SECONDS));
  // ceil, not floor: the old code dropped the trailing partial window, which
  // could hide trailing silence on short clips.
  const windowCount = Math.max(1, Math.ceil(frames / windowSize));
  if (frames === 0) {
    return { regions: [], duration: audioBuffer.duration };
  }

  // First pass: per-window RMS over the channel mixdown.
  const rms = new Float64Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSize;
    const len = Math.min(windowSize, frames - start);
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      for (let i = 0; i < len; i++) {
        const v = data[start + i];
        sum += v * v;
      }
    }
    rms[w] = Math.sqrt(sum / (len * channels.length));
    // Cooperative cancellation point: windowing a long file takes a while.
    if ((w & 1023) === 0) throwIfAborted(signal);
  }
  throwIfAborted(signal);

  // Adaptive threshold from the noise floor. A fixed absolute threshold
  // fails in rooms with louder ambient noise; the 10th percentile of window
  // energy approximates that floor, and anything comfortably above it is
  // treated as sound.
  const sorted = Float64Array.from(rms).sort();
  const floorRms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * NOISE_FLOOR_PERCENTILE))];
  const floorDb = 20 * Math.log10(Math.max(floorRms, 1e-7));
  const derivedDb = Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, floorDb + THRESHOLD_MARGIN_DB));
  const thresholdDb = opts?.thresholdDb ?? derivedDb;
  const thresholdLinear = Math.pow(10, thresholdDb / 20);

  const silent = new Uint8Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    silent[w] = rms[w] < thresholdLinear ? 1 : 0;
  }

  // Buckets -> regions. A non-silent gap ALWAYS breaks the run: the old code
  // absorbed sub-0.25s "blips" into the surrounding silence, which swallowed
  // short speech bursts ("no", "ok", laughs). Keeping a click or breath costs
  // a fraction of a second; cutting a word is far worse.
  const regions: SilenceRegion[] = [];
  let runStart: number | null = null;
  const flush = (endWindow: number) => {
    if (runStart === null) return;
    const rawStart = (runStart * windowSize) / sampleRate;
    const rawEnd = Math.min((endWindow * windowSize) / sampleRate, audioBuffer.duration);
    runStart = null;
    if (rawEnd - rawStart < minSilence) return;
    // Pad the cut into the silence on both sides so word edges survive.
    const start = Math.max(0, Math.min(rawStart + padding, rawEnd));
    const end = Math.max(rawEnd - padding, start);
    if (end > start) regions.push({ start, end });
  };

  for (let w = 0; w <= windowCount; w++) {
    const isLast = w === windowCount; // sentinel: force-flush the trailing run
    const isSilent = !isLast && silent[w] === 1;
    if (isSilent) {
      if (runStart === null) runStart = w;
    } else if (runStart !== null) {
      flush(w);
    }
  }

  return { regions, duration: audioBuffer.duration };
}

/** Format seconds as m:ss.s for the region list. */
export function formatSilenceTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
