export type WatermarkRemovalStrategy = 'clone' | 'blur' | 'pixelate';

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
  removeWatermark: boolean; // Toggle watermark removal workflow
  watermarkStrategy: WatermarkRemovalStrategy; // Strategy to use for removal
  watermarkXPercent: number; // Left offset of watermark box (percent of width)
  watermarkYPercent: number; // Top offset of watermark box (percent of height)
  watermarkWidthPercent: number; // Width of mask as percent of video width
  watermarkHeightPercent: number; // Height of mask as percent of video height
}

// DEFAULT_VIDEO_SETTINGS is defined and exported from constants.ts
// and should be imported from there if needed.