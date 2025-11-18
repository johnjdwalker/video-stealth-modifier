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
};

export const APP_TITLE = "Video Stealth Modifier";

// File validation constants
export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
export const MAX_FILE_SIZE_MB = 500;

// Allowed video MIME types
export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime', // .mov
  'video/x-msvideo', // .avi
  'video/x-matroska', // .mkv
] as const;

// Settings presets for quick application
export const SETTINGS_PRESETS: Record<string, VideoSettings> = {
  default: DEFAULT_VIDEO_SETTINGS,
  subtle: {
    brightness: 105,
    contrast: 102,
    saturation: 98,
    playbackSpeed: 1.0,
    volume: 100,
    flipHorizontal: false,
    enableRotatingLines: false,
    enablePixelNoise: true,
    audioPreservesPitch: true,
  },
  vintage: {
    brightness: 90,
    contrast: 110,
    saturation: 75,
    playbackSpeed: 0.95,
    volume: 95,
    flipHorizontal: false,
    enableRotatingLines: false,
    enablePixelNoise: true,
    audioPreservesPitch: true,
  },
  dramatic: {
    brightness: 115,
    contrast: 130,
    saturation: 120,
    playbackSpeed: 1.1,
    volume: 100,
    flipHorizontal: false,
    enableRotatingLines: true,
    enablePixelNoise: false,
    audioPreservesPitch: true,
  },
  cinematic: {
    brightness: 95,
    contrast: 115,
    saturation: 85,
    playbackSpeed: 0.9,
    volume: 100,
    flipHorizontal: false,
    enableRotatingLines: false,
    enablePixelNoise: false,
    audioPreservesPitch: true,
  },
  energetic: {
    brightness: 110,
    contrast: 108,
    saturation: 115,
    playbackSpeed: 1.2,
    volume: 100,
    flipHorizontal: false,
    enableRotatingLines: true,
    enablePixelNoise: true,
    audioPreservesPitch: false,
  },
} as const;

export const PRESET_DESCRIPTIONS: Record<string, string> = {
  default: 'Original settings with no modifications',
  subtle: 'Barely noticeable changes with minimal pixel noise',
  vintage: 'Old film look with reduced saturation and slight slowdown',
  dramatic: 'High contrast and brightness with rotating lines',
  cinematic: 'Film-like quality with reduced saturation and slower pace',
  energetic: 'Vibrant colors, faster speed, and dynamic effects',
};