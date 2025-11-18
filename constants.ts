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