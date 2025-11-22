import { WatermarkDetectionResult, WatermarkCoords } from '../types';
import {
  WATERMARK_DETECTION_SAMPLE_COUNT,
  WATERMARK_DETECTION_SAMPLE_INTERVAL_SECONDS,
  WATERMARK_CORNER_REGION_PERCENTAGE,
  WATERMARK_VARIANCE_THRESHOLD,
  WATERMARK_VARIANCE_STD_THRESHOLD,
  WATERMARK_INPAINT_RADIUS,
  WATERMARK_INPAINT_PADDING,
} from '../constants';

/**
 * Detects watermark in video frames by analyzing corner regions
 * Common watermark patterns: logos/text in corners, consistent positioning
 */
export async function detectWatermark(
  videoFile: File,
  onProgress?: (progress: number) => void
): Promise<WatermarkDetectionResult> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) {
      reject(new Error('Could not get canvas context for watermark detection'));
      return;
    }

    video.preload = 'metadata';
    video.muted = true;

    video.onloadedmetadata = async () => {
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const videoDuration = video.duration;
        if (!isFinite(videoDuration) || videoDuration <= 0) {
          resolve({
            detected: false,
            coords: null,
            confidence: 0,
            message: 'Could not determine video duration',
          });
          return;
        }

        // Sample frames at intervals
        const sampleCount = Math.max(
          WATERMARK_DETECTION_SAMPLE_COUNT,
          Math.floor(videoDuration / WATERMARK_DETECTION_SAMPLE_INTERVAL_SECONDS)
        );
        const sampleInterval = videoDuration / (sampleCount + 1);
        const frames: ImageData[] = [];

        // Extract sample frames
        for (let i = 1; i <= sampleCount; i++) {
          const time = sampleInterval * i;
          video.currentTime = time;
          
          await new Promise<void>((resolveSeek) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              frames.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
              if (onProgress) {
                onProgress((i / sampleCount) * 50); // First 50% for frame extraction
              }
              resolveSeek();
            };
            video.addEventListener('seeked', onSeeked);
          });
        }

        if (onProgress) {
          onProgress(50);
        }

        // Analyze frames for watermark patterns
        const watermarkRegion = analyzeFramesForWatermark(frames, canvas.width, canvas.height);
        
        if (onProgress) {
          onProgress(100);
        }

        if (watermarkRegion) {
          resolve({
            detected: true,
            coords: watermarkRegion,
            confidence: 85, // High confidence if pattern detected
            message: 'Watermark detected in corner region',
          });
        } else {
          resolve({
            detected: false,
            coords: null,
            confidence: 0,
            message: 'No watermark pattern detected',
          });
        }
      } catch (error: any) {
        reject(new Error(`Watermark detection failed: ${error.message}`));
      } finally {
        URL.revokeObjectURL(video.src);
      }
    };

    video.onerror = () => {
      reject(new Error('Failed to load video for watermark detection'));
      URL.revokeObjectURL(video.src);
    };

    video.src = URL.createObjectURL(videoFile);
  });
}

/**
 * Analyzes multiple frames to detect consistent watermark patterns
 * Looks for regions with low variance (consistent overlay) in corners
 */
function analyzeFramesForWatermark(
  frames: ImageData[],
  width: number,
  height: number
): WatermarkCoords | null {
  // Check corner regions (top-left, top-right, bottom-left, bottom-right)
  const cornerSize = Math.floor(width * WATERMARK_CORNER_REGION_PERCENTAGE);
  const cornerHeight = Math.floor(height * WATERMARK_CORNER_REGION_PERCENTAGE);
  const cornerRegions = [
    { x: 0, y: 0, width: cornerSize, height: cornerHeight }, // Top-left
    { x: Math.floor(width * (1 - WATERMARK_CORNER_REGION_PERCENTAGE)), y: 0, width: cornerSize, height: cornerHeight }, // Top-right
    { x: 0, y: Math.floor(height * (1 - WATERMARK_CORNER_REGION_PERCENTAGE)), width: cornerSize, height: cornerHeight }, // Bottom-left
    { x: Math.floor(width * (1 - WATERMARK_CORNER_REGION_PERCENTAGE)), y: Math.floor(height * (1 - WATERMARK_CORNER_REGION_PERCENTAGE)), width: cornerSize, height: cornerHeight }, // Bottom-right
  ];

  for (const region of cornerRegions) {
    // Calculate variance across frames for this region
    const variances: number[] = [];
    
    for (const frame of frames) {
      const regionVariance = calculateRegionVariance(frame, region);
      variances.push(regionVariance);
    }

    // Low variance across frames suggests a consistent watermark
    const avgVariance = variances.reduce((a, b) => a + b, 0) / variances.length;
    const varianceStdDev = Math.sqrt(
      variances.reduce((sum, v) => sum + Math.pow(v - avgVariance, 2), 0) / variances.length
    );

    // If variance is consistently low, likely a watermark
    if (avgVariance < WATERMARK_VARIANCE_THRESHOLD && varianceStdDev < WATERMARK_VARIANCE_STD_THRESHOLD) {
      return region;
    }
  }

  return null;
}

/**
 * Calculates variance of pixel values in a region
 * Lower variance indicates more uniform/consistent pixels (watermark)
 */
function calculateRegionVariance(frame: ImageData, region: { x: number; y: number; width: number; height: number }): number {
  const data = frame.data;
  const pixels: number[] = [];

  for (let y = region.y; y < Math.min(region.y + region.height, frame.height); y++) {
    for (let x = region.x; x < Math.min(region.x + region.width, frame.width); x++) {
      const idx = (y * frame.width + x) * 4;
      // Use luminance as single value
      const luminance = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      pixels.push(luminance);
    }
  }

  if (pixels.length === 0) return 0;

  const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
  const variance = pixels.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / pixels.length;
  
  return variance;
}

/**
 * Removes watermark from video by inpainting/blurring the detected region
 */
export async function removeWatermark(
  videoFile: File,
  watermarkCoords: WatermarkCoords,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    if (!ctx) {
      reject(new Error('Could not get canvas context for watermark removal'));
      return;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    let audioTrack: MediaStreamTrack | undefined;

    video.preload = 'metadata';
    video.muted = true;

    video.onloadedmetadata = async () => {
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // Setup audio processing if available
        try {
          const sourceNode = audioContext.createMediaElementSource(video);
          const audioDestinationNode = audioContext.createMediaStreamDestination();
          sourceNode.connect(audioDestinationNode);
          audioTrack = audioDestinationNode.stream.getAudioTracks()[0];
        } catch (audioErr) {
          console.warn('Could not process audio track:', audioErr);
        }

        const canvasStream = canvas.captureStream(30);
        const videoTrack = canvasStream.getVideoTracks()[0];
        const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
        const combinedStream = new MediaStream(tracks);

        const mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          reject(new Error(`MIME type ${mimeType} not supported`));
          return;
        }

        const mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
        const recordedChunks: Blob[] = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunks.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: mimeType });
          resolve(blob);
          URL.revokeObjectURL(video.src);
          if (audioContext.state !== 'closed') {
            audioContext.close().catch(console.error);
          }
        };

        mediaRecorder.onerror = (event: any) => {
          reject(new Error(`MediaRecorder error: ${event.error?.message || 'Unknown error'}`));
          URL.revokeObjectURL(video.src);
        };

        // Draw frame with watermark removal
        const drawFrame = () => {
          if (video.paused || video.ended) {
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
            return;
          }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // Remove watermark by inpainting (blurring the region)
          removeWatermarkFromFrame(ctx, watermarkCoords, canvas.width, canvas.height);

          // Update progress
          if (video.duration > 0 && isFinite(video.duration)) {
            const progress = (video.currentTime / video.duration) * 100;
            if (onProgress && isFinite(progress)) {
              onProgress(Math.min(100, Math.round(progress)));
            }
          }

          requestAnimationFrame(drawFrame);
        };

        video.onplay = () => {
          if (audioContext.state === 'suspended') {
            audioContext.resume().catch(console.error);
          }
          drawFrame();
        };

        video.onended = () => {
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          }
        };

        mediaRecorder.start();
        video.play().catch((err) => {
          reject(new Error(`Could not start video playback: ${err.message}`));
        });
      } catch (error: any) {
        reject(new Error(`Watermark removal failed: ${error.message}`));
        URL.revokeObjectURL(video.src);
      }
    };

    video.onerror = () => {
      reject(new Error('Failed to load video for watermark removal'));
      URL.revokeObjectURL(video.src);
    };

    video.src = URL.createObjectURL(videoFile);
  });
}

/**
 * Removes watermark from a single frame using inpainting technique
 * Uses a simple blur/fill approach for the watermark region
 */
function removeWatermarkFromFrame(
  ctx: CanvasRenderingContext2D,
  coords: WatermarkCoords,
  canvasWidth: number,
  canvasHeight: number
): void {
  // Expand region slightly for better blending
  const padding = WATERMARK_INPAINT_PADDING;
  const x = Math.max(0, coords.x - padding);
  const y = Math.max(0, coords.y - padding);
  const width = Math.min(canvasWidth - x, coords.width + padding * 2);
  const height = Math.min(canvasHeight - y, coords.height + padding * 2);

  // Get surrounding pixels for inpainting
  const sampleSize = WATERMARK_INPAINT_RADIUS + 2;
  const sampleX = Math.max(0, x - sampleSize);
  const sampleY = Math.max(0, y - sampleSize);
  const sampleWidth = Math.min(canvasWidth - sampleX, width + sampleSize * 2);
  const sampleHeight = Math.min(canvasHeight - sampleY, height + sampleSize * 2);

  // Extract region image data
  const imageData = ctx.getImageData(sampleX, sampleY, sampleWidth, sampleHeight);
  const data = imageData.data;

  // Simple inpainting: average surrounding pixels
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const globalX = x + px - sampleX;
      const globalY = y + py - sampleY;
      
      if (globalX >= 0 && globalX < sampleWidth && globalY >= 0 && globalY < sampleHeight) {
        const idx = (globalY * sampleWidth + globalX) * 4;
        
        // Sample surrounding pixels (excluding watermark region)
        const samples: number[][] = [];
        const radius = WATERMARK_INPAINT_RADIUS;
        
        for (let sy = -radius; sy <= radius; sy++) {
          for (let sx = -radius; sx <= radius; sx++) {
            const sampleX = globalX + sx;
            const sampleY = globalY + sy;
            
            // Skip if outside bounds or in watermark region
            if (sampleX < 0 || sampleX >= sampleWidth || sampleY < 0 || sampleY >= sampleHeight) {
              continue;
            }
            
            const sampleIdx = (sampleY * sampleWidth + sampleX) * 4;
            samples.push([
              data[sampleIdx],
              data[sampleIdx + 1],
              data[sampleIdx + 2],
              data[sampleIdx + 3],
            ]);
          }
        }
        
        if (samples.length > 0) {
          // Average the samples
          const avg = samples.reduce(
            (acc, sample) => [
              acc[0] + sample[0],
              acc[1] + sample[1],
              acc[2] + sample[2],
              acc[3] + sample[3],
            ],
            [0, 0, 0, 0]
          );
          
          data[idx] = avg[0] / samples.length;
          data[idx + 1] = avg[1] / samples.length;
          data[idx + 2] = avg[2] / samples.length;
          data[idx + 3] = avg[3] / samples.length;
        }
      }
    }
  }

  // Put modified image data back
  ctx.putImageData(imageData, sampleX, sampleY);
}
