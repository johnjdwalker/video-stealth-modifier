import React, { useEffect, useMemo, useRef } from 'react';
import { VideoSettings } from '../types';

interface VideoPlayerProps {
  src: string | null;
  settings: VideoSettings;
  isOriginal?: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, settings, isOriginal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const showWatermarkOverlay = useMemo(() => !isOriginal && settings.removeWatermark, [isOriginal, settings.removeWatermark]);
  const overlayDimensions = useMemo(() => {
    if (!showWatermarkOverlay) {
      return null;
    }
    const width = Math.max(0, Math.min(100 - settings.watermarkXPercent, settings.watermarkWidthPercent));
    const height = Math.max(0, Math.min(100 - settings.watermarkYPercent, settings.watermarkHeightPercent));
    return {
      left: `${Math.max(0, settings.watermarkXPercent)}%`,
      top: `${Math.max(0, settings.watermarkYPercent)}%`,
      width: `${width}%`,
      height: `${height}%`,
    };
  }, [settings.watermarkHeightPercent, settings.watermarkWidthPercent, settings.watermarkXPercent, settings.watermarkYPercent, showWatermarkOverlay]);

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
      {showWatermarkOverlay && overlayDimensions && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="absolute border border-dashed border-indigo-400 text-[10px] uppercase tracking-wide text-indigo-200 flex items-center justify-center"
            style={{
              ...overlayDimensions,
              backgroundColor: 'rgba(99, 102, 241, 0.12)',
            }}
          >
            Mask Preview
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;