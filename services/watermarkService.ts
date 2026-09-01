import { WatermarkDetectionResult, WatermarkCoords } from '../types';
import {
  WATERMARK_DETECTION_SAMPLE_COUNT,
  WATERMARK_DETECTION_SAMPLE_INTERVAL_SECONDS,
  WATERMARK_CORNER_REGION_PERCENTAGE,
  WATERMARK_VARIANCE_THRESHOLD,
  WATERMARK_VARIANCE_STD_THRESHOLD,
  WATERMARK_INPAINT_PADDING,
} from '../constants';

/**
 * Detects watermark in video frames by analyzing corner regions
 * Common watermark patterns: logos/text in corners, consistent positioning
 */
export async function detectWatermark(
  videoFile: File,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
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

        // Extract sample frames.
        for (let i = 1; i <= sampleCount; i++) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const time = sampleInterval * i;

          // The 'seeked' listener must be attached *before* assigning
          // currentTime. Assigning first races the event: when the seek
          // completes before the listener is attached the promise never
          // settles and detection hangs on the spinner forever.
          await new Promise<void>((resolveSeek, rejectSeek) => {
            const done = () => {
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('error', onSeekError);
            };
            const onSeeked = () => {
              done();
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              frames.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
              if (onProgress) {
                onProgress((i / sampleCount) * 50); // First 50% for frame extraction
              }
              resolveSeek();
            };
            const onSeekError = () => {
              done();
              rejectSeek(new Error('Seek failed while sampling frames.'));
            };
            video.addEventListener('seeked', onSeeked);
            video.addEventListener('error', onSeekError);
            try {
              video.currentTime = time;
            } catch (err) {
              done();
              rejectSeek(err as Error);
            }
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
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    if (!ctx) {
      reject(new Error('Could not get canvas context for watermark removal'));
      return;
    }

    let rafId = 0;

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
          if (rafId) cancelAnimationFrame(rafId);
          const srcUrl = video.src;
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(srcUrl);
          if (audioContext.state !== 'closed') {
            audioContext.close().catch(console.error);
          }
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          resolve(new Blob(recordedChunks, { type: mimeType }));
        };

        mediaRecorder.onerror = (event: any) => {
          reject(new Error(`MediaRecorder error: ${event.error?.message || 'Unknown error'}`));
          URL.revokeObjectURL(video.src);
        };

        // Draw frame with watermark removal
        const drawFrame = () => {
          if (signal?.aborted) {
            // Stop decoding/encoding immediately. Without this the render loop
            // kept running (and the tab kept burning CPU) after the user
            // cancelled — the UI just stopped listening to it.
            video.pause();
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
            return;
          }
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

          rafId = requestAnimationFrame(drawFrame);
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
 * Removes the watermark from a single frame.
 *
 * Every pixel inside the region is reconstructed by inverse-distance
 * interpolation between the four *clean* border pixels that bracket it
 * (the row/column immediately outside the region). This replaces an earlier
 * neighbourhood-average implementation that had two defects:
 *
 *   - it allocated one array per sampled neighbour, i.e. millions of short
 *     lived arrays per frame (a 15% corner of a 1080p frame sampled a 17x17
 *     neighbourhood for each of ~46,000 pixels), which stalled the tab; and
 *   - it averaged in pixels from inside the watermark itself — and wrote its
 *     own output back into the buffer it was reading — so the watermark was
 *     smeared across the region rather than removed.
 *
 * The interpolation is O(region pixels), allocates nothing per pixel, and
 * matches the surrounding content exactly at the region border.
 */
function removeWatermarkFromFrame(
  ctx: CanvasRenderingContext2D,
  coords: WatermarkCoords,
  canvasWidth: number,
  canvasHeight: number
): void {
  // Expand region slightly so soft/antialiased watermark edges are covered.
  const padding = WATERMARK_INPAINT_PADDING;
  const x = Math.max(0, Math.round(coords.x) - padding);
  const y = Math.max(0, Math.round(coords.y) - padding);
  const width = Math.min(canvasWidth - x, Math.round(coords.width) + padding * 2);
  const height = Math.min(canvasHeight - y, Math.round(coords.height) + padding * 2);
  if (width <= 0 || height <= 0) return;

  // Read the region plus a one pixel border of clean donor pixels.
  const readX = Math.max(0, x - 1);
  const readY = Math.max(0, y - 1);
  const readW = Math.min(canvasWidth - readX, width + (x - readX) + 1);
  const readH = Math.min(canvasHeight - readY, height + (y - readY) + 1);
  if (readW <= 0 || readH <= 0) return;

  const imageData = ctx.getImageData(readX, readY, readW, readH);
  const data = imageData.data;

  // Region position within the buffer we just read.
  const fx = x - readX;
  const fy = y - readY;

  // Border rows/columns. A border is unavailable when the region runs to the
  // edge of the frame; interpolation then uses whichever borders remain.
  const leftX = fx - 1;
  const rightX = fx + width;
  const topY = fy - 1;
  const botY = fy + height;
  const hasLeft = leftX >= 0;
  const hasRight = rightX < readW;
  const hasTop = topY >= 0;
  const hasBottom = botY < readH;

  // Nothing clean to sample from (region covers the whole frame).
  if (!hasLeft && !hasRight && !hasTop && !hasBottom) return;

  const at = (px: number, py: number) => (py * readW + px) * 4;

  for (let j = 0; j < height; j++) {
    const py = fy + j;
    const rowLeft = hasLeft ? at(leftX, py) : -1;
    const rowRight = hasRight ? at(rightX, py) : -1;
    const dTop = j + 1;
    const dBottom = height - j;

    for (let i = 0; i < width; i++) {
      const px = fx + i;
      const dLeft = i + 1;
      const dRight = width - i;

      let weight = 0;
      let r = 0, g = 0, b = 0;

      if (rowLeft >= 0) {
        const w = 1 / dLeft;
        weight += w;
        r += data[rowLeft] * w; g += data[rowLeft + 1] * w; b += data[rowLeft + 2] * w;
      }
      if (rowRight >= 0) {
        const w = 1 / dRight;
        weight += w;
        r += data[rowRight] * w; g += data[rowRight + 1] * w; b += data[rowRight + 2] * w;
      }
      if (hasTop) {
        const idx = at(px, topY);
        const w = 1 / dTop;
        weight += w;
        r += data[idx] * w; g += data[idx + 1] * w; b += data[idx + 2] * w;
      }
      if (hasBottom) {
        const idx = at(px, botY);
        const w = 1 / dBottom;
        weight += w;
        r += data[idx] * w; g += data[idx + 1] * w; b += data[idx + 2] * w;
      }

      if (weight === 0) continue;
      const target = at(px, py);
      data[target] = r / weight;
      data[target + 1] = g / weight;
      data[target + 2] = b / weight;
      data[target + 3] = 255;
    }
  }

  ctx.putImageData(imageData, readX, readY);
}
