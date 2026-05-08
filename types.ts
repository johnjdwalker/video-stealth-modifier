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

// DEFAULT_VIDEO_SETTINGS is defined and exported from constants.ts
// and should be imported from there if needed.
