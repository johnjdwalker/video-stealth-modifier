/**
 * Silence detection for one-click dead-air removal.
 *
 * Decodes the file's audio track at a low sample rate (8 kHz mono — plenty
 * for energy detection, ~2MB per minute of audio) inside an
 * OfflineAudioContext, then windows the PCM into 100ms RMS energy buckets.
 * Consecutive sub-threshold buckets become silence regions; brief
 * non-silent blips (mouth clicks, breaths) are merged so words don't get
 * chopped.
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
  /** Buckets quieter than this (dBFS) count as silent. Default -45. */
  thresholdDb?: number;
  /** Silence runs shorter than this are ignored. Default 0.5s. */
  minSilenceSeconds?: number;
  /** Non-silent gaps shorter than this are merged into the silence run. Default 0.25s. */
  minSpeechSeconds?: number;
}

const DETECTION_SAMPLE_RATE = 8000; // Hz — resampled during decode, keeps memory tiny
const WINDOW_SECONDS = 0.1;
const MAX_DETECTION_BYTES = 400 * 1024 * 1024; // decoding needs the whole file in memory

export async function detectSilences(
  file: File,
  opts?: SilenceDetectionOptions
): Promise<SilenceDetectionResult> {
  const thresholdDb = opts?.thresholdDb ?? -45;
  const minSilence = opts?.minSilenceSeconds ?? 0.5;
  const minSpeech = opts?.minSpeechSeconds ?? 0.25;

  if (file.size > MAX_DETECTION_BYTES) {
    throw new Error('Silence detection is limited to files under 400MB.');
  }

  let audioBuffer: AudioBuffer;
  try {
    const raw = await file.arrayBuffer();
    const Ctor: typeof OfflineAudioContext | undefined =
      window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Ctor) {
      throw new Error('OfflineAudioContext is not supported in this browser.');
    }
    // Decode straight into a low-rate context: the resample happens during
    // decode, so the decoded buffer stays small regardless of source length.
    const decodeCtx = new Ctor(1, DETECTION_SAMPLE_RATE, DETECTION_SAMPLE_RATE);
    audioBuffer = await decodeCtx.decodeAudioData(raw);
  } catch (e) {
    if (e instanceof Error && /400MB|not supported/.test(e.message)) throw e;
    throw new Error('Could not decode the audio track for silence detection.');
  }

  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SECONDS));
  const windowCount = Math.floor(data.length / windowSize);
  if (windowCount === 0) {
    return { regions: [], duration: audioBuffer.duration };
  }

  const thresholdLinear = Math.pow(10, thresholdDb / 20);
  const silent = new Array<boolean>(windowCount);
  for (let w = 0; w < windowCount; w++) {
    let sum = 0;
    const off = w * windowSize;
    for (let i = 0; i < windowSize; i++) {
      const v = data[off + i];
      sum += v * v;
    }
    silent[w] = Math.sqrt(sum / windowSize) < thresholdLinear;
  }

  // Buckets -> regions. A non-silent gap shorter than minSpeech is treated
  // as a blip (click/breath) and absorbed into the surrounding silence run.
  const regions: SilenceRegion[] = [];
  let runStart: number | null = null;
  let lastSilent = -1;
  const flush = (endWindow: number) => {
    if (runStart === null) return;
    const start = (runStart * windowSize) / sampleRate;
    const end = Math.min((endWindow * windowSize) / sampleRate, audioBuffer.duration);
    if (end - start >= minSilence) regions.push({ start, end });
    runStart = null;
  };

  for (let w = 0; w <= windowCount; w++) {
    const isLast = w === windowCount; // sentinel: force-flush the trailing run
    const isSilent = !isLast && silent[w];
    if (isSilent) {
      if (runStart === null) runStart = w;
      lastSilent = w;
    } else if (runStart !== null) {
      const gapSeconds = ((w - lastSilent - 1) * windowSize) / sampleRate;
      if (!isLast && gapSeconds < minSpeech) continue; // blip — keep the run open
      flush(lastSilent + 1);
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
