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
  
  // Watermark removal features
  cropTop: number;      // Percentage to crop from top (0-50)
  cropBottom: number;   // Percentage to crop from bottom (0-50)
  cropLeft: number;     // Percentage to crop from left (0-50)
  cropRight: number;    // Percentage to crop from right (0-50)
  zoomScale: number;    // Scale factor for zoom (1.0-2.0)
  blurTopLeft: number;  // Blur intensity for top-left corner (0-20)
  blurTopRight: number; // Blur intensity for top-right corner (0-20)
  blurBottomLeft: number; // Blur intensity for bottom-left corner (0-20)
  blurBottomRight: number; // Blur intensity for bottom-right corner (0-20)
  cornerBlurSize: number; // Size of corner blur area as percentage (5-30)
}

// DEFAULT_VIDEO_SETTINGS is defined and exported from constants.ts
// and should be imported from there if needed.