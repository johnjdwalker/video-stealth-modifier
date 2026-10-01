import { useState, useCallback, useRef, useEffect } from 'react';
import { VideoSettings } from '../types';
import { OUTPUT_FORMAT_MIME_TYPES } from '../constants';
import { SilenceRegion } from '../utils/silenceDetection';

// Constants for rotating lines effect configuration
const FPS = 30; // Should match canvas.captureStream frame rate
const ROTATION_DURATION_SECONDS = 30; // Duration for one full 360-degree rotation
const SEEK_TIMEOUT_MS = 10000; // Give up waiting for 'seeked' after 10s
const NOISE_TILE_SIZE = 128; // Pre-rendered noise tile dimension (px)
const MIN_DRAW_INTERVAL_SECONDS = 1 / 45; // Don't redraw faster than the capturer can use
const PROGRESS_UPDATE_MIN_INTERVAL_MS = 250; // Cap setProgress() at ~4Hz

/** Optional per-run export behavior. */
export interface ProcessVideoOptions {
  /**
   * Silent stretches to cut from the export. Each range is sanitized into the
   * trim window at run start; during export the recorder pauses, the video
   * seeks past the range, and recording resumes — dead air is removed.
   */
  skipRanges?: SilenceRegion[];
}

/**
 * Everything one processVideo run holds: element, canvas, audio graph,
 * recorder, stream, timers. Kept per-run (not in shared refs) so a new run
 * started without cancelling the old one can't orphan run A's AudioContext,
 * tracks, recorder, or visibility listener — cleanup() always disposes the
 * currently-registered run, and every async callback closes over its own
 * run's bundle.
 */
interface RunResources {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  audioContext: AudioContext | null;
  mediaRecorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  objectUrl: string | null;
  rafId: number;
  visibilityHandler: (() => void) | null;
}

function makeRunResources(video: HTMLVideoElement, canvas: HTMLCanvasElement): RunResources {
  return {
    video,
    canvas,
    audioContext: null,
    mediaRecorder: null,
    stream: null,
    chunks: [],
    objectUrl: null,
    rafId: 0,
    visibilityHandler: null,
  };
}

/**
 * Picks the first MediaRecorder MIME type supported by this browser for the
 * requested output format. Falls back across the chain in OUTPUT_FORMAT_MIME_TYPES.
 */
function pickSupportedMimeType(format: VideoSettings['outputFormat']): string | null {
  const candidates = OUTPUT_FORMAT_MIME_TYPES[format];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

/**
 * Builds a canvas 2D filter string from VideoSettings. Mirrors the CSS filter
 * preview but is applied per-frame inside processVideo.
 */
function buildCanvasFilter(settings: VideoSettings): string {
  const parts: string[] = [
    `brightness(${settings.brightness}%)`,
    `contrast(${settings.contrast}%)`,
    `saturate(${settings.saturation}%)`,
  ];
  if (settings.hueRotate !== 0) parts.push(`hue-rotate(${settings.hueRotate}deg)`);
  if (settings.blur > 0) parts.push(`blur(${settings.blur}px)`);
  if (settings.sepia > 0) parts.push(`sepia(${settings.sepia}%)`);
  if (settings.grayscale > 0) parts.push(`grayscale(${settings.grayscale}%)`);
  return parts.join(' ');
}

/**
 * Pre-renders a small tile of monochrome noise. Each frame stamps this tile
 * across the canvas with a random offset instead of issuing thousands of
 * individual fillRect calls with freshly-allocated fillStyle strings
 * (which was the dominant main-thread cost: ~2k string allocs + style parses
 * per frame at 1080p).
 */
function createNoiseTile(): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = NOISE_TILE_SIZE;
  tile.height = NOISE_TILE_SIZE;
  const tctx = tile.getContext('2d');
  if (tctx) {
    const img = tctx.createImageData(NOISE_TILE_SIZE, NOISE_TILE_SIZE);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() > 0.5 ? 220 : 30;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 4 + Math.random() * 14; // ~0.016–0.07 alpha
    }
    tctx.putImageData(img, 0, 0);
  }
  return tile;
}

export function useVideoProcessor() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [internalProcessedVideoUrl, setInternalProcessedVideoUrl] = useState<string | null>(null);
  const [processedMimeType, setProcessedMimeType] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [processingWarning, setProcessingWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);

  const activeRunRef = useRef<{ runId: number; resources: RunResources } | null>(null);
  const cancelledRef = useRef(false);
  /**
   * Generation counter for processVideo runs. Every async callback (onstop,
   * onplay, onended, drawFrame, seek continuations, visibility handler)
   * captures the run id it started with and bails out when it no longer
   * matches — this kills the cancel→reprocess corruption race where a stale
   * recorder's onstop would poison a new run's state.
   */
  const runIdRef = useRef(0);

  // Refs for rotating lines effect state
  const rotationAngle1Ref = useRef<number>(0);
  const rotationAngle2Ref = useRef<number>(Math.PI / 2);

  /** Release every resource a run held. Null-safe: runs that failed during setup dispose cleanly. */
  const disposeResources = async (resources: RunResources) => {
    if (resources.visibilityHandler) {
      document.removeEventListener('visibilitychange', resources.visibilityHandler);
      resources.visibilityHandler = null;
    }
    if (resources.rafId) {
      cancelAnimationFrame(resources.rafId);
      resources.rafId = 0;
    }
    const mr = resources.mediaRecorder;
    resources.mediaRecorder = null;
    // stop() on a paused recorder is legal and fires onstop; the old code
    // only stopped 'recording', so ending mid-silence-skip left the promise
    // unsettled forever.
    if (mr && (mr.state === 'recording' || mr.state === 'paused')) {
      try { mr.stop(); } catch { /* ignore */ }
    }
    if (resources.stream) {
      try { resources.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      resources.stream = null;
    }
    resources.chunks = [];

    try { resources.video.pause(); } catch { /* ignore */ }
    resources.video.removeAttribute('src');
    try { resources.video.load(); } catch { /* ignore */ }
    // Revoke the blob URL for the source file; without this every processing
    // run pins another copy of the input in memory.
    if (resources.objectUrl) {
      URL.revokeObjectURL(resources.objectUrl);
      resources.objectUrl = null;
    }
    if (resources.audioContext && resources.audioContext.state !== 'closed') {
      try {
        await resources.audioContext.close();
      } catch (e) {
        console.error('Error closing AudioContext:', e);
      }
      resources.audioContext = null;
    }
  };

  const cleanup = useCallback(async () => {
    const run = activeRunRef.current;
    activeRunRef.current = null;
    if (run) {
      await disposeResources(run.resources);
    }
  }, []);

  useEffect(() => {
    const urlToRevoke = internalProcessedVideoUrl;
    return () => {
      if (urlToRevoke) {
        URL.revokeObjectURL(urlToRevoke);
      }
    };
  }, [internalProcessedVideoUrl]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const setProcessedVideoUrl = (url: string | null) => {
    setInternalProcessedVideoUrl(url);
  };

  const cancelProcessing = useCallback(async () => {
    if (!isProcessing) return;

    setIsCancelling(true);
    // Invalidate the run first: any in-flight async callback (stale onstop,
    // drawFrame, seek continuation) sees a mismatched run id and bails out.
    runIdRef.current += 1;
    // Set before cleanup(): stopping the recorder fires `onstop`, which must
    // discard the partial recording instead of offering it as a download.
    cancelledRef.current = true;
    setProcessingError('Processing cancelled by user');
    await cleanup();
    setIsProcessing(false);
    setProgress(0);
    setIsCancelling(false);
  }, [isProcessing, cleanup]);

  const processVideo = useCallback(async (
    videoFile: File,
    settings: VideoSettings,
    options?: ProcessVideoOptions
  ): Promise<string | null> => {
    const runId = ++runIdRef.current;
    const isStale = () => runId !== runIdRef.current;

    setIsProcessing(true);
    cancelledRef.current = false;

    // The previous URL is revoked by the effect above when this state changes.
    setProcessedVideoUrl(null);
    setProcessedMimeType(null);

    setProcessingError(null);
    setProcessingWarning(null);
    setProgress(0);
    await cleanup();

    rotationAngle1Ref.current = 0;
    rotationAngle2Ref.current = Math.PI / 2;

    return new Promise<string | null>((resolve, reject) => {
      // Every resolve/reject in this executor goes through these: the old
      // code had paths (stale recorder errors, throws out of event handlers)
      // where the caller's `await processVideo(...)` never resumed.
      let settled = false;
      const resolveOnce = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const rejectOnce = (reason?: unknown) => {
        if (!settled) {
          settled = true;
          reject(reason);
        }
      };

      // Exporting while the tab is hidden guarantees a desynced file: rAF
      // stops firing but MediaRecorder keeps muxing a frozen video track
      // against a running audio track. Refuse up front with a clear message.
      if (typeof document !== 'undefined' && document.hidden) {
        const err = 'Please keep this tab visible while exporting — background tabs freeze video encoding and corrupt the output.';
        setProcessingError(err);
        setIsProcessing(false);
        rejectOnce(new Error(err));
        return;
      }

      const video = document.createElement('video');
      const canvas = document.createElement('canvas');

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        const err = 'Could not get canvas context.';
        setProcessingError(err);
        setIsProcessing(false);
        rejectOnce(new Error(err));
        return;
      }

      // Register the run's resources BEFORE any await point: every early
      // failure below funnels through cleanup(), which disposes whatever this
      // run managed to create so far.
      const resources = makeRunResources(video, canvas);
      resources.objectUrl = URL.createObjectURL(videoFile);
      activeRunRef.current = { runId, resources };

      // Safari < 18 has no CanvasRenderingContext2D.filter: color adjustments
      // would silently do nothing in the export while the CSS-based preview
      // shows them. Warn instead of failing — the export is still usable.
      if (typeof (ctx as CanvasRenderingContext2D & { filter?: unknown }).filter === 'undefined') {
        setProcessingWarning(
          'Your browser does not support canvas color filters, so brightness/contrast/saturation adjustments will not appear in the exported video (preview may differ). Use Chrome, Edge, Firefox, or Safari 18+ for full fidelity.'
        );
      }

      try {
        resources.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        const err = 'AudioContext not supported.';
        setProcessingError(err);
        setIsProcessing(false);
        cleanup().catch(console.error);
        rejectOnce(new Error(err));
        return;
      }
      const audioContext = resources.audioContext;

      video.onloadedmetadata = async () => {
        if (isStale()) return;
        if (!video.videoWidth || !video.videoHeight) {
          const err = 'Invalid video: Video has no dimensions (width or height is 0). The file may be corrupted or audio-only.';
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          rejectOnce(new Error(err));
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Resolve trim window against the actual video duration.
        const sourceDuration = isFinite(video.duration) ? video.duration : 0;
        const trimStart = Math.max(0, Math.min(settings.trimStartSeconds ?? 0, Math.max(0, sourceDuration - 0.05)));
        const rawEnd = settings.trimEndSeconds ?? sourceDuration;
        const trimEnd = sourceDuration > 0
          ? Math.min(sourceDuration, Math.max(trimStart + 0.05, rawEnd))
          : rawEnd;
        const segmentDuration = Math.max(0, trimEnd - trimStart);

        // Silence skipping: sanitize caller-supplied ranges into sorted,
        // merged, non-trivial windows inside the trim segment. Empty by
        // default, in which case the export path below behaves exactly as before.
        const skipRanges: SilenceRegion[] = (() => {
          const sorted = (options?.skipRanges ?? [])
            .filter((r) => r && isFinite(r.start) && isFinite(r.end) && r.end > r.start)
            .map((r) => ({ start: Math.max(trimStart, r.start), end: Math.min(trimEnd, r.end) }))
            .filter((r) => r.end - r.start > 0.05)
            .sort((a, b) => a.start - b.start);
          const merged: SilenceRegion[] = [];
          for (const r of sorted) {
            const prev = merged[merged.length - 1];
            if (prev && r.start <= prev.end + 0.1) {
              prev.end = Math.max(prev.end, r.end);
            } else {
              merged.push({ ...r });
            }
          }
          return merged;
        })();

        // NOTE: no `video.muted = true` here, deliberately. createMediaElementSource
        // re-routes the element's audio into the Web Audio graph (away from the
        // speakers), so muting buys nothing — and in Chromium the muted flag is
        // applied *upstream* of the MediaElementSourceNode, which would zero the
        // samples fed to the recorder and produce a silent export.
        try {
          (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = settings.audioPreservesPitch;
        } catch { /* ignore */ }
        try {
          const v = video as HTMLVideoElement & { mozPreservesPitch?: boolean };
          if ('mozPreservesPitch' in video) v.mozPreservesPitch = settings.audioPreservesPitch;
        } catch { /* ignore */ }
        video.playbackRate = settings.playbackSpeed;

        // Seek to trim start before starting playback so we don't record leading frames.
        // The seek is raced against a timeout: if 'seeked' never fires (e.g. the
        // run was cancelled mid-seek), we must not leave the promise unsettled.
        // Short-circuit: seeking to (almost) the current position never fires
        // 'seeked' on some browsers and would eat the whole 10s timeout.
        if (trimStart > 0 && Math.abs(video.currentTime - trimStart) > 0.04) {
          const seeked = await new Promise<boolean>((resolveSeek) => {
            const timer = window.setTimeout(() => {
              video.removeEventListener('seeked', onSeeked);
              resolveSeek(false);
            }, SEEK_TIMEOUT_MS);
            const onSeeked = () => {
              window.clearTimeout(timer);
              video.removeEventListener('seeked', onSeeked);
              resolveSeek(true);
            };
            video.addEventListener('seeked', onSeeked);
            try { video.currentTime = trimStart; } catch { window.clearTimeout(timer); resolveSeek(false); }
          });
          if (isStale()) return;
          if (!seeked) {
            console.warn('Seek to trim start timed out; exporting from current position.');
          }
        }
        if (isStale()) return;

        let audioTrack: MediaStreamTrack | undefined;
        let gainNode: GainNode | null = null;

        // The audio graph is always wired up rather than gated on a
        // "does this video have audio?" probe. There is no portable way to
        // answer that question at `loadedmetadata` time: `video.audioTracks`
        // is Firefox/Safari-only, `mozHasAudio` is Firefox-only, and Chrome's
        // `webkitAudioDecodedByteCount` is still 0 before playback begins —
        // so probing dropped the audio of every video in Chrome and Edge.
        // A video with no audio simply contributes a silent track.
        try {
          const sourceNode = audioContext.createMediaElementSource(video);
          const node = audioContext.createGain();
          const targetGain = settings.volume / 100;
          node.gain.value = targetGain;
          sourceNode.connect(node);

          const audioDestinationNode = audioContext.createMediaStreamDestination();
          node.connect(audioDestinationNode);
          audioTrack = audioDestinationNode.stream.getAudioTracks()[0];
          gainNode = node;
        } catch (audioErr) {
          console.warn('Could not process audio track; exporting video only:', audioErr);
        }

        // Fades are driven by the video's own clock (media time), evaluated
        // per frame. The old code scheduled them on AudioContext time, but a
        // silence-skip pause stops the video while ctx time keeps running —
        // so a pause before the fade-out made it fire early and clip audio.
        const fadeTargetGain = settings.volume / 100;
        const fadeInSeconds = Math.max(0, settings.audioFadeInSeconds || 0);
        const fadeOutSeconds = Math.max(0, settings.audioFadeOutSeconds || 0);
        const updateFadeGain = () => {
          if (!gainNode || !resources.audioContext) return;
          const t = resources.video.currentTime;
          let g = fadeTargetGain;
          if (fadeInSeconds > 0) {
            g *= Math.min(1, Math.max(0, (t - trimStart) / fadeInSeconds));
          }
          if (fadeOutSeconds > 0) {
            g *= Math.min(1, Math.max(0, (trimEnd - t) / fadeOutSeconds));
          }
          try {
            gainNode.gain.setTargetAtTime(g, resources.audioContext.currentTime, 0.03);
          } catch { /* ignore */ }
        };

        const canvasStream = canvas.captureStream(FPS);
        const videoTrack = canvasStream.getVideoTracks()[0];

        const tracks: MediaStreamTrack[] = [videoTrack];
        if (audioTrack) tracks.push(audioTrack);
        const combinedStream = new MediaStream(tracks);
        resources.stream = combinedStream;

        const mimeType = pickSupportedMimeType(settings.outputFormat);
        if (!mimeType) {
          const err = `Selected output format (${settings.outputFormat}) is not supported by this browser. Try a different format such as WEBM (VP8).`;
          console.error(err);
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          rejectOnce(new Error(err));
          return;
        }

        const recorderOptions: MediaRecorderOptions = { mimeType };
        if (settings.outputBitrateKbps && settings.outputBitrateKbps > 0) {
          recorderOptions.videoBitsPerSecond = settings.outputBitrateKbps * 1000;
          // 128 kbps is a sane default; without this some browsers pick very low audio bitrates.
          recorderOptions.audioBitsPerSecond = 128000;
        }

        try {
          resources.mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);
        } catch (e: any) {
          const err = `Failed to create MediaRecorder: ${e.message}.`;
          console.error(err, e);
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          rejectOnce(new Error(err));
          return;
        }
        const mediaRecorder = resources.mediaRecorder;
        resources.chunks = [];

        const stopRecording = () => {
          const mr = resources.mediaRecorder;
          // stop() on a paused recorder is legal and fires onstop; only
          // stopping 'recording' left pause-held runs unsettled (item: stale
          // promise when the video ends mid-silence-skip).
          if (mr && (mr.state === 'recording' || mr.state === 'paused')) {
            try { mr.stop(); } catch { /* ignore */ }
          }
          if (resources.rafId) {
            cancelAnimationFrame(resources.rafId);
            resources.rafId = 0;
          }
        };

        /**
         * Abort the run with a user-visible error: stop capture, release the
         * run's resources, settle the promise. Used for failures that surface
         * mid-run — e.g. video.play() rejecting with NotAllowedError on
         * Safari/iOS once the user gesture has expired — where silently
         * ending would hand the user a broken file with no explanation.
         */
        const failRun = (message: string, err?: unknown) => {
          console.error(message, err);
          setProcessingError(message);
          setIsProcessing(false);
          stopRecording();
          cleanup().catch(console.error);
          rejectOnce(err instanceof Error ? err : new Error(message));
        };

        // --- Background-tab handling -------------------------------------
        // rAF freezes in hidden tabs while MediaRecorder keeps muxing. Pause
        // both the video and the recorder (and suspend the AudioContext),
        // then resume when visible again. Fades are driven by the video clock
        // (updateFadeGain), so suspending no longer skews them.
        let suspendedForHidden = false;
        const onVisibilityChange = () => {
          if (isStale()) return;
          const mr = resources.mediaRecorder;
          const videoEl = resources.video;
          if (document.hidden) {
            if (mr && mr.state === 'recording') { try { mr.pause(); } catch { /* ignore */ } }
            if (!videoEl.paused) { videoEl.pause(); }
            if (resources.audioContext && resources.audioContext.state === 'running') {
              resources.audioContext.suspend().catch(() => {});
            }
            suspendedForHidden = true;
          } else if (suspendedForHidden) {
            suspendedForHidden = false;
            if (resources.audioContext && resources.audioContext.state === 'suspended') {
              resources.audioContext.resume().catch(console.error);
            }
            if (mr && mr.state === 'paused') { try { mr.resume(); } catch { /* ignore */ } }
            if (videoEl.paused && !videoEl.ended) {
              videoEl.play().catch((err) => {
                if (isStale()) return;
                // A failed resume would otherwise spin the draw loop forever
                // (paused + suspendedForHidden re-arms rAF indefinitely).
                failRun(
                  'Could not resume video playback after the tab became visible again. The export was stopped to avoid a corrupted file.',
                  err
                );
              });
            }
          }
        };
        resources.visibilityHandler = onVisibilityChange;
        document.addEventListener('visibilitychange', onVisibilityChange);

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            resources.chunks.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          if (isStale() || cancelledRef.current) {
            // Cancelled mid-recording or superseded by a newer run: the run
            // that superseded/cancelled owns disposal — just settle.
            resolveOnce(null);
            return;
          }
          if (settled) {
            // The run already failed (failRun settled the promise and showed
            // the error); a partial onstop must not overwrite that state.
            return;
          }

          const blob = new Blob(resources.chunks, { type: mediaRecorder.mimeType });
          resources.chunks = [];
          const url = URL.createObjectURL(blob);
          setProcessedVideoUrl(url);
          setProcessedMimeType(mediaRecorder.mimeType || mimeType);
          setIsProcessing(false);
          setProgress(100);

          // Release everything the run held (tracks, AudioContext, source
          // blob URL). The output URL is intentionally kept.
          cleanup().catch(console.error);

          resolveOnce(url);
        };

        mediaRecorder.onerror = (event: Event) => {
          if (isStale()) {
            // The old code returned here without settling: the caller's await
            // never resumed. Settle as an abort — resolveOnce makes this a
            // no-op if the promise already settled.
            const abortError = new Error('Export superseded by a newer run.');
            abortError.name = 'AbortError';
            rejectOnce(abortError);
            return;
          }
          const recorderEventError = (event as any).error;
          let errorMessageText = 'MediaRecorder unspecified error';
          let errorToReject: Error;

          if (recorderEventError instanceof Error) {
            errorMessageText = `MediaRecorder error: ${recorderEventError.name} - ${recorderEventError.message}`;
            errorToReject = recorderEventError;
          } else if (recorderEventError && typeof recorderEventError.name === 'string') {
            errorMessageText = `MediaRecorder error: ${recorderEventError.name}${recorderEventError.message ? ` - ${recorderEventError.message}` : ''}`;
            errorToReject = new Error(errorMessageText);
            errorToReject.name = recorderEventError.name;
          } else {
            errorToReject = new Error(errorMessageText);
          }

          console.error(errorMessageText, event);
          setProcessingError(errorMessageText);
          setIsProcessing(false);
          cleanup().catch(console.error);
          rejectOnce(errorToReject);
        };

        const baseFilter = buildCanvasFilter(settings);

        // Pre-build a vignette gradient (cheaper than rebuilding each frame).
        let vignetteFill: CanvasGradient | null = null;
        if (settings.vignette > 0) {
          const cx = canvas.width / 2;
          const cy = canvas.height / 2;
          const outerRadius = Math.hypot(cx, cy);
          vignetteFill = ctx.createRadialGradient(cx, cy, outerRadius * 0.5, cx, cy, outerRadius);
          vignetteFill.addColorStop(0, 'rgba(0,0,0,0)');
          vignetteFill.addColorStop(1, `rgba(0,0,0,${settings.vignette / 100})`);
        }

        // Pre-rendered noise tile (see createNoiseTile): stamped with a random
        // offset each frame instead of thousands of fillRect calls.
        const noiseTile = settings.enablePixelNoise ? createNoiseTile() : null;

        const drawSingleFrame = () => {
          const canvasEl = resources.canvas;
          const videoEl = resources.video;
          if (!canvasEl || !videoEl) return;

          ctx.save();
          if (settings.flipHorizontal) {
            ctx.translate(canvasEl.width, 0);
            ctx.scale(-1, 1);
          }
          ctx.filter = baseFilter;
          ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
          ctx.restore();

          // Reset filter for overlays that should not be filtered.
          ctx.filter = 'none';

          if (noiseTile) {
            const ox = Math.random() * NOISE_TILE_SIZE;
            const oy = Math.random() * NOISE_TILE_SIZE;
            for (let x = -ox; x < canvasEl.width; x += NOISE_TILE_SIZE) {
              for (let y = -oy; y < canvasEl.height; y += NOISE_TILE_SIZE) {
                ctx.drawImage(noiseTile, x, y);
              }
            }
          }

          if (settings.enableRotatingLines) {
            const centerX = canvasEl.width / 2;
            const centerY = canvasEl.height / 2;
            const lineLength = Math.hypot(canvasEl.width, canvasEl.height);

            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(rotationAngle1Ref.current);
            ctx.beginPath();
            ctx.moveTo(-lineLength / 2, 0);
            ctx.lineTo(lineLength / 2, 0);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(rotationAngle2Ref.current);
            ctx.beginPath();
            ctx.moveTo(0, -lineLength / 2);
            ctx.lineTo(0, lineLength / 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }

          if (vignetteFill) {
            ctx.save();
            ctx.fillStyle = vignetteFill;
            ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
            ctx.restore();
          }
        };

        let lastFrameNow = 0;
        let lastDrawnVideoTime = -1;
        let lastProgressSent = -1;
        let lastProgressAt = 0;
        // Silence-skip state: while a skip is in flight the element is
        // deliberately paused and the recorder held, so drawFrame must not
        // mistake "paused" for the end of the export.
        let isSkippingSilence = false;
        let lastSkipEnd = -1; // end of the most recently skipped range
        // Moving index into the sorted skipRanges: advanced past anything
        // already skipped or behind us, so we don't scan the array per frame.
        let skipIdx = 0;

        /**
         * Cut one silent stretch: hold the recorder, jump the video past the
         * range, resume both. Mirrors the trim-start seek pattern (seek raced
         * against a timeout; every path clears the skip flag and settles the
         * promise so the draw loop can never wedge).
         */
        const skipSilenceRange = (videoEl: HTMLVideoElement, range: SilenceRegion): Promise<void> => {
          return new Promise((resolve) => {
            if (isStale()) { resolve(); return; }
            const target = Math.min(range.end, trimEnd);
            // Short-circuit: seeking to (almost) the current position never
            // fires 'seeked' on some browsers and would eat the 10s timeout.
            if (Math.abs(videoEl.currentTime - target) < 0.05) {
              resolve();
              return;
            }
            isSkippingSilence = true;
            lastSkipEnd = range.end;
            const mr = resources.mediaRecorder;
            if (mr && mr.state === 'recording') { try { mr.pause(); } catch { /* ignore */ } }
            videoEl.pause();

            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              // Keep isSkippingSilence set until playback has actually begun
              // (or definitively failed): a drawFrame tick landing between
              // 'seeked' and play() resolving must not read a paused element
              // as the end of the export.
              if (isStale()) { isSkippingSilence = false; resolve(); return; }
              videoEl.play()
                .then(() => {
                  isSkippingSilence = false;
                  if (isStale()) return;
                  const mr2 = resources.mediaRecorder;
                  // Never resume the recorder while hidden: rAF is frozen, so
                  // the canvas would mux frozen frames against live audio
                  // (the desync the visibility handler exists to prevent).
                  // The handler resumes everything on visibility.
                  const hidden = typeof document !== 'undefined' && document.hidden;
                  if (mr2 && mr2.state === 'paused' && !hidden) { try { mr2.resume(); } catch { /* ignore */ } }
                })
                .catch((playErr) => {
                  isSkippingSilence = false;
                  // A failed resume after a silence skip must not die
                  // silently: abort the run with an explicit error so the
                  // user gets a message, not a truncated export.
                  if (!isStale()) {
                    failRun(
                      'Could not resume video playback after skipping silence. The export was stopped to avoid a corrupted file.',
                      playErr
                    );
                  }
                })
                .finally(() => resolve());
            };
            const timer = window.setTimeout(() => {
              videoEl.removeEventListener('seeked', onSeeked);
              finish();
            }, SEEK_TIMEOUT_MS);
            const onSeeked = () => {
              window.clearTimeout(timer);
              videoEl.removeEventListener('seeked', onSeeked);
              finish();
            };
            videoEl.addEventListener('seeked', onSeeked);
            try {
              videoEl.currentTime = target;
            } catch {
              window.clearTimeout(timer);
              videoEl.removeEventListener('seeked', onSeeked);
              finish();
            }
          });
        };

        const drawFrame = (now: number) => {
          if (isStale()) return;
          const videoEl = resources.video;
          const canvasEl = resources.canvas;
          if (!videoEl || !canvasEl) {
            stopRecording();
            return;
          }
          // While a silence skip is in flight the element is deliberately
          // paused — don't mistake it for the end of the export.
          if (!isSkippingSilence && (videoEl.paused || videoEl.ended)) {
            if (suspendedForHidden && !videoEl.ended) {
              // Auto-paused for a hidden tab: keep the loop armed (rAF is
              // frozen while hidden anyway); drawing resumes on visibility.
              resources.rafId = requestAnimationFrame(drawFrame);
              return;
            }
            stopRecording();
            return;
          }

          // Stop early if we've reached the trim end.
          if (segmentDuration > 0 && videoEl.currentTime >= trimEnd) {
            videoEl.pause();
            stopRecording();
            return;
          }

          // Silence skipping: entering a dead-air stretch pauses the recorder,
          // jumps past the range, and resumes — the export omits the silence.
          // The loop stays armed through the skip; the skip promise clears
          // isSkippingSilence on every path so this branch can't wedge.
          // lastSkipEnd keeps a keyframe-snapped seek from re-triggering.
          if (!isSkippingSilence && skipRanges.length > 0) {
            while (
              skipIdx < skipRanges.length &&
              (skipRanges[skipIdx].end <= lastSkipEnd + 0.02 ||
                videoEl.currentTime >= skipRanges[skipIdx].end)
            ) {
              skipIdx++;
            }
            const candidate = skipIdx < skipRanges.length ? skipRanges[skipIdx] : undefined;
            if (
              candidate &&
              videoEl.currentTime >= candidate.start &&
              videoEl.currentTime < candidate.end
            ) {
              void skipSilenceRange(videoEl, candidate);
              resources.rafId = requestAnimationFrame(drawFrame);
              return;
            }
          }

          // Fades follow the video clock (see updateFadeGain): a silence-skip
          // pause must not shift them.
          updateFadeGain();

          // Time-based animation: the old code advanced rotation once per rAF
          // tick, so effects ran 4-5x faster on 120/144Hz displays while the
          // capturer still sampled at 30fps. dt keeps effect speed honest.
          const dt = lastFrameNow > 0 ? Math.min(0.1, (now - lastFrameNow) / 1000) : 1 / FPS;
          lastFrameNow = now;

          // Skip redraws when the video hasn't advanced: the capturer samples
          // at 30fps, so drawing faster only burns CPU on dropped frames.
          if (Math.abs(videoEl.currentTime - lastDrawnVideoTime) >= MIN_DRAW_INTERVAL_SECONDS) {
            lastDrawnVideoTime = videoEl.currentTime;
            rotationAngle1Ref.current =
              (rotationAngle1Ref.current + ((2 * Math.PI) / ROTATION_DURATION_SECONDS) * dt) % (2 * Math.PI);
            rotationAngle2Ref.current =
              (((rotationAngle2Ref.current - ((2 * Math.PI) / ROTATION_DURATION_SECONDS) * dt) % (2 * Math.PI)) +
                2 * Math.PI) %
              (2 * Math.PI);
            drawSingleFrame();
          }

          // Throttle progress: the old code called setProgress up to 144x/sec,
          // re-rendering the whole app tree each time for no visible benefit.
          if (segmentDuration > 0 && now - lastProgressAt >= PROGRESS_UPDATE_MIN_INTERVAL_MS) {
            const elapsed = Math.max(0, videoEl.currentTime - trimStart);
            const progressValue = Math.min(100, Math.round((elapsed / segmentDuration) * 100));
            if (isFinite(progressValue) && progressValue !== lastProgressSent) {
              lastProgressSent = progressValue;
              lastProgressAt = now;
              setProgress(progressValue);
            }
          }
          resources.rafId = requestAnimationFrame(drawFrame);
        };

        video.onplay = () => {
          if (isStale()) return;
          // Guard against double-scheduling: re-arms (e.g. after the
          // background-tab auto-resume) must cancel the previous loop first,
          // or two loops draw concurrently and the orphan can never be stopped.
          if (resources.rafId) {
            cancelAnimationFrame(resources.rafId);
            resources.rafId = 0;
          }
          if (audioContext.state === 'suspended' && !suspendedForHidden) {
            audioContext.resume().catch(console.error);
          }

          // Note: audio fades are NOT scheduled here. They used to be
          // scheduled once on audioContext.currentTime, but silence-skip
          // pauses stop the video while ctx time keeps running, which made
          // the fade-out fire early and clip audio. updateFadeGain() drives
          // them from the video clock every frame instead (see drawFrame).

          lastFrameNow = 0;
          resources.rafId = requestAnimationFrame(drawFrame);
        };

        video.onended = () => {
          if (isStale()) return;
          stopRecording();
        };

        // Draw the first frame BEFORE the recorder starts so the export opens
        // on the video instead of black frames (the canvas has never been
        // painted at this point; the video is already seeked and pausable).
        drawSingleFrame();
        // Prime the fade gain before the first recorded frame.
        updateFadeGain();

        try {
          mediaRecorder.start();
        } catch (e) {
          // start() throws synchronously (e.g. InvalidStateError) — without
          // this the exception escapes the event handler and the promise
          // never settles.
          failRun(`Could not start recording: ${e instanceof Error ? e.message : 'unknown error'}`, e);
          return;
        }
        video.play().catch(err => {
          if (isStale()) return;
          // play() after the awaits above can throw NotAllowedError on
          // Safari/iOS once the user gesture has expired — an explicit error
          // beats a silently empty export.
          const gestureHint = err && err.name === 'NotAllowedError'
            ? ' The browser blocked playback (on iPhone/iPad, start the export with a tap and keep this tab visible).'
            : '';
          failRun(`Could not start video playback: ${err?.message || err}.${gestureHint}`, err);
        });
      };

      video.onerror = (e) => {
        const errorMsg = (video.error?.message || 'Failed to load video file.');
        const err = `Error loading video: ${errorMsg}`;
        console.error(err, e);
        setProcessingError(err);
        setIsProcessing(false);
        cleanup().catch(console.error);
        rejectOnce(new Error(err));
      };

      video.src = resources.objectUrl;
    });
  }, [cleanup]);

  return {
    processVideo,
    cancelProcessing,
    isProcessing,
    isCancelling,
    processedVideoUrl: internalProcessedVideoUrl,
    processedMimeType,
    processingError,
    processingWarning,
    progress,
    setProcessedVideoUrl,
  };
}
