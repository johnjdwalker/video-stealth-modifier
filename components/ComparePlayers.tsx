import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VideoSettings } from '../types';
import { buildCssFilterString } from './VideoPlayer';

interface ComparePlayersProps {
  src: string;
  settings: VideoSettings;
  disabled?: boolean;
}

/** Drift beyond this (seconds) triggers a re-snap of the modified player. */
const SYNC_DRIFT_THRESHOLD_SECONDS = 0.25;
/** Master time is polled at this rate to keep the two players aligned. */
const SYNC_CHECK_INTERVAL_MS = 500;
/** How long to wait for enough preview data before giving up. */
const PREVIEW_READY_TIMEOUT_MS = 10000;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Resolve once the element has enough data to play (readyState >= 3).
 * Starting playback before this risks a stalled first frame with no error.
 */
function ensurePreviewReady(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('error', onError);
    };
    const onCanPlay = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('The preview video could not be loaded.')); };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the preview video to load.'));
    }, PREVIEW_READY_TIMEOUT_MS);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('error', onError);
  });
}

/**
 * Side-by-side Original / Modified players driven by ONE transport.
 *
 * The old UI mounted two independent autoplay players, so the "compare"
 * drifted apart within seconds and scrubbing one did nothing to the other.
 * Here a single play/pause button and scrub slider drive both videos, and a
 * drift watcher re-snaps the modified player when playback rates (speed
 * changes) let it drift — so the two frames genuinely match.
 *
 * Preview fidelity: rotating lines and pixel noise are canvas-export effects,
 * so the preview renders them as DOM overlays (a CSS-animated lines overlay
 * and a small canvas noise tile re-rendered at ~7fps) rather than omitting
 * them. Vignette renders as a radial overlay.
 *
 * Volume: the original stays muted to avoid doubling audio; the modified
 * player is unmuted so the volume slider is actually audible in preview.
 */
const ComparePlayers: React.FC<ComparePlayersProps> = ({ src, settings, disabled }) => {
  const originalRef = useRef<HTMLVideoElement>(null);
  const modifiedRef = useRef<HTMLVideoElement>(null);
  const noiseCanvasRef = useRef<HTMLCanvasElement>(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [showExportOnlyBadge, setShowExportOnlyBadge] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const scrubRafRef = useRef(0);
  const lastShownTimeRef = useRef(-1);

  // React doesn't reliably set the muted *property* from the JSX attribute
  // (it's the property that matters for autoplay policy), so set it
  // imperatively on mount. The original stays muted to avoid doubling audio.
  useEffect(() => {
    const a = originalRef.current;
    const b = modifiedRef.current;
    if (a) a.muted = true;
    if (b) b.muted = true;
  }, []);

  // Apply per-frame-agnostic properties to the modified player.
  useEffect(() => {
    const v = modifiedRef.current;
    if (!v) return;
    v.style.filter = buildCssFilterString(settings);
    v.style.transform = settings.flipHorizontal ? 'scaleX(-1)' : 'none';
    v.playbackRate = settings.playbackSpeed;
    v.volume = settings.volume / 100;
  }, [settings]);

  // Pixel-noise preview overlay: re-render a low-res noise field a few times
  // per second. Cheap (160x90 = 14k px) and looks like the export effect.
  // Only runs while playing, and skips frames while the tab is hidden.
  useEffect(() => {
    if (!settings.enablePixelNoise || !isPlaying) return;
    const canvas = noiseCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const render = () => {
      if (document.hidden) return;
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() > 0.5 ? 235 : 20;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 6 + Math.random() * 16;
      }
      ctx.putImageData(img, 0, 0);
    };
    render();
    const id = window.setInterval(render, 150);
    return () => window.clearInterval(id);
  }, [settings.enablePixelNoise, isPlaying]);

  // Drift watcher: re-snap the modified player to the original's clock when
  // it drifts past the threshold. Disabled while the preview runs at a
  // different speed — slow-mo/fast-forward diverge on purpose, and
  // re-snapping would fight the speed effect.
  useEffect(() => {
    if (!isPlaying) return;
    if (settings.playbackSpeed !== 1) return;
    const id = window.setInterval(() => {
      const a = originalRef.current;
      const b = modifiedRef.current;
      if (!a || !b || a.paused || b.paused) return;
      if (Math.abs(a.currentTime - b.currentTime) > SYNC_DRIFT_THRESHOLD_SECONDS) {
        b.currentTime = a.currentTime;
      }
    }, SYNC_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isPlaying, settings.playbackSpeed]);

  // While scrubbing (usually paused), timeupdate doesn't fire, so the time
  // display would lag the slider. Drive it off rAF instead, throttled to
  // changes bigger than one frame at 30fps to avoid re-render churn.
  useEffect(() => {
    if (!isScrubbing) return;
    const tick = () => {
      const a = originalRef.current;
      if (a && Math.abs(a.currentTime - lastShownTimeRef.current) > 1 / 30) {
        lastShownTimeRef.current = a.currentTime;
        setCurrentTime(a.currentTime);
      }
      scrubRafRef.current = requestAnimationFrame(tick);
    };
    scrubRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(scrubRafRef.current);
  }, [isScrubbing]);

  const handleLoadedMetadata = useCallback(() => {
    const a = originalRef.current;
    if (a && isFinite(a.duration)) setDuration(a.duration);
  }, []);

  const togglePlay = useCallback(async () => {
    const a = originalRef.current;
    const b = modifiedRef.current;
    if (!a || !b) return;
    setPlayError(null);
    try {
      if (a.paused) {
        // Wait for enough data before starting: playing too early stalls on
        // the first frame with no error to show for it.
        await Promise.all([ensurePreviewReady(a), ensurePreviewReady(b)]);
        b.currentTime = a.currentTime; // re-snap on play
        await Promise.all([a.play(), b.play()]);
        setIsPlaying(true);
      } else {
        a.pause();
        b.pause();
        setIsPlaying(false);
      }
    } catch (e) {
      // play() rejects when the browser blocks it or a newer play/pause call
      // interrupts it. The interrupt case (AbortError, from fast toggling)
      // is expected — only surface real failures.
      setIsPlaying(false);
      if (e instanceof Error && e.name !== 'AbortError') {
        setPlayError(`Could not start preview playback: ${e.message}`);
      }
    }
  }, []);

  const seek = useCallback((t: number) => {
    const a = originalRef.current;
    const b = modifiedRef.current;
    if (!a || !b) return;
    const clamped = Math.max(0, Math.min(duration || 0, t));
    a.currentTime = clamped;
    b.currentTime = clamped;
    setCurrentTime(clamped);
  }, [duration]);

  const resync = useCallback(() => {
    const a = originalRef.current;
    const b = modifiedRef.current;
    if (a && b) {
      b.currentTime = a.currentTime;
      setCurrentTime(a.currentTime);
    }
  }, []);

  // Show a one-time hint that lines/noise are preview approximations.
  useEffect(() => {
    if (settings.enableRotatingLines || settings.enablePixelNoise) {
      setShowExportOnlyBadge(true);
      const id = window.setTimeout(() => setShowExportOnlyBadge(false), 6000);
      return () => window.clearTimeout(id);
    }
  }, [settings.enableRotatingLines, settings.enablePixelNoise]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(currentTime - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(currentTime + 5);
    }
  };

  const vignetteOpacity = settings.vignette > 0 ? settings.vignette / 100 : 0;

  const playerFrame = (label: string, isModified: boolean, videoRef: React.RefObject<HTMLVideoElement | null>) => (
    <div>
      <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">{label}</h4>
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full object-contain"
          loop
          playsInline
          autoPlay
          muted
          preload="auto"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={isModified ? undefined : (e) => setCurrentTime(e.currentTarget.currentTime)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
        {isModified && (
          <>
            {/* Rotating lines preview: two CSS-animated lines matching the
                export's 30s-per-revolution speed. */}
            {settings.enableRotatingLines && (
              <>
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className="w-[141%] h-px bg-white/75 vsm-spin"
                    style={{ animation: 'vsm-spin 30s linear infinite' }}
                  />
                </div>
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className="w-[141%] h-px bg-white/75 vsm-spin"
                    style={{ animation: 'vsm-spin 30s linear infinite reverse' }}
                  />
                </div>
              </>
            )}
            {/* Pixel noise preview: canvas tile rendered at ~7fps. */}
            {settings.enablePixelNoise && (
              <canvas
                ref={noiseCanvasRef}
                width={160}
                height={90}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 w-full h-full"
                style={{ imageRendering: 'pixelated' }}
              />
            )}
            {vignetteOpacity > 0 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${vignetteOpacity}) 100%)`,
                }}
              />
            )}
            {showExportOnlyBadge && (settings.enableRotatingLines || settings.enablePixelNoise) && (
              <div className="absolute bottom-2 left-2 text-[11px] bg-black/70 text-gray-200 px-2 py-1 rounded">
                Preview approximation — final look in export
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {playerFrame('Original', false, originalRef)}
        {playerFrame('Modified Preview', true, modifiedRef)}
      </div>

      {/* Shared transport */}
      <div
        className="mt-3 bg-gray-800 rounded-lg p-3 flex flex-wrap items-center gap-3"
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="group"
        aria-label="Synced compare transport. Space plays or pauses, arrow keys seek 5 seconds."
      >
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={isPlaying ? 'Pause both previews' : 'Play both previews'}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <span className="text-sm text-gray-300 tabular-nums w-24 text-center">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          onPointerDown={() => setIsScrubbing(true)}
          onPointerUp={() => setIsScrubbing(false)}
          onPointerCancel={() => setIsScrubbing(false)}
          disabled={disabled || !duration}
          className="flex-1 min-w-[120px] accent-indigo-500"
          aria-label="Seek both previews"
        />
        <button
          type="button"
          onClick={resync}
          disabled={disabled}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
          title="Snap the modified preview back to the original's position"
        >
          Re-sync
        </button>
        <button
          type="button"
          onClick={() => {
            const b = modifiedRef.current;
            if (!b) return;
            const next = !muted;
            setMuted(next);
            b.muted = next;
          }}
          disabled={disabled}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
          aria-label={muted ? 'Unmute modified preview' : 'Mute modified preview'}
          title="Toggle sound on the modified preview (original stays muted)"
        >
          {muted ? '🔇 Unmute preview' : '🔊 Mute preview'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Tip: focus this panel and use <kbd className="px-1 bg-gray-700 rounded">Space</kbd> to play/pause,{' '}
        <kbd className="px-1 bg-gray-700 rounded">←</kbd>/<kbd className="px-1 bg-gray-700 rounded">→</kbd> to seek 5s.
      </p>
      {playError && (
        <p className="text-xs text-red-400 mt-2" role="alert">
          {playError}
        </p>
      )}
    </div>
  );
};

export default ComparePlayers;
