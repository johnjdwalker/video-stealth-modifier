import { VideoSettings, WatermarkPresetKey } from './types';

export const WATERMARK_PRESETS: Record<Exclude<WatermarkPresetKey, 'custom'>, {
  label: string;
  description: string;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}> = {
  sora2: {
    label: 'Sora 2 Default',
    description: 'Matches the stock watermark Sora 2 burns into the top-right corner of 1024px renders.',
    xPercent: 79,
    yPercent: 6,
    widthPercent: 17,
    heightPercent: 13,
  },
};

export const getPresetMask = (preset: WatermarkPresetKey) => {
  if (preset === 'custom') {
    return null;
  }
  return WATERMARK_PRESETS[preset];
};

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
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  watermarkRemovalEnabled: true,
  watermarkPreset: 'sora2',
  watermarkX: WATERMARK_PRESETS.sora2.xPercent,
  watermarkY: WATERMARK_PRESETS.sora2.yPercent,
  watermarkWidth: WATERMARK_PRESETS.sora2.widthPercent,
  watermarkHeight: WATERMARK_PRESETS.sora2.heightPercent,
  watermarkFeather: 18,
  watermarkBlurAmount: 26,
};

export const APP_TITLE = "Video Stealth Modifier";