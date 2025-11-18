
import { useState, useCallback, useRef, useEffect } from 'react';
import { VideoSettings } from '../types';

// Constants for rotating lines effect configuration
const FPS = 30; // Should match canvas.captureStream frame rate
const ROTATION_DURATION_SECONDS = 30; // Duration for one full 360-degree rotation

export function useVideoProcessor() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [internalProcessedVideoUrl, setInternalProcessedVideoUrl] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

          if (settings.removeWatermark && canvasRef.current && ctx) {
            const currentCanvas = canvasRef.current;
            const width = currentCanvas.width;
            const height = currentCanvas.height;
            
            // Define watermark regions (typically bottom corners and bottom center)
            // Bottom 15% of video height
            const watermarkHeight = Math.floor(height * 0.15);
            const watermarkStartY = height - watermarkHeight;
            
            // Corner regions: 20% of width from each side
            const cornerWidth = Math.floor(width * 0.20);
            
            // Center region: middle 30% of width
            const centerStartX = Math.floor(width * 0.35);
            const centerEndX = Math.floor(width * 0.65);
            
            // Get image data for watermark removal
            const imageData = ctx.getImageData(0, 0, width, height);
            const data = imageData.data;
            
            // Helper function to get pixel color at coordinates (with bounds checking)
            const getPixel = (x: number, y: number): [number, number, number, number] => {
              const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
              const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
              const idx = (py * width + px) * 4;
              return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
            };
            
            // Helper function to set pixel color
            const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
              const px = Math.max(0, Math.min(width - 1, Math.floor(x)));
              const py = Math.max(0, Math.min(height - 1, Math.floor(y)));
              const idx = (py * width + px) * 4;
              data[idx] = r;
              data[idx + 1] = g;
              data[idx + 2] = b;
              data[idx + 3] = a;
            };
            
            // Improved inpainting function: fill watermark region using nearby pixels
            const inpaintRegion = (startX: number, endX: number, startY: number, endY: number) => {
              const sampleRadius = Math.max(10, Math.floor(Math.min(width, height) * 0.05)); // Adaptive radius
              
              for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                  const samples: number[][] = [];
                  const sampleCount = 30; // Increased sample count for better quality
                  
                  // Calculate distance from watermark edge for better blending
                  const distFromTop = y - startY;
                  const blendFactor = Math.min(1, distFromTop / 5); // Gradual blending
                  
                  for (let i = 0; i < sampleCount; i++) {
                    // Primary: Sample from above the watermark region
                    const offsetY = 1 + Math.floor(Math.random() * sampleRadius);
                    const offsetX = Math.floor((Math.random() - 0.5) * sampleRadius * 2);
                    const sampleY = startY - offsetY;
                    const sampleX = x + offsetX;
                    
                    if (sampleY >= 0 && sampleX >= 0 && sampleX < width) {
                      samples.push(getPixel(sampleX, sampleY));
                    }
                    
                    // Secondary: Sample from sides (especially for corners)
                    if (x < cornerWidth || x >= width - cornerWidth) {
                      const sideOffset = 1 + Math.floor(Math.random() * sampleRadius);
                      const sideX = x < cornerWidth 
                        ? cornerWidth + sideOffset
                        : width - cornerWidth - sideOffset;
                      const sideY = y + Math.floor((Math.random() - 0.5) * sampleRadius);
                      
                      if (sideX >= 0 && sideX < width && sideY >= 0 && sideY < height) {
                        samples.push(getPixel(sideX, sideY));
                      }
                    }
                    
                    // Tertiary: Sample from diagonal directions for smoother transitions
                    const angle = Math.random() * Math.PI * 2;
                    const diagDist = 1 + Math.random() * sampleRadius;
                    const diagX = x + Math.cos(angle) * diagDist;
                    const diagY = startY - Math.abs(Math.sin(angle)) * diagDist;
                    
                    if (diagY >= 0 && diagX >= 0 && diagX < width) {
                      samples.push(getPixel(diagX, diagY));
                    }
                  }
                  
                  if (samples.length > 0) {
                    // Weighted average: prefer samples closer to the pixel
                    let totalWeight = 0;
                    let r = 0, g = 0, b = 0, a = 0;
                    
                    for (const sample of samples) {
                      // Simple weighting (could be improved with distance calculation)
                      const weight = 1;
                      totalWeight += weight;
                      r += sample[0] * weight;
                      g += sample[1] * weight;
                      b += sample[2] * weight;
                      a += sample[3] * weight;
                    }
                    
                    r = Math.round(r / totalWeight);
                    g = Math.round(g / totalWeight);
                    b = Math.round(b / totalWeight);
                    a = Math.round(a / totalWeight);
                    
                    // Blend with original pixel for smoother transition at edges
                    if (blendFactor < 1) {
                      const [origR, origG, origB, origA] = getPixel(x, y);
                      r = Math.round(r * blendFactor + origR * (1 - blendFactor));
                      g = Math.round(g * blendFactor + origG * (1 - blendFactor));
                      b = Math.round(b * blendFactor + origB * (1 - blendFactor));
                      a = Math.round(a * blendFactor + origA * (1 - blendFactor));
                    }
                    
                    setPixel(x, y, r, g, b, a);
                  }
                }
              }
            };
            
            // Remove watermarks from bottom-left corner
            inpaintRegion(0, cornerWidth, watermarkStartY, height);
            
            // Remove watermarks from bottom-right corner
            inpaintRegion(width - cornerWidth, width, watermarkStartY, height);
            
            // Remove watermarks from bottom-center
            inpaintRegion(centerStartX, centerEndX, watermarkStartY, height);
            
            // Put the modified image data back
            ctx.putImageData(imageData, 0, 0);
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
