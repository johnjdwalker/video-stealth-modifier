import { useCallback, useMemo, useRef, useState } from 'react';
import { TimelineClip } from '../types';
import {
  MIN_CLIP_SECONDS,
  clipTimelineOffsets,
  timelineTotalDuration,
  validateVideoFile,
} from '../utils/timeline';

const PROBE_TIMEOUT_MS = 15000;
const THUMBNAIL_WIDTH = 192;
const THUMBNAIL_HEIGHT = 108;

let clipIdCounter = 0;
function nextClipId(): string {
  clipIdCounter += 1;
  return `clip-${Date.now().toString(36)}-${clipIdCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

interface ProbedMedia {
  duration: number;
  width: number;
  height: number;
  thumbnail: string | null;
}

/**
 * Probe a file for duration, dimensions, and a poster thumbnail. The object
 * URL is revoked on every path so probing never pins blobs in memory.
 */
function probeVideoFile(file: File): Promise<ProbedMedia> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    // Muted + playsInline so thumbnail seeks don't trip autoplay policy.
    video.muted = true;
    (video as any).playsInline = true;

    let settled = false;
    const done = (result: ProbedMedia | null, err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      if (result) resolve(result);
      else reject(err ?? new Error(`Could not read "${file.name}".`));
    };

    const timer = window.setTimeout(
      () => done(null, new Error(`Timed out reading "${file.name}".`)),
      PROBE_TIMEOUT_MS
    );

    const captureThumbnail = (): string | null => {
      try {
        if (!video.videoWidth || !video.videoHeight) return null;
        const canvas = document.createElement('canvas');
        canvas.width = THUMBNAIL_WIDTH;
        canvas.height = THUMBNAIL_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
        const scale = Math.min(THUMBNAIL_WIDTH / video.videoWidth, THUMBNAIL_HEIGHT / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, (THUMBNAIL_WIDTH - w) / 2, (THUMBNAIL_HEIGHT - h) / 2, w, h);
        return canvas.toDataURL('image/jpeg', 0.55);
      } catch {
        return null;
      }
    };

    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!isFinite(duration) || duration <= 0 || !width || !height) {
        done(null, new Error(`"${file.name}" has no readable video track.`));
        return;
      }
      // Grab a poster frame ~10% in (never the first frame: often black).
      const thumbAt = Math.min(Math.max(0.1, duration * 0.1), Math.max(0.1, duration - 0.1));
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        const thumbnail = captureThumbnail();
        done({ duration, width, height, thumbnail });
      };
      // If the seek never completes, still resolve with metadata we have.
      const thumbTimer = window.setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        done({ duration, width, height, thumbnail: null });
      }, 4000);
      const wrappedSeeked = () => {
        window.clearTimeout(thumbTimer);
        onSeeked();
      };
      video.addEventListener('seeked', wrappedSeeked);
      try {
        video.currentTime = thumbAt;
      } catch {
        window.clearTimeout(thumbTimer);
        video.removeEventListener('seeked', wrappedSeeked);
        done({ duration, width, height, thumbnail: null });
      }
    };
    video.onerror = () => {
      done(null, new Error(`Could not load "${file.name}" — the file may be corrupted or an unsupported format.`));
    };
    video.src = url;
  });
}

/** Clamp a trim window into [0, duration] with a minimum playable length. */
function sanitizeTrim(
  duration: number,
  trimStart: number | null,
  trimEnd: number | null
): { trimStart: number | null; trimEnd: number | null } {
  let s = trimStart == null ? 0 : Math.max(0, Math.min(duration, trimStart));
  let e = trimEnd == null ? duration : Math.max(0, Math.min(duration, trimEnd));
  if (e - s < MIN_CLIP_SECONDS) {
    // Collapse toward the side the caller was moving: keep it simple and
    // restore the full clip rather than inventing a window.
    return { trimStart: null, trimEnd: null };
  }
  return {
    trimStart: s <= 0 ? null : s,
    trimEnd: e >= duration ? null : e,
  };
}

export interface UseTimeline {
  clips: TimelineClip[];
  /** Per-clip timeline start offsets in seconds. */
  offsets: number[];
  totalDuration: number;
  /** Validate + probe files and append them as clips. Returns per-file errors. */
  addFiles: (files: File[]) => Promise<string[]>;
  removeClip: (id: string) => void;
  /** Move a clip to a new index (clamped). */
  moveClip: (id: string, toIndex: number) => void;
  updateClipTrim: (id: string, trimStart: number | null, trimEnd: number | null) => void;
  /**
   * Split the clip under `timelineSeconds` into two at that point.
   * Returns the new (second-half) clip id, or null when nothing was split.
   */
  splitClipAt: (timelineSeconds: number) => string | null;
  clear: () => void;
  isProbing: boolean;
}

/**
 * Multi-clip timeline state. Files live in memory only; probing (duration,
 * dimensions, thumbnail) runs sequentially per added file so a burst of
 * large drops doesn't spin up dozens of decoder elements at once.
 */
export function useTimeline(): UseTimeline {
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [isProbing, setIsProbing] = useState(false);
  // Bumped by clear(): in-flight probes resolve against a stale generation
  // and are dropped instead of appending to an emptied timeline.
  const generationRef = useRef(0);

  const addFiles = useCallback(async (files: File[]): Promise<string[]> => {
    const errors: string[] = [];
    const valid = files.filter((f) => {
      const err = validateVideoFile(f);
      if (err) errors.push(err);
      return !err;
    });
    if (valid.length === 0) return errors;

    const generation = generationRef.current;
    setIsProbing(true);
    try {
      const added: TimelineClip[] = [];
      for (const file of valid) {
        try {
          const probed = await probeVideoFile(file);
          if (generation !== generationRef.current) return errors; // cleared mid-probe
          added.push({
            id: nextClipId(),
            file,
            name: file.name,
            duration: probed.duration,
            width: probed.width,
            height: probed.height,
            trimStart: null,
            trimEnd: null,
            thumbnail: probed.thumbnail,
          });
        } catch (e) {
          errors.push(e instanceof Error ? e.message : `Could not read "${file.name}".`);
        }
      }
      if (added.length > 0 && generation === generationRef.current) {
        setClips((prev) => [...prev, ...added]);
      }
    } finally {
      if (generation === generationRef.current) {
        setIsProbing(false);
      }
    }
    return errors;
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const moveClip = useCallback((id: string, toIndex: number) => {
    setClips((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      if (from === -1) return prev;
      const clamped = Math.max(0, Math.min(prev.length - 1, toIndex));
      if (clamped === from) return prev;
      const next = [...prev];
      const [clip] = next.splice(from, 1);
      next.splice(clamped, 0, clip);
      return next;
    });
  }, []);

  const updateClipTrim = useCallback((id: string, trimStart: number | null, trimEnd: number | null) => {
    setClips((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const clean = sanitizeTrim(c.duration, trimStart, trimEnd);
        if (clean.trimStart === c.trimStart && clean.trimEnd === c.trimEnd) return c;
        return { ...c, ...clean };
      })
    );
  }, []);

  const splitClipAt = useCallback((timelineSeconds: number): string | null => {
    // Find the split target from current state via a ref-free read: we use
    // the functional updater and stash the result in a local.
    let newId: string | null = null;
    setClips((prev) => {
      let offset = 0;
      for (let i = 0; i < prev.length; i++) {
        const clip = prev[i];
        const start = clip.trimStart ?? 0;
        const end = clip.trimEnd ?? clip.duration;
        const eff = Math.max(MIN_CLIP_SECONDS, end - start);
        if (timelineSeconds > offset + 0.15 && timelineSeconds < offset + eff - 0.15) {
          const mediaTime = start + (timelineSeconds - offset);
          const first: TimelineClip = { ...clip, trimEnd: mediaTime };
          const second: TimelineClip = {
            ...clip,
            id: nextClipId(),
            trimStart: mediaTime,
            trimEnd: clip.trimEnd,
          };
          newId = second.id;
          const next = [...prev];
          next.splice(i, 1, first, second);
          return next;
        }
        offset += eff;
      }
      return prev;
    });
    return newId;
  }, []);

  const clear = useCallback(() => {
    generationRef.current += 1;
    setIsProbing(false);
    setClips([]);
  }, []);

  const offsets = useMemo(() => clipTimelineOffsets(clips), [clips]);
  const totalDuration = useMemo(() => timelineTotalDuration(clips), [clips]);

  return {
    clips,
    offsets,
    totalDuration,
    addFiles,
    removeClip,
    moveClip,
    updateClipTrim,
    splitClipAt,
    clear,
    isProbing,
  };
}
