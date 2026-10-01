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

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  useEffect(() => {
    if (!settings.enablePixelNoise) return;
    const canvas = noiseCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const render = () => {
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
  }, [settings.enablePixelNoise]);

  // Drift watcher: modified may play at a different rate (speed change), so
  // re-snap it to the original's clock when it drifts past the threshold.
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const a = originalRef.current;
      const b = modifiedRef.current;
      if (!a || !b || a.paused || b.paused) return;
      if (Math.abs(a.currentTime - b.currentTime) > SYNC_DRIFT_THRESHOLD_SECONDS) {
        b.currentTime = a.currentTime;
      }
    }, SYNC_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const handleLoadedMetadata = useCallback(() => {
    const a = originalRef.current;
    if (a && isFinite(a.duration)) setDuration(a.duration);
  }, []);

  const togglePlay = useCallback(async () => {
    const a = originalRef.current;
    const b = modifiedRef.current;
    if (!a || !b) return;
    try {
      if (a.paused) {
        b.currentTime = a.currentTime; // re-snap on play
        await Promise.all([a.play(), b.play()]);
        setIsPlaying(true);
      } else {
        a.pause();
        b.pause();
        setIsPlaying(false);
      }
    } catch {
      /* play() can reject when interrupted; state stays consistent */
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
    </div>
  );
};

export default ComparePlayers;
