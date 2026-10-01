import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { TimelineClip, VideoSettings } from '../types';
import { buildCssFilterString } from './VideoPlayer';
import {
  clipTimelineOffsets,
  findClipAtTime,
  formatTimelineTime,
  timelineTotalDuration,
} from '../utils/timeline';

export interface TimelinePlayerHandle {
  /** Jump to a timeline time (seconds). Keeps the current play/pause state. */
  seekTo: (t: number) => void;
  play: () => void;
  pause: () => void;
}

interface TimelinePlayerProps {
  clips: TimelineClip[];
  settings: VideoSettings;
  /** Throttled playback position reports (drives the timeline playhead). */
  onTimeUpdate: (t: number) => void;
  disabled?: boolean;
}

const CANPLAY_TIMEOUT_MS = 10000;

/** Resolve once the element can play (readyState >= 3). */
function waitCanPlay(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean, err?: Error) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('error', onError);
      if (ok) resolve();
      else reject(err ?? new Error('The preview video could not be loaded.'));
    };
    const onCanPlay = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false, new Error('Timed out loading the preview video.')), CANPLAY_TIMEOUT_MS);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('error', onError);
  });
}

/**
 * Gapless-ish sequential preview across timeline clips.
 *
 * One <video> element walks the clips in order: when the playhead crosses a
 * clip's out-point the next clip's blob URL is swapped in and playback
 * continues. The next clip is preloaded while the current one plays so the
 * cut is a short hiccup, not a stall. Global settings (filters, speed,
 * volume) apply across the whole timeline, mirroring the export.
 */
const TimelinePlayer = forwardRef<TimelinePlayerHandle, TimelinePlayerProps>(
  ({ clips, settings, onTimeUpdate, disabled }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const urlsRef = useRef<Map<string, string>>(new Map());
    const clipsRef = useRef<TimelineClip[]>(clips);
    clipsRef.current = clips;
    const offsetsRef = useRef<number[]>([]);
    const onTimeUpdateRef = useRef(onTimeUpdate);
    onTimeUpdateRef.current = onTimeUpdate;

    const segIndexRef = useRef(0);
    const timeRef = useRef(0); // last reported timeline time
    const rafRef = useRef(0);
    const loadTokenRef = useRef(0);
    const loadingRef = useRef(false);
    const preloadElRef = useRef<HTMLVideoElement | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [playError, setPlayError] = useState<string | null>(null);
    const [displayTime, setDisplayTime] = useState(0);

    const totalDuration = timelineTotalDuration(clips);
    const idsKey = clips.map((c) => c.id).join(',');

    // Object URLs keyed by clip id: created/revoked only when the clip set
    // changes (trim edits keep ids, so they never rebuild URLs).
    useEffect(() => {
      const next = new Map<string, string>();
      for (const c of clipsRef.current) {
        const existing = urlsRef.current.get(c.id);
        next.set(c.id, existing ?? URL.createObjectURL(c.file));
      }
      for (const [id, url] of urlsRef.current) {
        if (!next.has(id)) URL.revokeObjectURL(url);
      }
      urlsRef.current = next;
      offsetsRef.current = clipTimelineOffsets(clipsRef.current);

      // Structural change: if the current clip is gone (or there are no
      // clips), reset to the start, paused.
      const currentClip = clipsRef.current[segIndexRef.current];
      if (!currentClip || !next.has(currentClip.id)) {
        const v = videoRef.current;
        loadTokenRef.current += 1;
        if (v) {
          try { v.pause(); } catch { /* ignore */ }
          v.removeAttribute('src');
          try { v.load(); } catch { /* ignore */ }
        }
        if (preloadElRef.current) {
          preloadElRef.current.removeAttribute('src');
          preloadElRef.current = null;
        }
        segIndexRef.current = 0;
        timeRef.current = 0;
        setDisplayTime(0);
        setIsPlaying(false);
        onTimeUpdateRef.current(0);
        const first = clipsRef.current[0];
        const firstUrl = first ? next.get(first.id) : undefined;
        if (v && firstUrl) {
          v.src = firstUrl; // poster frame, no autoplay
        }
      }
      return () => {
        // urls are revoked on the next run / unmount below; nothing here.
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsKey]);

    // Revoke all URLs on unmount.
    useEffect(() => {
      return () => {
        for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
        urlsRef.current.clear();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }, []);

    // React doesn't reliably set muted from JSX — set imperatively.
    useEffect(() => {
      const v = videoRef.current;
      if (v) v.muted = muted;
    }, [muted]);

    // Global settings apply to the preview element.
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      v.style.filter = buildCssFilterString(settings);
      v.style.transform = settings.flipHorizontal ? 'scaleX(-1)' : 'none';
      v.playbackRate = settings.playbackSpeed;
      v.volume = settings.volume / 100;
    }, [settings]);

    const stopLoop = useCallback(() => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    }, []);

    const reportTime = useCallback((t: number) => {
      timeRef.current = t;
      setDisplayTime(t);
      onTimeUpdateRef.current(t);
    }, []);

    /** Preload the clip after `index` so the cut doesn't stall. */
    const preloadNext = useCallback((index: number) => {
      const nextClip = clipsRef.current[index + 1];
      if (!nextClip) {
        preloadElRef.current = null;
        return;
      }
      const url = urlsRef.current.get(nextClip.id);
      if (!url) return;
      let el = preloadElRef.current;
      if (!el) {
        el = document.createElement('video');
        el.preload = 'auto';
        el.muted = true;
        preloadElRef.current = el;
      }
      if (el.src !== url) el.src = url;
    }, []);

    const loadClipAt = useCallback(async (index: number, mediaTime: number, autoplay: boolean) => {
      const v = videoRef.current;
      const clip = clipsRef.current[index];
      const url = clip ? urlsRef.current.get(clip.id) : undefined;
      if (!v || !clip || !url) return;
      const token = ++loadTokenRef.current;
      loadingRef.current = true;
      setPlayError(null);
      try {
        if (v.src !== url) {
          v.src = url;
          await waitCanPlay(v);
        }
        if (token !== loadTokenRef.current) return; // superseded
        try {
          v.currentTime = Math.max(0, Math.min(clip.duration - 0.05, mediaTime));
        } catch { /* ignore */ }
        if (autoplay) {
          await v.play();
        }
        if (token !== loadTokenRef.current) return;
        preloadNext(index);
      } catch (e) {
        if (token !== loadTokenRef.current) return;
        setPlayError(e instanceof Error ? e.message : 'Could not play this clip.');
        setIsPlaying(false);
      } finally {
        if (token === loadTokenRef.current) loadingRef.current = false;
      }
    }, [preloadNext]);

    /** Advance past the current clip: next clip, or finish the timeline. */
    const advance = useCallback(() => {
      const nextIndex = segIndexRef.current + 1;
      if (nextIndex < clipsRef.current.length) {
        segIndexRef.current = nextIndex;
        const clip = clipsRef.current[nextIndex];
        const mediaTime = clip.trimStart ?? 0;
        reportTime(offsetsRef.current[nextIndex]);
        void loadClipAt(nextIndex, mediaTime, true);
      } else {
        // End of timeline: hold the last frame, report the total.
        const v = videoRef.current;
        if (v) {
          try { v.pause(); } catch { /* ignore */ }
        }
        setIsPlaying(false);
        reportTime(timelineTotalDuration(clipsRef.current));
      }
    }, [loadClipAt, reportTime]);

    // rAF loop while playing: tight out-point detection + throttled time reports.
    const tick = useCallback(() => {
      rafRef.current = 0;
      const v = videoRef.current;
      const clip = clipsRef.current[segIndexRef.current];
      if (!v || !clip || loadingRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const trimStart = clip.trimStart ?? 0;
      const trimEnd = clip.trimEnd ?? clip.duration;
      if (v.ended || v.currentTime >= trimEnd - 0.03) {
        advance();
        // advance() either loads the next clip (loop continues via loadClipAt
        // -> playing) or finishes. Keep the loop armed only while playing.
        if (segIndexRef.current < clipsRef.current.length) {
          rafRef.current = requestAnimationFrame(tick);
        }
        return;
      }
      const t = offsetsRef.current[segIndexRef.current] + Math.max(0, v.currentTime - trimStart);
      if (Math.abs(t - timeRef.current) > 0.04) {
        reportTime(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    }, [advance, reportTime]);

    const startLoop = useCallback(() => {
      stopLoop();
      rafRef.current = requestAnimationFrame(tick);
    }, [stopLoop, tick]);

    const play = useCallback(() => {
      if (clipsRef.current.length === 0 || disabled) return;
      const total = timelineTotalDuration(clipsRef.current);
      let t = timeRef.current;
      if (t >= total - 0.05) t = 0; // restart from the top at the end
      const found = findClipAtTime(clipsRef.current, t);
      if (!found) return;
      segIndexRef.current = found.index;
      setIsPlaying(true);
      reportTime(t);
      void loadClipAt(found.index, found.mediaTime, true).then(() => startLoop());
    }, [disabled, loadClipAt, reportTime, startLoop]);

    const pause = useCallback(() => {
      loadTokenRef.current += 1; // cancel any in-flight load
      loadingRef.current = false;
      stopLoop();
      const v = videoRef.current;
      if (v) {
        try { v.pause(); } catch { /* ignore */ }
      }
      setIsPlaying(false);
    }, [stopLoop]);

    const seekTo = useCallback((t: number) => {
      const clipsNow = clipsRef.current;
      if (clipsNow.length === 0) return;
      const total = timelineTotalDuration(clipsNow);
      const clamped = Math.max(0, Math.min(total - 1e-4, t));
      const found = findClipAtTime(clipsNow, clamped);
      if (!found) return;
      const wasPlaying = isPlayingRef.current;
      segIndexRef.current = found.index;
      reportTime(clamped);
      void loadClipAt(found.index, found.mediaTime, wasPlaying).then(() => {
        if (wasPlaying) startLoop();
      });
    }, [loadClipAt, reportTime, startLoop]);

    const isPlayingRef = useRef(isPlaying);
    isPlayingRef.current = isPlaying;

    useImperativeHandle(ref, () => ({ seekTo, play, pause }), [seekTo, play, pause]);

    // Pause when clips are removed mid-playback handled via idsKey effect.
    useEffect(() => stopLoop, [stopLoop]);

    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || totalDuration <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekTo(ratio * totalDuration);
    };

    const vignetteOpacity = settings.vignette > 0 ? settings.vignette / 100 : 0;

    return (
      <div>
        <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
          {clips.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center text-gray-500">
              <p>Add clips below to preview your timeline</p>
            </div>
          ) : (
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              playsInline
              preload="auto"
            />
          )}
          {vignetteOpacity > 0 && clips.length > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${vignetteOpacity}) 100%)`,
              }}
            />
          )}
          {(settings.enablePixelNoise || settings.enableRotatingLines) && clips.length > 0 && (
            <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 text-[11px] text-gray-300 pointer-events-none">
              Noise / line effects render on export
            </div>
          )}
          {playError && (
            <div className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded bg-red-900/90 text-red-100 text-sm">
              {playError}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={isPlaying ? pause : play}
            disabled={disabled || clips.length === 0}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
            aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <div
            className="flex-1 h-2 bg-gray-700 rounded-full cursor-pointer"
            onClick={handleProgressClick}
            role="slider"
            aria-label="Timeline preview position"
            aria-valuemin={0}
            aria-valuemax={Math.round(totalDuration)}
            aria-valuenow={Math.round(displayTime)}
          >
            <div
              className="h-2 bg-indigo-500 rounded-full"
              style={{ width: `${totalDuration > 0 ? (displayTime / totalDuration) * 100 : 0}%` }}
            />
          </div>
          <span className="text-sm text-gray-300 font-mono whitespace-nowrap">
            {formatTimelineTime(displayTime)} / {formatTimelineTime(totalDuration)}
          </span>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            disabled={disabled}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg transition-colors"
            aria-label={muted ? 'Unmute preview' : 'Mute preview'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>
    );
  }
);

TimelinePlayer.displayName = 'TimelinePlayer';

export default TimelinePlayer;
