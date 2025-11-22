export interface VideoSettings {
  brightness: number; // Percentage, e.g., 100 is normal
  contrast: number;   // Percentage, e.g., 100 is normal
  saturation: number; // Percentage, e.g., 100 is normal
  playbackSpeed: number; // Multiplier, e.g., 1.0 is normal
  volume: number;       // Percentage, e.g., 100 is normal audio level
  flipHorizontal: boolean; // True to flip video horizontally
  enableRotatingLines: boolean; // True to add rotating lines effect
  enablePixelNoise: boolean; // True to add subtle pixel noise
  audioPreservesPitch: boolean; // True to preserve audio pitch when changing speed
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