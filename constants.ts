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
  
  // Watermark removal defaults
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  zoomScale: 1.0,
  blurTopLeft: 0,
  blurTopRight: 0,
  blurBottomLeft: 0,
  blurBottomRight: 0,
  cornerBlurSize: 15,
};

export const APP_TITLE = "Sora2 Watermark Remover";