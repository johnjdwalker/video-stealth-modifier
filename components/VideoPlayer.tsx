import React, { useEffect, useRef, useMemo } from 'react';
import { VideoSettings } from '../types';
import { getPresetMask } from '../constants';

interface VideoPlayerProps {
  src: string | null;
  settings: VideoSettings;
  isOriginal?: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, settings, isOriginal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const resolvedMaskForPreview = useMemo(() => {
    if (isOriginal || !settings?.watermarkRemovalEnabled) {
      return null;
    }
    const preset = settings.watermarkPreset === 'custom'
      ? {
          xPercent: settings.watermarkX,
          yPercent: settings.watermarkY,
          widthPercent: settings.watermarkWidth,
          heightPercent: settings.watermarkHeight,
        }
      : getPresetMask(settings.watermarkPreset);
    if (!preset) {
      return null;
    }

    const usableWidthPercent = Math.max(1, 100 - (settings.cropLeft + settings.cropRight));
    const usableHeightPercent = Math.max(1, 100 - (settings.cropTop + settings.cropBottom));

    const left = settings.cropLeft + (preset.xPercent / 100) * usableWidthPercent;
    const top = settings.cropTop + (preset.yPercent / 100) * usableHeightPercent;
    const width = (preset.widthPercent / 100) * usableWidthPercent;
    const height = (preset.heightPercent / 100) * usableHeightPercent;

    return {
      left: Math.min(100, left),
      top: Math.min(100, top),
      width: Math.min(100, width),
      height: Math.min(100, height),
    };
  }, [isOriginal, settings]);

  useEffect(() => {
    if (videoRef.current && src) {
      if (isOriginal) {
        videoRef.current.style.filter = 'none';
        videoRef.current.style.transform = 'none';
        videoRef.current.playbackRate = 1.0;
        videoRef.current.volume = 1.0; // Will still be muted by the `muted` attribute on video tag
      } else {
        videoRef.current.style.filter = `brightness(${settings.brightness}%) contrast(${settings.contrast}%) saturate(${settings.saturation}%)`;
        videoRef.current.style.transform = settings.flipHorizontal ? 'scaleX(-1)' : 'none';
        videoRef.current.playbackRate = settings.playbackSpeed;
        videoRef.current.volume = settings.volume / 100; // Will still be muted
      }
    }
  }, [src, settings, isOriginal]);

  if (!src) {
    // This component expects a src; App.tsx should handle the main placeholder
    // This is a fallback if rendered directly without a src
    return (
      <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
        <p>Loading preview...</p>
      </div>
    );
  }

  const cropOverlaysEnabled = !isOriginal && (
    settings.cropTop > 0 ||
    settings.cropBottom > 0 ||
    settings.cropLeft > 0 ||
    settings.cropRight > 0
  );

  return (
    <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full h-full object-contain"
        loop
        autoPlay
        muted // Mute preview to avoid issues when processing audio separately and clashing audio
      />

      {cropOverlaysEnabled && (
        <>
          {settings.cropTop > 0 && (
            <div
              className="absolute left-0 w-full bg-black/60 text-[10px] uppercase tracking-wide text-gray-200 flex items-center justify-center pointer-events-none"
              style={{ top: 0, height: `${settings.cropTop}%` }}
            >
              Trim {settings.cropTop.toFixed(1)}%
            </div>
          )}
          {settings.cropBottom > 0 && (
            <div
              className="absolute left-0 w-full bg-black/60 text-[10px] uppercase tracking-wide text-gray-200 flex items-center justify-center pointer-events-none"
              style={{ bottom: 0, height: `${settings.cropBottom}%` }}
            >
              Trim {settings.cropBottom.toFixed(1)}%
            </div>
          )}
          {settings.cropLeft > 0 && (
            <div
              className="absolute top-0 h-full bg-black/60 text-[10px] uppercase tracking-wide text-gray-200 flex items-center justify-center pointer-events-none"
              style={{ left: 0, width: `${settings.cropLeft}%`, writingMode: 'vertical-rl' as React.CSSProperties['writingMode'] }}
            >
              Trim {settings.cropLeft.toFixed(1)}%
            </div>
          )}
          {settings.cropRight > 0 && (
            <div
              className="absolute top-0 h-full bg-black/60 text-[10px] uppercase tracking-wide text-gray-200 flex items-center justify-center pointer-events-none"
              style={{ right: 0, width: `${settings.cropRight}%`, writingMode: 'vertical-rl' as React.CSSProperties['writingMode'] }}
            >
              Trim {settings.cropRight.toFixed(1)}%
            </div>
          )}
        </>
      )}

      {!isOriginal && resolvedMaskForPreview && (
        <div
          className="absolute border border-indigo-400/70 bg-indigo-500/20 rounded-sm pointer-events-none"
          style={{
            left: `${resolvedMaskForPreview.left}%`,
            top: `${resolvedMaskForPreview.top}%`,
            width: `${resolvedMaskForPreview.width}%`,
            height: `${resolvedMaskForPreview.height}%`,
          }}
        >
          <span className="absolute top-0 left-0 bg-indigo-600 text-white text-[10px] px-1 py-0.5 rounded-br">
            Blur mask
          </span>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;