import React, { useState, useRef, useEffect } from 'react';
import { useWatermarkRemoval } from '../hooks/useWatermarkRemoval';
import VideoUploader from './VideoUploader';
import VideoPlayer from './VideoPlayer';
import VideoInfo from './VideoInfo';
import { DEFAULT_VIDEO_SETTINGS } from '../constants';
import DownloadIcon from './icons/DownloadIcon';
import ProcessingSpinnerIcon from './icons/ProcessingSpinnerIcon';

const WatermarkRemover: React.FC = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  const {
    detectWatermark,
    removeWatermark,
    cancelDetection,
    cancelRemoval,
    reset,
    state,
  } = useWatermarkRemoval();

  // Handle file selection
  const handleFileSelect = (file: File) => {
    setVideoFile(file);
    setFileError(null);
    reset();
    
    // Get video duration
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  };

  const handleFileError = (error: string) => {
    setFileError(error);
    setVideoFile(null);
    reset();
  };

  // Create preview URL for original video
  useEffect(() => {
    if (videoFile) {
      const objectUrl = URL.createObjectURL(videoFile);
      setPreviewUrl(objectUrl);
      
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    } else {
      setPreviewUrl(null);
    }
  }, [videoFile]);

  const handleUploadDifferent = () => {
    setVideoFile(null);
    reset();
    setFileError(null);
  };

  const handleDetectWatermark = async () => {
    if (videoFile) {
      await detectWatermark(videoFile);
    }
  };

  const handleRemoveWatermark = async () => {
    if (videoFile && state.detectionResult?.coords) {
      await removeWatermark(videoFile);
    }
  };

  // Calculate overlay position for detected watermark
  const getWatermarkOverlayStyle = () => {
    if (!state.detectionResult?.coords || !videoContainerRef.current) {
      return null;
    }

    const container = videoContainerRef.current;
    const video = container.querySelector('video');
    if (!video) return null;

    const containerRect = container.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    
    const scaleX = videoRect.width / video.videoWidth;
    const scaleY = videoRect.height / video.videoHeight;
    
    const coords = state.detectionResult.coords;
    
    return {
      position: 'absolute' as const,
      left: `${videoRect.left - containerRect.left + coords.x * scaleX}px`,
      top: `${videoRect.top - containerRect.top + coords.y * scaleY}px`,
      width: `${coords.width * scaleX}px`,
      height: `${coords.height * scaleY}px`,
      border: '2px solid #f59e0b',
      backgroundColor: 'rgba(245, 158, 11, 0.2)',
      pointerEvents: 'none' as const,
      zIndex: 10,
    };
  };

  const controlsDisabled = !videoFile || state.isDetecting || state.isRemoving;

  return (
    <div className="w-full space-y-6">
      {!videoFile ? (
        <>
          <VideoUploader
            onFileSelect={handleFileSelect}
            onFileError={handleFileError}
            disabled={state.isDetecting || state.isRemoving}
          />
          {fileError && (
            <div className="bg-red-700 p-4 rounded-lg text-red-100">
              <p className="font-semibold">File Upload Error:</p>
              <p className="text-sm">{fileError}</p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">Original Video</h4>
              <div ref={videoContainerRef} className="relative">
                <VideoPlayer src={previewUrl} settings={DEFAULT_VIDEO_SETTINGS} isOriginal={true} />
                {state.detectionResult?.detected && state.detectionResult.coords && (
                  <div style={getWatermarkOverlayStyle() || {}} />
                )}
              </div>
            </div>
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">
                {state.processedVideoUrl ? 'Processed Video' : 'Preview'}
              </h4>
              <VideoPlayer
                src={state.processedVideoUrl || previewUrl}
                settings={DEFAULT_VIDEO_SETTINGS}
                isOriginal={true}
              />
            </div>
          </div>

          <VideoInfo
            fileName={videoFile.name}
            fileSize={videoFile.size}
            fileType={videoFile.type}
            duration={videoDuration}
          />

          {state.detectionResult && (
            <div className={`p-4 rounded-lg ${
              state.detectionResult.detected
                ? 'bg-yellow-900 border-2 border-yellow-500'
                : 'bg-blue-900 border-2 border-blue-500'
            }`}>
              <h4 className="font-semibold text-lg mb-2">
                {state.detectionResult.detected ? '✓ Watermark Detected' : 'No Watermark Detected'}
              </h4>
              {state.detectionResult.detected && state.detectionResult.coords && (
                <div className="text-sm space-y-1">
                  <p>Position: ({state.detectionResult.coords.x}, {state.detectionResult.coords.y})</p>
                  <p>Size: {state.detectionResult.coords.width} × {state.detectionResult.coords.height}px</p>
                  <p>Confidence: {state.detectionResult.confidence}%</p>
                </div>
              )}
              {state.detectionResult.message && (
                <p className="text-sm mt-2 opacity-80">{state.detectionResult.message}</p>
              )}
            </div>
          )}

          <div className="bg-gray-800 p-6 rounded-lg shadow-lg space-y-4">
            <div className="space-y-3">
              <button
                onClick={handleDetectWatermark}
                disabled={controlsDisabled}
                className="w-full px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.isDetecting ? (
                  <>
                    <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                    Detecting Watermark... ({state.progress}%)
                  </>
                ) : (
                  'Detect Watermark'
                )}
              </button>

              {state.isDetecting && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div
                      className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${state.progress}%` }}
                    />
                  </div>
                  <button
                    onClick={cancelDetection}
                    className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
                  >
                    Cancel Detection
                  </button>
                </>
              )}

              {state.detectionResult?.detected && (
                <button
                  onClick={handleRemoveWatermark}
                  disabled={controlsDisabled || state.isRemoving}
                  className="w-full px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {state.isRemoving ? (
                    <>
                      <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                      Removing Watermark... ({state.progress}%)
                    </>
                  ) : (
                    'Remove Watermark'
                  )}
                </button>
              )}

              {state.isRemoving && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div
                      className="bg-green-500 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${state.progress}%` }}
                    />
                  </div>
                  <button
                    onClick={cancelRemoval}
                    className="w-full px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
                  >
                    Cancel Removal
                  </button>
                </>
              )}
            </div>

            {state.error && (
              <div className="bg-red-700 p-4 rounded-lg text-red-100">
                <p className="font-semibold">Error:</p>
                <p className="text-sm">{state.error}</p>
              </div>
            )}

            {state.processedVideoUrl && !state.isRemoving && (
              <div className="bg-green-700 p-4 rounded-lg">
                <h4 className="text-lg font-semibold text-green-100 mb-2">Watermark Removed!</h4>
                <p className="text-sm text-green-200 mb-3">Your processed video is ready (WEBM format).</p>
                <a
                  href={state.processedVideoUrl}
                  download={`watermark_removed_${videoFile.name.replace(/\.[^.]+$/, '') || 'video'}.webm`}
                  className="w-full px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200"
                >
                  <DownloadIcon className="w-5 h-5 mr-2" />
                  Download Processed Video
                </a>
              </div>
            )}

            <button
              onClick={handleUploadDifferent}
              disabled={state.isDetecting || state.isRemoving}
              className="w-full px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200 disabled:opacity-50"
            >
              Upload Different Video
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default WatermarkRemover;
