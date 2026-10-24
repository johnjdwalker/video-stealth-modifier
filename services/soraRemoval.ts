import { SoraDwell, SoraFillMode, SoraRemovalQuality } from '../types';
import { removeSoraWatermark as removeViaMediaRecorder } from './soraWatermarkService';

export interface SoraRemovalOptions {
  quality?: SoraRemovalQuality;
  fillMode?: SoraFillMode;
  signal?: AbortSignal;
  /** Called with a JPEG data URL roughly once per 1.5s of media time. */
  onLiveFrame?: (dataUrl: string) => void;
}

/**
 * Removes the watermark, choosing the best pipeline this browser and file allow.
 *
 * WebCodecs is preferred: it is bounded by how fast the machine computes rather
 * than by playback speed, and it cannot drop frames because nothing is racing a
 * clock. It is not universal though — Safari's support lags, and an individual
 * file may use a codec this browser will not decode — so anything other than a
 * user cancellation falls through to the real-time recorder, which can handle
 * whatever the <video> element itself can play.
 */
export async function removeSoraWatermark(
  videoFile: File,
  dwells: SoraDwell[],
  padding: number,
  onProgress?: (progress: number, stage?: string) => void,
  options: SoraRemovalOptions = {}
): Promise<{ blob: Blob; mimeType: string }> {
  // The WebCodecs path pulls in a demuxer/muxer that roughly doubles the
  // bundle, so it is imported on demand: a visitor who never runs a removal
  // never downloads it. Gate the import on the APIs existing at all, so
  // browsers without WebCodecs skip the download entirely.
  if (typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined') {
    try {
      const fast = await import('./soraFastRemoval');
      if (await fast.canUseWebCodecs()) {
        return await fast.removeViaWebCodecs(videoFile, dwells, padding, onProgress, options);
      }
    } catch (err) {
      const aborted = options.signal?.aborted || (err as Error)?.name === 'AbortError';
      if (aborted) throw err;
      console.warn('WebCodecs removal failed; falling back to real-time capture:', err);
      onProgress?.(0, 'Retrying with real-time capture');
    }
  }
  return removeViaMediaRecorder(videoFile, dwells, padding, onProgress, options);
}
