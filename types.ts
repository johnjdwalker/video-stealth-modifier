export type WatermarkPresetKey = 'sora2' | 'custom';

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
  cropTop: number; // Percentage of height cropped from top (0-40)
  cropBottom: number; // Percentage of height cropped from bottom
  cropLeft: number; // Percentage of width cropped from left
  cropRight: number; // Percentage of width cropped from right
  watermarkRemovalEnabled: boolean;
  watermarkPreset: WatermarkPresetKey;
  watermarkX: number; // Percentage-based X offset for mask
  watermarkY: number; // Percentage-based Y offset for mask
  watermarkWidth: number; // Percentage width of mask
  watermarkHeight: number; // Percentage height of mask
  watermarkFeather: number; // Feather/softness in px
  watermarkBlurAmount: number; // Blur amount in px
}

// DEFAULT_VIDEO_SETTINGS is defined and exported from constants.ts
// and should be imported from there if needed.