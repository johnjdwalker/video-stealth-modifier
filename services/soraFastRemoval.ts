import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  OutputFormat,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import { SoraDwell, SoraFillMode, SoraRemovalQuality, WatermarkCoords } from '../types';
import { Reference, applyFill, clamp, createScratch } from './soraFill';
import { boxAtTime } from './soraWatermarkService';

/**
 * Watermark removal through WebCodecs.
 *
 * The MediaRecorder path records a canvas while the clip plays, so a 60 second
 * video costs at least 60 seconds and any frame the CPU misses is simply gone
 * from the output. Here frames are pulled from the demuxer, filled and handed
 * to an encoder as fast as the machine manages: the work is bounded by compute
 * rather than by playback, and no frame can be dropped because nothing is
 * racing a clock. Audio is remuxed packet for packet, never re-encoded, so it
 * comes through bit-exact.
 */

// Reference frames held in memory for temporal fill, per quality level.
const REFERENCE_FRAME_COUNTS: Record<SoraRemovalQuality, number> = {
  fast: 4,
  balanced: 10,
  high: 18,
};

// Share of the progress bar given to collecting reference frames.
const REFERENCE_PROGRESS_SHARE = 25;

// Live preview cadence, in seconds of media time.
const LIVE_FRAME_INTERVAL = 1.5;

export interface FastRemovalOptions {
  quality?: SoraRemovalQuality;
  fillMode?: SoraFillMode;
  signal?: AbortSignal;
  onLiveFrame?: (dataUrl: string) => void;
}

/**
 * Whether this browser can run the WebCodecs path at all. The per-file checks
 * (is the container readable, is the track decodable) happen once the input is
 * open, since they depend on the clip rather than the browser.
 */
export async function canUseWebCodecs(): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return false;
  try {
    return await canEncodeVideo('avc');
  } catch {
    return false;
  }
}

/**
 * Picks a container that can carry the source's audio codec untouched, so the
 * audio can be remuxed rather than re-encoded. MP4 is preferred because it is
 * the more useful file to hand to other tools; Opus and Vorbis force WebM.
 */
function pickOutputFormat(audioCodec: string | null): OutputFormat {
  const mp4 = new Mp4OutputFormat({ fastStart: 'in-memory' });
  if (!audioCodec) return mp4;
  const supported = mp4.getSupportedAudioCodecs() as string[];
  return supported.includes(audioCodec) ? mp4 : new WebMOutputFormat();
}

function makeCanvas(W: number, H: number) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('Could not allocate a 2D canvas for processing.');
  return { canvas, ctx };
}

/** Downscales the working canvas to a compact JPEG for the live preview. */
function frameToPreviewDataUrl(canvas: HTMLCanvasElement): string {
  const maxW = 960;
  const scale = Math.min(1, maxW / canvas.width);
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) return '';
  octx.drawImage(canvas, 0, 0, w, h);
  return out.toDataURL('image/jpeg', 0.82);
}

/**
 * Grabs donor frames by decoding at spread-out timestamps. Each records where
 * the watermark was at that moment so overlapping donors can be rejected later.
 */
async function extractReferences(
  sink: VideoSampleSink,
  dwells: SoraDwell[],
  padding: number,
  W: number,
  H: number,
  duration: number,
  count: number,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void
): Promise<Reference[]> {
  if (duration <= 0) return [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(clamp(duration * ((i + 0.5) / count), 0, Math.max(0, duration - 0.001)));
  }

  const references: Reference[] = [];
  let done = 0;
  for (const t of times) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const sample = await sink.getSample(t);
    done++;
    onProgress?.(done / count);
    if (!sample) continue;
    const { canvas, ctx } = makeCanvas(W, H);
    sample.draw(ctx, 0, 0, W, H);
    sample.close();
    references.push({ time: t, canvas, ctx, box: boxAtTime(dwells, t, padding, W, H) });
  }
  return references;
}

export async function removeViaWebCodecs(
  videoFile: File,
  dwells: SoraDwell[],
  padding: number,
  onProgress?: (progress: number, stage?: string) => void,
  options: FastRemovalOptions = {}
): Promise<{ blob: Blob; mimeType: string }> {
  const { quality = 'balanced', fillMode = 'auto', signal, onLiveFrame } = options;
  if (dwells.length === 0) throw new Error('No watermark region to remove.');

  const input = new Input({ source: new BlobSource(videoFile), formats: ALL_FORMATS });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('This file has no video track.');
  if (!(await videoTrack.canDecode())) {
    throw new Error('This browser cannot decode this video track.');
  }

  const W = videoTrack.displayWidth;
  const H = videoTrack.displayHeight;
  if (!W || !H) throw new Error('Could not read the video dimensions.');
  const duration = await input.computeDuration();

  const audioTrack = await input.getPrimaryAudioTrack();
  const format = pickOutputFormat(audioTrack?.codec ?? null);
  const output = new Output({ format, target: new BufferTarget() });

  const { canvas, ctx } = makeCanvas(W, H);
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    quality: QUALITY_HIGH,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource);

  // Audio is copied packet for packet. Only a track whose codec the chosen
  // container accepts can be remuxed; anything else would need re-encoding,
  // which this path deliberately does not do (the caller falls back instead).
  const audioCodec = audioTrack?.codec ?? null;
  const canCopyAudio =
    !!audioTrack && !!audioCodec &&
    (format.getSupportedAudioCodecs() as string[]).includes(audioCodec);
  const audioSource = canCopyAudio ? new EncodedAudioPacketSource(audioCodec as never) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  let cancelled = false;
  const abortIfRequested = async () => {
    if (!signal?.aborted || cancelled) return;
    cancelled = true;
    try { await output.cancel(); } catch { /* already torn down */ }
    throw new DOMException('Aborted', 'AbortError');
  };

  try {
    await abortIfRequested();

    const refSink = new VideoSampleSink(videoTrack);
    onProgress?.(0, 'Collecting clean reference frames');
    const references = fillMode === 'inpaint'
      ? []
      : await extractReferences(
          refSink, dwells, padding, W, H, duration,
          REFERENCE_FRAME_COUNTS[quality], signal,
          (f) => onProgress?.(f * REFERENCE_PROGRESS_SHARE, 'Collecting clean reference frames')
        );

    await output.start();
    await abortIfRequested();

    const base = fillMode === 'inpaint' ? 0 : REFERENCE_PROGRESS_SHARE;
    onProgress?.(base, 'Reconstructing frames');

    // Audio first: copying packets is cheap and gets the track out of the way
    // before the long video pass. The muxer buffers until both tracks close.
    if (audioTrack && audioSource) {
      const decoderConfig = await audioTrack.getDecoderConfig();
      const packetSink = new EncodedPacketSink(audioTrack);
      let first = true;
      for await (const packet of packetSink.packets()) {
        await abortIfRequested();
        await audioSource.add(packet, first && decoderConfig ? { decoderConfig } : undefined);
        first = false;
      }
      audioSource.close();
    }

    const scratch = createScratch();
    const sink = new VideoSampleSink(videoTrack);
    let lastLiveFrameAt = -Infinity;
    let frames = 0;

    for await (const sample of sink.samples()) {
      await abortIfRequested();
      const t = sample.timestamp;
      sample.draw(ctx, 0, 0, W, H);

      const box: WatermarkCoords | null = boxAtTime(dwells, t, padding, W, H);
      if (box) applyFill(ctx, scratch, references, t, box, W, H, fillMode);

      if (onLiveFrame && t - lastLiveFrameAt >= LIVE_FRAME_INTERVAL) {
        lastLiveFrameAt = t;
        onLiveFrame(frameToPreviewDataUrl(canvas));
      }

      await videoSource.add(t, sample.duration);
      sample.close();
      frames++;

      if (duration > 0) {
        const pct = base + (t / duration) * (100 - base);
        onProgress?.(Math.min(99.5, pct), 'Reconstructing frames');
      }
    }
    videoSource.close();

    if (frames === 0) throw new Error('No frames could be decoded from this video.');

    await abortIfRequested();
    onProgress?.(100, 'Finalising');
    await output.finalize();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('Encoding produced no output.');
    return { blob: new Blob([buffer], { type: format.mimeType }), mimeType: format.mimeType };
  } catch (err) {
    if (!cancelled) {
      try { await output.cancel(); } catch { /* already torn down */ }
    }
    throw err;
  } finally {
    await input.dispose();
  }
}
