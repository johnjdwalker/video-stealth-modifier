import React, { useEffect, useRef } from 'react';
import { VideoSettings } from '../types';

interface VideoPlayerProps {
  src: string | null;
  settings: VideoSettings;
  isOriginal?: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, settings, isOriginal = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

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
    <div className="w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full h-full object-contain"
        loop
        autoPlay
        muted // Mute preview to avoid issues when processing audio separately and clashing audio
      />
    </div>
  );
};

export default VideoPlayer;