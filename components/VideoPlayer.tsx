import React, { useEffect, useRef } from 'react';
import { VideoSettings } from '../types';

interface VideoPlayerProps {
  src: string | null;
  settings: VideoSettings;
  isOriginal?: boolean;
}

export function buildCssFilterString(settings: VideoSettings): string {
  const parts: string[] = [
    `brightness(${settings.brightness}%)`,
    `contrast(${settings.contrast}%)`,
    `saturate(${settings.saturation}%)`,
  ];
  if (settings.hueRotate !== 0) parts.push(`hue-rotate(${settings.hueRotate}deg)`);
  if (settings.blur > 0) parts.push(`blur(${settings.blur}px)`);
  if (settings.sepia > 0) parts.push(`sepia(${settings.sepia}%)`);
  if (settings.grayscale > 0) parts.push(`grayscale(${settings.grayscale}%)`);
  return parts.join(' ');
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, settings, isOriginal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && src) {
      if (isOriginal) {
        videoRef.current.style.filter = 'none';
        videoRef.current.style.transform = 'none';
        videoRef.current.playbackRate = 1.0;
        videoRef.current.volume = 1.0;
      } else {
        videoRef.current.style.filter = buildCssFilterString(settings);
        videoRef.current.style.transform = settings.flipHorizontal ? 'scaleX(-1)' : 'none';
        videoRef.current.playbackRate = settings.playbackSpeed;
        videoRef.current.volume = settings.volume / 100;
      }
    }
  }, [src, settings, isOriginal]);

  if (!src) {
    return (
      <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
        <p>Loading preview...</p>
      </div>
    );
  }

  // Vignette is rendered as an overlay since CSS filter doesn't include it.
  const vignetteOpacity = !isOriginal && settings.vignette > 0 ? settings.vignette / 100 : 0;

  return (
    <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full h-full object-contain"
        loop
        autoPlay
        muted
      />
      {vignetteOpacity > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 50%, rgba(0,0,0,${vignetteOpacity}) 100%)`,
          }}
        />
      )}
    </div>
  );
};

export default VideoPlayer;
