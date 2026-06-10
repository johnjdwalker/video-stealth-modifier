export interface VideoSettings {
  // Color and tone
  brightness: number; // Percentage, e.g., 100 is normal. Range 0-200.
  contrast: number;   // Percentage, e.g., 100 is normal. Range 0-200.
  saturation: number; // Percentage, e.g., 100 is normal. Range 0-200.
  hueRotate: number;  // Degrees, 0 is normal. Range -180 to 180.

  // Stylistic filters
  blur: number;       // Pixels of gaussian blur, 0 is none. Range 0-10.
  sepia: number;      // Percentage of sepia tone, 0 is none. Range 0-100.
  grayscale: number;  // Percentage of grayscale, 0 is none. Range 0-100.
  vignette: number;   // Percentage of vignette intensity, 0 is none. Range 0-100.

  // Playback
  playbackSpeed: number; // Multiplier, e.g., 1.0 is normal. Range 0.5-2.0.

  // Audio
  volume: number;       // Percentage, e.g., 100 is normal audio level. Range 0-100.
  audioPreservesPitch: boolean; // True to preserve audio pitch when changing speed.
  audioFadeInSeconds: number;  // Seconds of audio fade-in at start. Range 0-10.
  audioFadeOutSeconds: number; // Seconds of audio fade-out at end. Range 0-10.

  // Geometry / overlays
  flipHorizontal: boolean; // True to flip video horizontally.
  enableRotatingLines: boolean; // True to add rotating lines effect.
  enablePixelNoise: boolean; // True to add subtle pixel noise.

  // Trimming (in seconds, relative to source video). Use null/undefined to mean "from start" / "to end".
  trimStartSeconds: number | null;
  trimEndSeconds: number | null;

  // Output
  outputFormat: 'webm-vp8' | 'webm-vp9' | 'mp4-h264';
  outputBitrateKbps: number; // Video bitrate in kbps. 0 = auto/browser default.
}

export interface CustomPreset {
  name: string;
  settings: VideoSettings;
  createdAt: number; // epoch ms
}

export interface WatermarkCoords {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WatermarkDetectionResult {
  detected: boolean;
  coords: WatermarkCoords | null;
  confidence: number; // 0-100
  message?: string;
}

export interface WatermarkRemovalState {
  isDetecting: boolean;
  isRemoving: boolean;
  detectionResult: WatermarkDetectionResult | null;
  progress: number; // 0-100
  error: string | null;
  processedVideoUrl: string | null;
}

// ----------------------------------------------------------------------------
// Sora 2 / animated watermark types
// ----------------------------------------------------------------------------

/**
 * One sample of the watermark's bounding box at a specific point in time.
 * Used to build a trajectory for moving watermarks (Sora's bouncing logo).
 */
export interface SoraWatermarkSample {
  time: number;        // seconds
  bbox: WatermarkCoords;
  confidence: number;  // 0-100
}

/**
 * Full result of running auto-detection against a video. The trajectory is the
 * sorted list of samples; downstream code interpolates between samples.
 */
export interface SoraWatermarkDetection {
  detected: boolean;
  videoWidth: number;
  videoHeight: number;
  videoDuration: number;
  /** Sorted ascending by `time`. */
  trajectory: SoraWatermarkSample[];
  /**
   * Padding (in pixels) to add around each detected box during removal so that
   * we cover the soft edges and any aliasing of the watermark.
   */
  padding: number;
  /** Average detection confidence across samples. 0-100. */
  averageConfidence: number;
  /** When detection finishes empty-handed, why. */
  message?: string;
}

export type SoraRemovalQuality = 'fast' | 'balanced' | 'high';

export interface SoraRemovalState {
  isDetecting: boolean;
  isRemoving: boolean;
  detection: SoraWatermarkDetection | null;
  progress: number;
  stageMessage: string;
  error: string | null;
  processedVideoUrl: string | null;
  processedMimeType: string | null;
}

// DEFAULT_VIDEO_SETTINGS is defined and exported from constants.ts
// and should be imported from there if needed.
