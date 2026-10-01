import { TimelineClip } from '../types';
import { ALLOWED_VIDEO_TYPES, MAX_FILE_SIZE, MAX_FILE_SIZE_MB } from '../constants';

/** Minimum effective clip length in seconds (trim/split guard). */
export const MIN_CLIP_SECONDS = 0.1;

/** Effective (post-trim) duration of one clip in seconds. */
export function clipEffectiveDuration(clip: TimelineClip): number {
  const start = Math.max(0, clip.trimStart ?? 0);
  const end = Math.min(clip.duration, clip.trimEnd ?? clip.duration);
  return Math.max(MIN_CLIP_SECONDS, end - start);
}

/** Timeline offset (seconds) at which clip `index` starts. */
export function clipTimelineOffset(clips: TimelineClip[], index: number): number {
  let t = 0;
  for (let i = 0; i < index && i < clips.length; i++) {
    t += clipEffectiveDuration(clips[i]);
  }
  return t;
}

/** Offsets for every clip (offsets[i] = start time of clips[i]). */
export function clipTimelineOffsets(clips: TimelineClip[]): number[] {
  const offsets: number[] = [];
  let t = 0;
  for (const clip of clips) {
    offsets.push(t);
    t += clipEffectiveDuration(clip);
  }
  return offsets;
}

/** Total timeline duration in seconds. */
export function timelineTotalDuration(clips: TimelineClip[]): number {
  return clips.reduce((acc, c) => acc + clipEffectiveDuration(c), 0);
}

export interface ClipAtTime {
  clip: TimelineClip;
  index: number;
  /** Timeline offset where this clip starts. */
  offset: number;
  /** Position inside the clip's effective (post-trim) span, in seconds. */
  localTime: number;
  /** Source-media time corresponding to localTime. */
  mediaTime: number;
}

/**
 * Locate the clip playing at timeline time `t`. The time is clamped into
 * [0, total), so the very end of the timeline still resolves to the last clip.
 */
export function findClipAtTime(clips: TimelineClip[], t: number): ClipAtTime | null {
  if (clips.length === 0) return null;
  const total = timelineTotalDuration(clips);
  if (total <= 0) return null;
  const clamped = Math.max(0, Math.min(total - 1e-4, t));
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipEffectiveDuration(clips[i]);
    if (clamped < offset + d || i === clips.length - 1) {
      const localTime = Math.max(0, Math.min(d, clamped - offset));
      return {
        clip: clips[i],
        index: i,
        offset,
        localTime,
        mediaTime: (clips[i].trimStart ?? 0) + localTime,
      };
    }
    offset += d;
  }
  return null;
}

/** m:ss formatter for the timeline ruler and clip labels. */
export function formatTimelineTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Shared video-file validation for timeline clip adds. Mirrors the
 * single-upload rules so both entry points accept the same files.
 */
export function validateVideoFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    return `File "${file.name}" is too large (${sizeMB}MB). Maximum allowed size is ${MAX_FILE_SIZE_MB}MB.`;
  }
  if (!ALLOWED_VIDEO_TYPES.includes(file.type as any) && !file.type.startsWith('video/')) {
    return `Invalid file type for "${file.name}": ${file.type || 'unknown'}. Please add a valid video file (MP4, WEBM, MOV, etc.).`;
  }
  return null;
}
