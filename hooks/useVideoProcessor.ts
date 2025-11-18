
import { useState, useCallback, useRef, useEffect } from 'react';
import { VideoSettings } from '../types';

// Constants for rotating lines effect configuration
const FPS = 30; // Should match canvas.captureStream frame rate
const ROTATION_DURATION_SECONDS = 30; // Duration for one full 360-degree rotation
const MIN_WATERMARK_DIMENSION_PX = 4;

const clampValue = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const percentToPixels = (percent: number, total: number) => {
  const safePercent = clampValue(Number.isFinite(percent) ? percent : 0, 0, 100);
  return Math.round((safePercent / 100) * total);
};

export function useVideoProcessor() {
    const [isProcessing, setIsProcessing] = useState(false);
    const [internalProcessedVideoUrl, setInternalProcessedVideoUrl] = useState<string | null>(null);
    const [processingError, setProcessingError] = useState<string | null>(null);
    const [progress, setProgress] = useState(0);

    const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const watermarkPixelateHelperRef = useRef<HTMLCanvasElement | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordedChunksRef = useRef<Blob[]>([]);
    const audioContextRef = useRef<AudioContext | null>(null);
    const animationFrameIdRef = useRef<number>(0);

  // Refs for rotating lines effect state
  const rotationAngle1Ref = useRef<number>(0); // For the line starting horizontally
  const rotationAngle2Ref = useRef<number>(Math.PI / 2); // For the line starting vertically

  const cleanup = useCallback(() => {
    if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = 0;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
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
      if (watermarkPixelateHelperRef.current) {
          watermarkPixelateHelperRef.current.width = 0;
          watermarkPixelateHelperRef.current.height = 0;
          watermarkPixelateHelperRef.current = null;
      }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(console.error);
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


  const processVideo = useCallback(async (videoFile: File, settings: VideoSettings): Promise<string | null> => {
    setIsProcessing(true);
    setProcessedVideoUrl(null); 
    setProcessingError(null);
    setProgress(0);
    cleanup(); 

    // Reset rotating lines angles
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
        cleanup();
        reject(new Error(err));
        return;
      }

      try {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch (e) {
        const err = 'AudioContext not supported.';
        setProcessingError(err);
        setIsProcessing(false);
        cleanup();
        reject(new Error(err));
        return;
      }
      const audioContext = audioContextRef.current;
      
      video.onloadedmetadata = async () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        video.preservesPitch = settings.audioPreservesPitch;
        video.playbackRate = settings.playbackSpeed;
        video.muted = true; 

        let audioTrack: MediaStreamTrack | undefined;
        const hasAudioTracks = (video as any).audioTracks && (video as any).audioTracks.length > 0;
        const hasMozAudio = (video as any).mozHasAudio; 
        const hasWebkitAudio = (video as any).webkitAudioDecodedByteCount !== undefined && (video as any).webkitAudioDecodedByteCount > 0;
        
        if (hasAudioTracks || hasMozAudio || hasWebkitAudio) {
            try {
                const sourceNode = audioContext.createMediaElementSource(video);
                const gainNode = audioContext.createGain();
                gainNode.gain.value = settings.volume / 100;
                sourceNode.connect(gainNode);
                
                const audioDestinationNode = audioContext.createMediaStreamDestination();
                gainNode.connect(audioDestinationNode);
                audioTrack = audioDestinationNode.stream.getAudioTracks()[0];
            } catch (audioErr) {
                console.warn("Could not process audio track:", audioErr);
            }
        }

        const canvasStream = canvas.captureStream(FPS); 
        const videoTrack = canvasStream.getVideoTracks()[0];
        
        const tracks = [videoTrack];
        if (audioTrack) {
            tracks.push(audioTrack);
        }
        const combinedStream = new MediaStream(tracks);

        const mimeType = 'video/webm;codecs=vp8,opus'; 
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            const err = `MIME type ${mimeType} not supported for MediaRecorder. Your browser may not support WEBM (VP8/Opus) recording.`;
            console.error(err);
            setProcessingError(err);
            setIsProcessing(false);
            cleanup();
            reject(new Error(err));
            return;
        }

        try {
          mediaRecorderRef.current = new MediaRecorder(combinedStream, { mimeType });
        } catch (e: any) {
            const err = `Failed to create MediaRecorder: ${e.message}.`;
            console.error(err, e);
            setProcessingError(err);
            setIsProcessing(false);
            cleanup();
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
          setIsProcessing(false);
          setProgress(100);
          resolve(url);
          
          if (mediaRecorderRef.current) mediaRecorderRef.current = null;
          if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
          animationFrameIdRef.current = 0;
        };

        mediaRecorder.onerror = (event: Event) => {
            const recorderEventError = (event as any).error; // This could be a DOMException or similar
            let errorMessageText = 'MediaRecorder unspecified error';
            let errorToReject: Error;

            if (recorderEventError instanceof Error) {
                errorMessageText = `MediaRecorder error: ${recorderEventError.name} - ${recorderEventError.message}`;
                errorToReject = recorderEventError;
            } else if (recorderEventError && typeof recorderEventError.name === 'string') { // DOMException like structure
                 errorMessageText = `MediaRecorder error: ${recorderEventError.name}${recorderEventError.message ? ` - ${recorderEventError.message}` : ''}`;
                 errorToReject = new Error(errorMessageText);
                 errorToReject.name = recorderEventError.name; // Preserve original error name if possible
            } else {
                 errorToReject = new Error(errorMessageText);
            }
            
            console.error(errorMessageText, event); // Log original event for full details
            setProcessingError(errorMessageText); // Update UI with the formatted error message
            setIsProcessing(false);
            cleanup();
            reject(errorToReject); // Reject promise with an actual Error object
        };
        
          const rotationIncrementPerFrame = (2 * Math.PI) / (ROTATION_DURATION_SECONDS * FPS);

          const applyWatermarkMask = () => {
            if (!settings.removeWatermark || !canvasRef.current) {
              return;
            }
            const renderCanvas = canvasRef.current;
            if (!renderCanvas.width || !renderCanvas.height) {
              return;
            }

            const maskWidth = clampValue(
              percentToPixels(settings.watermarkWidthPercent, renderCanvas.width),
              MIN_WATERMARK_DIMENSION_PX,
              renderCanvas.width
            );
            const maskHeight = clampValue(
              percentToPixels(settings.watermarkHeightPercent, renderCanvas.height),
              MIN_WATERMARK_DIMENSION_PX,
              renderCanvas.height
            );

            if (maskWidth <= 0 || maskHeight <= 0) {
              return;
            }

            const requestedX = percentToPixels(settings.watermarkXPercent, renderCanvas.width);
            const requestedY = percentToPixels(settings.watermarkYPercent, renderCanvas.height);
            const destX = clampValue(requestedX, 0, Math.max(0, renderCanvas.width - maskWidth));
            const destY = clampValue(requestedY, 0, Math.max(0, renderCanvas.height - maskHeight));

            const blurRegion = () => {
              ctx.save();
              const blurRadius = Math.max(2, Math.round(Math.min(maskWidth, maskHeight) * 0.12));
              ctx.filter = `blur(${blurRadius}px)`;
              ctx.drawImage(renderCanvas, destX, destY, maskWidth, maskHeight, destX, destY, maskWidth, maskHeight);
              ctx.restore();
              return true;
            };

            const cloneRegion = () => {
              const offset = Math.max(maskHeight, Math.round(maskHeight * 0.4));
              let sampleY = destY - offset;
              if (sampleY < 0) {
                sampleY = destY + offset;
              }
              sampleY = clampValue(sampleY, 0, Math.max(0, renderCanvas.height - maskHeight));

              let sampleX = destX;
              if (sampleX + maskWidth > renderCanvas.width) {
                sampleX = renderCanvas.width - maskWidth;
              }
              sampleX = clampValue(sampleX, 0, Math.max(0, renderCanvas.width - maskWidth));

              const isSameRegion = Math.abs(sampleX - destX) < 1 && Math.abs(sampleY - destY) < 1;
              if (isSameRegion) {
                return false;
              }

              ctx.drawImage(renderCanvas, sampleX, sampleY, maskWidth, maskHeight, destX, destY, maskWidth, maskHeight);
              return true;
            };

            const pixelateRegion = () => {
              if (!watermarkPixelateHelperRef.current) {
                watermarkPixelateHelperRef.current = document.createElement('canvas');
              }
              const helperCanvas = watermarkPixelateHelperRef.current;
              if (!helperCanvas) {
                return false;
              }
              const helperCtx = helperCanvas.getContext('2d');
              if (!helperCtx) {
                return false;
              }

              const blockSize = Math.max(4, Math.round(Math.min(maskWidth, maskHeight) / 18));
              const sampleWidth = Math.max(1, Math.floor(maskWidth / blockSize));
              const sampleHeight = Math.max(1, Math.floor(maskHeight / blockSize));

              helperCanvas.width = sampleWidth;
              helperCanvas.height = sampleHeight;
              helperCtx.imageSmoothingEnabled = false;
              helperCtx.clearRect(0, 0, sampleWidth, sampleHeight);
              helperCtx.drawImage(renderCanvas, destX, destY, maskWidth, maskHeight, 0, 0, sampleWidth, sampleHeight);

              const originalSmoothing = ctx.imageSmoothingEnabled;
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(helperCanvas, 0, 0, sampleWidth, sampleHeight, destX, destY, maskWidth, maskHeight);
              ctx.imageSmoothingEnabled = originalSmoothing;
              return true;
            };

            switch (settings.watermarkStrategy) {
              case 'clone':
                if (!cloneRegion()) {
                  blurRegion();
                }
                break;
              case 'pixelate':
                if (!pixelateRegion()) {
                  blurRegion();
                }
                break;
              case 'blur':
              default:
                blurRegion();
                break;
            }
          };

          const drawFrame = () => {
          if (!sourceVideoRef.current || sourceVideoRef.current.paused || sourceVideoRef.current.ended || !canvasRef.current || !ctx) {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
                mediaRecorderRef.current.stop();
            }
            if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = 0;
            return;
          }

          ctx.save();
          if (settings.flipHorizontal) {
            ctx.translate(canvasRef.current.width, 0);
            ctx.scale(-1, 1);
          }
          ctx.filter = `brightness(${settings.brightness}%) contrast(${settings.contrast}%) saturate(${settings.saturation}%)`;
          ctx.drawImage(sourceVideoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
            ctx.restore(); 

            applyWatermarkMask();

            if (settings.enablePixelNoise && canvasRef.current) {
            const currentCanvas = canvasRef.current;
            const numNoisePixels = Math.floor((currentCanvas.width * currentCanvas.height) * 0.001); 
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
            rotationAngle2Ref.current = (rotationAngle2Ref.current % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) ;

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

          if (sourceVideoRef.current.duration > 0) {
             setProgress(Math.min(100, Math.round((sourceVideoRef.current.currentTime / sourceVideoRef.current.duration) * 100)));
          }
          animationFrameIdRef.current = requestAnimationFrame(drawFrame);
        };

        video.onplay = () => {
          if (audioContext.state === 'suspended') {
            audioContext.resume().catch(console.error);
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

        video.onerror = (e) => { 
            const errorMsg = (video.error?.message || 'Unknown video playback error');
            const err = `Error playing source video: ${errorMsg}`;
            console.error(err, e);
            setProcessingError(err);
            setIsProcessing(false);
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop();
            cleanup();
            reject(new Error(err));
        };

        mediaRecorder.start();
        video.play().catch(err => {
            const errorMsg = `Could not start video playback: ${err.message}`;
            console.error(errorMsg, err);
            setProcessingError(errorMsg);
            setIsProcessing(false);
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop();
            cleanup();
            reject(err);
        });
      };

      video.onerror = (e) => { 
        const errorMsg = (video.error?.message || 'Failed to load video file.');
        const err =`Error loading video: ${errorMsg}`;
        console.error(err, e);
        setProcessingError(err);
        setIsProcessing(false);
        cleanup();
        reject(new Error(err));
      };
      
      video.src = URL.createObjectURL(videoFile);
    }); 
  }, [cleanup]); 

  return { processVideo, isProcessing, processedVideoUrl: internalProcessedVideoUrl, processingError, progress, setProcessedVideoUrl };
}
