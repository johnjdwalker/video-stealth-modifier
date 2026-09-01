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
// Sora 2 watermark types
// ----------------------------------------------------------------------------

/**
 * One sample of the watermark's bounding box at a specific point in time.
 * Samples belong to a dwell; they capture the small drift within it.
 */
export interface SoraWatermarkSample {
  time: number;        // seconds
  bbox: WatermarkCoords;
  confidence: number;  // 0-100
}

/**
 * A stretch of time during which the watermark holds one position.
 *
 * Sora's watermark does not travel continuously — it sits in one place, fades,
 * and reappears somewhere else. Modelling that as dwells rather than a single
 * interpolated path matters: interpolating between the last sample of one
 * dwell and the first of the next drags the patched region straight across the
 * middle of the frame during the hop.
 */
export interface SoraDwell {
  startTime: number;
  endTime: number;
  /** Stabilised box for the dwell, in source video pixels, before padding. */
  bbox: WatermarkCoords;
  /** Per-sample boxes inside this dwell, ascending by time. */
  samples: SoraWatermarkSample[];
  confidence: number; // 0-100
  /** Whether this dwell came from auto-detection or a manual correction. */
  source: 'auto' | 'manual';
}

/**
 * A user correction: "the watermark is *here* at this moment". Overrides the
 * dwell containing `time`, or creates a manual dwell if it falls in a gap.
 */
export interface SoraCorrection {
  id: string;
  time: number;
  bbox: WatermarkCoords;
}

export interface SoraWatermarkDetection {
  detected: boolean;
  videoWidth: number;
  videoHeight: number;
  videoDuration: number;
  /** Sorted ascending by `startTime`, non-overlapping. */
  dwells: SoraDwell[];
  /**
   * Padding (in pixels) added around each box during removal so we cover the
   * soft edges and antialiasing of the watermark.
   */
  padding: number;
  /** Median watermark size across the clip; seeds manual corrections. */
  logoSize: { width: number; height: number } | null;
  averageConfidence: number;
  /** How much of the clip is covered by dwells, 0-1. */
  coverage: number;
  /** Number of frames sampled during detection. */
  samplesAnalyzed: number;
  message?: string;
}

export type SoraRemovalQuality = 'fast' | 'balanced' | 'high';

/**
 * How the covered region is reconstructed.
 * - `temporal`: borrow real pixels from a moment when the watermark was elsewhere.
 * - `inpaint`:  interpolate inward from the clean pixels bordering the region.
 * - `auto`:     temporal when a clean donor exists, inpaint otherwise.
 */
export type SoraFillMode = 'auto' | 'temporal' | 'inpaint';

export interface SoraRemovalState {
  isDetecting: boolean;
  isRemoving: boolean;
  detection: SoraWatermarkDetection | null;
  corrections: SoraCorrection[];
  progress: number;
  stageMessage: string;
  error: string | null;
  processedVideoUrl: string | null;
  processedMimeType: string | null;
}
