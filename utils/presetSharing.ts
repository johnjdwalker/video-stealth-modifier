import { DEFAULT_VIDEO_SETTINGS, SETTINGS_RANGES } from '../constants';
import { VideoSettings } from '../types';

export const PRESET_SHARE_HASH_PREFIX = 'preset=';

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Validate an unknown value into a full VideoSettings object. Unknown keys are
 * dropped, numbers are clamped to SETTINGS_RANGES, and type mismatches fall
 * back to defaults. Never throws — returns null for non-objects.
 */
export function sanitizeSettings(input: unknown): VideoSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...DEFAULT_VIDEO_SETTINGS };

  (Object.keys(DEFAULT_VIDEO_SETTINGS) as Array<keyof VideoSettings>).forEach((key) => {
    if (!(key in source)) return;
    const value = source[key];
    const defaultValue = DEFAULT_VIDEO_SETTINGS[key];

    if (typeof value !== typeof defaultValue) {
      // The trim fields are `number | null`; allow null through.
      if (value === null && (key === 'trimStartSeconds' || key === 'trimEndSeconds')) {
        merged[key] = null;
      }
      return;
    }
    if (typeof value === 'number' && typeof defaultValue === 'number') {
      const range = (SETTINGS_RANGES as Record<string, { min: number; max: number } | undefined>)[key];
      merged[key] = range ? Math.max(range.min, Math.min(range.max, value)) : value;
    } else if (typeof value === 'boolean') {
      merged[key] = value;
    } else if (typeof value === 'string' && key === 'outputFormat') {
      // outputFormat is the only string field; restrict to known values.
      if (value === 'webm-vp8' || value === 'webm-vp9' || value === 'mp4-h264') {
        merged[key] = value;
      }
    }
  });

  return merged as unknown as VideoSettings;
}

/** Encode settings into a short URL-safe share code. */
export function encodePresetShare(settings: VideoSettings): string {
  return base64UrlEncode(JSON.stringify(settings));
}

/** Decode a share code back into validated settings. Returns null when invalid. */
export function decodePresetShare(code: string): VideoSettings | null {
  try {
    return sanitizeSettings(JSON.parse(base64UrlDecode(code)));
  } catch {
    return null;
  }
}

/** Build a full shareable URL carrying the settings in the location hash. */
export function buildPresetShareUrl(settings: VideoSettings): string {
  return `${window.location.origin}${window.location.pathname}#${PRESET_SHARE_HASH_PREFIX}${encodePresetShare(settings)}`;
}

/** Read shared settings from the location hash (e.g. after opening a share link). */
export function readPresetShareFromLocation(): VideoSettings | null {
  const hash = window.location.hash;
  const prefix = `#${PRESET_SHARE_HASH_PREFIX}`;
  if (!hash.startsWith(prefix)) return null;
  return decodePresetShare(hash.slice(prefix.length));
}

/** Remove the share payload from the URL without reloading the page. */
export function clearPresetShareFromLocation(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/** Serialize settings as a human-readable .json preset file. */
export function serializePresetFile(settings: VideoSettings): string {
  return JSON.stringify({ app: 'video-stealth-modifier', version: 1, settings }, null, 2);
}

/** Parse a .json preset file back into validated settings. Returns null when invalid. */
export function parsePresetFile(text: string): VideoSettings | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const { settings } = parsed as { settings?: unknown };
    return sanitizeSettings(settings);
  } catch {
    return null;
  }
}
