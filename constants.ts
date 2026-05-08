import { VideoSettings } from './types';

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hueRotate: 0,
  blur: 0,
  sepia: 0,
  grayscale: 0,
  vignette: 0,
  playbackSpeed: 1.0,
  volume: 100,
  audioPreservesPitch: true,
  audioFadeInSeconds: 0,
  audioFadeOutSeconds: 0,
  flipHorizontal: false,
  enableRotatingLines: false,
  enablePixelNoise: false,
  trimStartSeconds: null,
  trimEndSeconds: null,
  outputFormat: 'webm-vp8',
  outputBitrateKbps: 0,
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

// Validation ranges for VideoSettings numeric fields. Used to clamp AI responses
// and to validate imported presets.
export const SETTINGS_RANGES = {
  brightness: { min: 0, max: 200 },
  contrast: { min: 0, max: 200 },
  saturation: { min: 0, max: 200 },
  hueRotate: { min: -180, max: 180 },
  blur: { min: 0, max: 10 },
  sepia: { min: 0, max: 100 },
  grayscale: { min: 0, max: 100 },
  vignette: { min: 0, max: 100 },
  playbackSpeed: { min: 0.5, max: 2.0 },
  volume: { min: 0, max: 100 },
  audioFadeInSeconds: { min: 0, max: 10 },
  audioFadeOutSeconds: { min: 0, max: 10 },
  outputBitrateKbps: { min: 0, max: 50000 },
} as const;

// Settings presets for quick application
export const SETTINGS_PRESETS: Record<string, VideoSettings> = {
  default: DEFAULT_VIDEO_SETTINGS,
  subtle: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 105,
    contrast: 102,
    saturation: 98,
    enablePixelNoise: true,
  },
  vintage: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 90,
    contrast: 110,
    saturation: 75,
    sepia: 35,
    playbackSpeed: 0.95,
    volume: 95,
    enablePixelNoise: true,
    vignette: 25,
  },
  dramatic: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 115,
    contrast: 130,
    saturation: 120,
    playbackSpeed: 1.1,
    enableRotatingLines: true,
    vignette: 15,
  },
  cinematic: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 95,
    contrast: 115,
    saturation: 85,
    playbackSpeed: 0.9,
    vignette: 35,
  },
  energetic: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 110,
    contrast: 108,
    saturation: 115,
    playbackSpeed: 1.2,
    enableRotatingLines: true,
    enablePixelNoise: true,
    audioPreservesPitch: false,
  },
  noir: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 95,
    contrast: 130,
    grayscale: 100,
    vignette: 50,
    playbackSpeed: 0.95,
  },
  dreamy: {
    ...DEFAULT_VIDEO_SETTINGS,
    brightness: 110,
    saturation: 115,
    blur: 1.5,
    sepia: 10,
    audioFadeInSeconds: 1,
    audioFadeOutSeconds: 1.5,
  },
} as const;

export const PRESET_DESCRIPTIONS: Record<string, string> = {
  default: 'Original settings with no modifications',
  subtle: 'Barely noticeable changes with minimal pixel noise',
  vintage: 'Old film look: sepia, lower saturation, slight vignette',
  dramatic: 'High contrast and brightness with rotating lines',
  cinematic: 'Film-like quality with reduced saturation, slow pace, vignette',
  energetic: 'Vibrant colors, faster speed, and dynamic effects',
  noir: 'Black & white, high contrast, heavy vignette',
  dreamy: 'Soft blur, warm tone, gentle audio fades',
};

// Custom (user-defined) preset storage
export const CUSTOM_PRESETS_STORAGE_KEY = 'videoStealthModifierCustomPresets';
export const SETTINGS_STORAGE_KEY = 'videoStealthModifierSettings';

// MediaRecorder MIME types per output format. Listed in fallback order; the first
// supported entry will be used at processing time.
export const OUTPUT_FORMAT_MIME_TYPES: Record<VideoSettings['outputFormat'], string[]> = {
  'webm-vp8': ['video/webm;codecs=vp8,opus', 'video/webm'],
  'webm-vp9': ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'],
  'mp4-h264': ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=h264,aac', 'video/mp4'],
};

export const OUTPUT_FORMAT_LABELS: Record<VideoSettings['outputFormat'], string> = {
  'webm-vp8': 'WEBM (VP8 + Opus)',
  'webm-vp9': 'WEBM (VP9 + Opus)',
  'mp4-h264': 'MP4 (H.264 + AAC)',
};

export const OUTPUT_FORMAT_EXTENSIONS: Record<VideoSettings['outputFormat'], string> = {
  'webm-vp8': 'webm',
  'webm-vp9': 'webm',
  'mp4-h264': 'mp4',
};

// Watermark detection constants
export const WATERMARK_DETECTION_SAMPLE_COUNT = 5; // Minimum frames to sample
export const WATERMARK_DETECTION_SAMPLE_INTERVAL_SECONDS = 2; // Sample every 2 seconds
export const WATERMARK_CORNER_REGION_PERCENTAGE = 0.15; // Check 15% of width/height in corners
export const WATERMARK_VARIANCE_THRESHOLD = 500; // Lower variance suggests watermark
export const WATERMARK_VARIANCE_STD_THRESHOLD = 200; // Standard deviation threshold
export const WATERMARK_INPAINT_RADIUS = 8; // Pixels to sample for inpainting
export const WATERMARK_INPAINT_PADDING = 5; // Padding around watermark region
