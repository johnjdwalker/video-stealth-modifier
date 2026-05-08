import { useState, useCallback, useRef, useEffect } from 'react';
import { VideoSettings } from '../types';
import { OUTPUT_FORMAT_MIME_TYPES } from '../constants';

// Constants for rotating lines effect configuration
const FPS = 30; // Should match canvas.captureStream frame rate
const ROTATION_DURATION_SECONDS = 30; // Duration for one full 360-degree rotation

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

export function useVideoProcessor() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [internalProcessedVideoUrl, setInternalProcessedVideoUrl] = useState<string | null>(null);
  const [processedMimeType, setProcessedMimeType] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameIdRef = useRef<number>(0);

  // Refs for rotating lines effect state
  const rotationAngle1Ref = useRef<number>(0);
  const rotationAngle2Ref = useRef<number>(Math.PI / 2);

  const cleanup = useCallback(async () => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = 0;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    recordedChunksRef.current = [];

    if (sourceVideoRef.current) {
      sourceVideoRef.current.pause();
      sourceVideoRef.current.removeAttribute('src');
      sourceVideoRef.current.load();
      sourceVideoRef.current = null;
    }
    if (canvasRef.current) {
      canvasRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        await audioContextRef.current.close();
      } catch (e) {
        console.error('Error closing AudioContext:', e);
      }
      audioContextRef.current = null;
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
    setProcessingError('Processing cancelled by user');
    await cleanup();
    setIsProcessing(false);
    setProgress(0);
    setIsCancelling(false);
  }, [isProcessing, cleanup]);

  const processVideo = useCallback(async (videoFile: File, settings: VideoSettings): Promise<string | null> => {
    setIsProcessing(true);

    if (internalProcessedVideoUrl) {
      URL.revokeObjectURL(internalProcessedVideoUrl);
    }
    setProcessedVideoUrl(null);
    setProcessedMimeType(null);

    setProcessingError(null);
    setProgress(0);
    await cleanup();

    rotationAngle1Ref.current = 0;
    rotationAngle2Ref.current = Math.PI / 2;

    return new Promise<string | null>((resolve, reject) => {
      const video = document.createElement('video');
      sourceVideoRef.current = video;

      const canvas = document.createElement('canvas');
      canvasRef.current = canvas;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        const err = 'Could not get canvas context.';
        setProcessingError(err);
        setIsProcessing(false);
        cleanup().catch(console.error);
        reject(new Error(err));
        return;
      }

      try {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        const err = 'AudioContext not supported.';
        setProcessingError(err);
        setIsProcessing(false);
        cleanup().catch(console.error);
        reject(new Error(err));
        return;
      }
      const audioContext = audioContextRef.current;

      video.onloadedmetadata = async () => {
        if (!video.videoWidth || !video.videoHeight) {
          const err = 'Invalid video: Video has no dimensions (width or height is 0). The file may be corrupted or audio-only.';
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          reject(new Error(err));
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

        video.preservesPitch = settings.audioPreservesPitch;
        video.playbackRate = settings.playbackSpeed;
        video.muted = true;

        // Seek to trim start before starting playback so we don't record leading frames.
        if (trimStart > 0) {
          await new Promise<void>((resolveSeek) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              resolveSeek();
            };
            video.addEventListener('seeked', onSeeked);
            try { video.currentTime = trimStart; } catch { resolveSeek(); }
          });
        }

        let audioTrack: MediaStreamTrack | undefined;
        let gainNode: GainNode | null = null;
        const hasAudioTracks = (video as any).audioTracks && (video as any).audioTracks.length > 0;
        const hasMozAudio = (video as any).mozHasAudio;
        const hasWebkitAudio = (video as any).webkitAudioDecodedByteCount !== undefined && (video as any).webkitAudioDecodedByteCount > 0;

        if (hasAudioTracks || hasMozAudio || hasWebkitAudio) {
          try {
            const sourceNode = audioContext.createMediaElementSource(video);
            const node = audioContext.createGain();
            const targetGain = settings.volume / 100;
            const fadeIn = Math.max(0, settings.audioFadeInSeconds || 0);
            node.gain.value = fadeIn > 0 ? 0 : targetGain;
            sourceNode.connect(node);

            const audioDestinationNode = audioContext.createMediaStreamDestination();
            node.connect(audioDestinationNode);
            audioTrack = audioDestinationNode.stream.getAudioTracks()[0];
            gainNode = node;
          } catch (audioErr) {
            console.warn('Could not process audio track:', audioErr);
          }
        }

        const canvasStream = canvas.captureStream(FPS);
        const videoTrack = canvasStream.getVideoTracks()[0];

        const tracks: MediaStreamTrack[] = [videoTrack];
        if (audioTrack) tracks.push(audioTrack);
        const combinedStream = new MediaStream(tracks);

        const mimeType = pickSupportedMimeType(settings.outputFormat);
        if (!mimeType) {
          const err = `Selected output format (${settings.outputFormat}) is not supported by this browser. Try a different format such as WEBM (VP8).`;
          console.error(err);
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          reject(new Error(err));
          return;
        }

        const recorderOptions: MediaRecorderOptions = { mimeType };
        if (settings.outputBitrateKbps && settings.outputBitrateKbps > 0) {
          recorderOptions.videoBitsPerSecond = settings.outputBitrateKbps * 1000;
        }

        try {
          mediaRecorderRef.current = new MediaRecorder(combinedStream, recorderOptions);
        } catch (e: any) {
          const err = `Failed to create MediaRecorder: ${e.message}.`;
          console.error(err, e);
          setProcessingError(err);
          setIsProcessing(false);
          cleanup().catch(console.error);
          reject(new Error(err));
          return;
        }
        const mediaRecorder = mediaRecorderRef.current;
        recordedChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, { type: mediaRecorder.mimeType });
          const url = URL.createObjectURL(blob);
          setProcessedVideoUrl(url);
          setProcessedMimeType(mediaRecorder.mimeType || mimeType);
          setIsProcessing(false);
          setProgress(100);
          resolve(url);

          if (mediaRecorderRef.current) mediaRecorderRef.current = null;
          if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
          animationFrameIdRef.current = 0;
        };

        mediaRecorder.onerror = (event: Event) => {
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
          reject(errorToReject);
        };

        const rotationIncrementPerFrame = (2 * Math.PI) / (ROTATION_DURATION_SECONDS * FPS);

        const numNoisePixels = settings.enablePixelNoise
          ? Math.floor((canvas.width * canvas.height) * 0.001)
          : 0;

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

        const drawFrame = () => {
          if (!sourceVideoRef.current || sourceVideoRef.current.paused || sourceVideoRef.current.ended || !canvasRef.current || !ctx) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
            if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = 0;
            return;
          }

          // Stop early if we've reached the trim end.
          if (segmentDuration > 0 && sourceVideoRef.current.currentTime >= trimEnd) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
            sourceVideoRef.current.pause();
            if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = 0;
            return;
          }

          ctx.save();
          if (settings.flipHorizontal) {
            ctx.translate(canvasRef.current.width, 0);
            ctx.scale(-1, 1);
          }
          ctx.filter = baseFilter;
          ctx.drawImage(sourceVideoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.restore();

          // Reset filter for overlays that should not be filtered.
          ctx.filter = 'none';

          if (settings.enablePixelNoise && canvasRef.current) {
            const currentCanvas = canvasRef.current;
            for (let i = 0; i < numNoisePixels; i++) {
              const x = Math.random() * currentCanvas.width;
              const y = Math.random() * currentCanvas.height;
              const intensity = Math.random() > 0.5 ? 220 : 30;
              const alpha = Math.random() * 0.05 + 0.02;
              ctx.fillStyle = `rgba(${intensity}, ${intensity}, ${intensity}, ${alpha})`;
              ctx.fillRect(x, y, 1, 1);
            }
          }

          if (settings.enableRotatingLines && canvasRef.current) {
            const currentCanvas = canvasRef.current;
            const centerX = currentCanvas.width / 2;
            const centerY = currentCanvas.height / 2;
            const lineLength = Math.hypot(currentCanvas.width, currentCanvas.height);
            const lineWidth = 1.5;

            rotationAngle1Ref.current += rotationIncrementPerFrame;
            rotationAngle2Ref.current -= rotationIncrementPerFrame;
            rotationAngle1Ref.current %= (2 * Math.PI);
            rotationAngle2Ref.current = (rotationAngle2Ref.current % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI);

            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(rotationAngle1Ref.current);
            ctx.beginPath();
            ctx.moveTo(-lineLength / 2, 0);
            ctx.lineTo(lineLength / 2, 0);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = lineWidth;
            ctx.stroke();
            ctx.restore();

            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate(rotationAngle2Ref.current);
            ctx.beginPath();
            ctx.moveTo(0, -lineLength / 2);
            ctx.lineTo(0, lineLength / 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = lineWidth;
            ctx.stroke();
            ctx.restore();
          }

          if (vignetteFill) {
            ctx.save();
            ctx.fillStyle = vignetteFill;
            ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            ctx.restore();
          }

          if (segmentDuration > 0) {
            const elapsed = Math.max(0, sourceVideoRef.current.currentTime - trimStart);
            const progressValue = (elapsed / segmentDuration) * 100;
            if (isFinite(progressValue)) {
              setProgress(Math.min(100, Math.round(progressValue)));
            }
          }
          animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        };

        video.onplay = () => {
          if (audioContext.state === 'suspended') {
            audioContext.resume().catch(console.error);
          }

          // Schedule audio fades using audioContext.currentTime (real-time, not video time).
          const localGainNode = gainNode;
          if (localGainNode) {
            const targetGain = settings.volume / 100;
            const fadeIn = Math.max(0, settings.audioFadeInSeconds || 0);
            const fadeOut = Math.max(0, settings.audioFadeOutSeconds || 0);
            const speed = Math.max(0.0001, settings.playbackSpeed);
            const realDuration = segmentDuration > 0 ? segmentDuration / speed : 0;

            const t0 = audioContext.currentTime;
            localGainNode.gain.cancelScheduledValues(t0);
            if (fadeIn > 0) {
              localGainNode.gain.setValueAtTime(0, t0);
              localGainNode.gain.linearRampToValueAtTime(targetGain, t0 + Math.min(fadeIn, realDuration || fadeIn));
            } else {
              localGainNode.gain.setValueAtTime(targetGain, t0);
            }
            if (fadeOut > 0 && realDuration > 0) {
              const fadeStart = Math.max(t0, t0 + realDuration - fadeOut);
              localGainNode.gain.setValueAtTime(targetGain, fadeStart);
              localGainNode.gain.linearRampToValueAtTime(0, t0 + realDuration);
            }
          }

          animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        };

        video.onended = () => {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
          }
          if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
          animationFrameIdRef.current = 0;
        };

        mediaRecorder.start();
        video.play().catch(err => {
          const errorMsg = `Could not start video playback: ${err.message}`;
          console.error(errorMsg, err);
          setProcessingError(errorMsg);
          setIsProcessing(false);
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop();
          cleanup().catch(console.error);
          reject(err);
        });
      };

      video.onerror = (e) => {
        const errorMsg = (video.error?.message || 'Failed to load video file.');
        const err = `Error loading video: ${errorMsg}`;
        console.error(err, e);
        setProcessingError(err);
        setIsProcessing(false);
        cleanup().catch(console.error);
        reject(new Error(err));
      };

      video.src = URL.createObjectURL(videoFile);
    });
  }, [cleanup, internalProcessedVideoUrl]);

  return {
    processVideo,
    cancelProcessing,
    isProcessing,
    isCancelling,
    processedVideoUrl: internalProcessedVideoUrl,
    processedMimeType,
    processingError,
    progress,
    setProcessedVideoUrl,
  };
}
