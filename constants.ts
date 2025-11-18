import { VideoSettings } from './types';

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  playbackSpeed: 1.0,
  volume: 100,
  flipHorizontal: false,
  enableRotatingLines: false,
  enablePixelNoise: false,
  audioPreservesPitch: true,
  removeWatermark: false,
  watermarkStrategy: 'clone',
  watermarkXPercent: 4, // Sora2 places the wordmark near the bottom-left corner
  watermarkYPercent: 82,
  watermarkWidthPercent: 22,
  watermarkHeightPercent: 10,
};

export const APP_TITLE = "Video Stealth Modifier";