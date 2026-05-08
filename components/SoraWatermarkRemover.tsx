import React, { useEffect, useMemo, useRef, useState } from 'react';
import VideoUploader from './VideoUploader';
import VideoInfo from './VideoInfo';
import DownloadIcon from './icons/DownloadIcon';
import ProcessingSpinnerIcon from './icons/ProcessingSpinnerIcon';
import { useSoraWatermarkRemoval } from '../hooks/useSoraWatermarkRemoval';
import { SoraRemovalQuality, WatermarkCoords } from '../types';

const QUALITY_OPTIONS: Array<{ value: SoraRemovalQuality; label: string; description: string }> = [
  { value: 'fast',     label: 'Fast',     description: '4 reference frames. Quickest, less robust on busy backgrounds.' },
  { value: 'balanced', label: 'Balanced', description: '8 reference frames. Best speed-quality trade-off.' },
  { value: 'high',     label: 'High',     description: '14 reference frames. Cleanest fill on dynamic scenes (slower).' },
];

interface PlaybackBoxProps {
  videoSrc: string | null;
  /** When provided, draws a tracking overlay on top of the playing video. */
  trajectory?: { time: number; bbox: WatermarkCoords }[];
  videoWidth?: number;
  videoHeight?: number;
  showOverlay?: boolean;
}

/** Plays a video and draws the interpolated watermark bbox over it. */
const PlaybackWithOverlay: React.FC<PlaybackBoxProps> = ({
  videoSrc, trajectory, videoWidth, videoHeight, showOverlay,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!showOverlay || !trajectory || trajectory.length === 0 || !videoWidth || !videoHeight) return;
    const tick = () => {
      const v = videoRef.current;
      const o = overlayRef.current;
      const c = containerRef.current;
      if (v && o && c && v.videoWidth > 0) {
        const t = v.currentTime;
        let lo = 0, hi = trajectory.length - 1;
        if (t <= trajectory[0].time) { lo = hi = 0; }
        else if (t >= trajectory[hi].time) { lo = hi; }
        else {
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (trajectory[m].time <= t) lo = m; else hi = m; }
        }
        const a = trajectory[lo], b = trajectory[hi];
        const span = Math.max(1e-6, b.time - a.time);
        const u = lo === hi ? 0 : Math.max(0, Math.min(1, (t - a.time) / span));
        const bx = a.bbox.x + (b.bbox.x - a.bbox.x) * u;
        const by = a.bbox.y + (b.bbox.y - a.bbox.y) * u;
        const bw = a.bbox.width + (b.bbox.width - a.bbox.width) * u;
        const bh = a.bbox.height + (b.bbox.height - a.bbox.height) * u;

        const rect = v.getBoundingClientRect();
        const cRect = c.getBoundingClientRect();
        const sx = rect.width / videoWidth;
        const sy = rect.height / videoHeight;
        o.style.left = `${rect.left - cRect.left + bx * sx}px`;
        o.style.top = `${rect.top - cRect.top + by * sy}px`;
        o.style.width = `${bw * sx}px`;
        o.style.height = `${bh * sy}px`;
        o.style.display = 'block';
      } else if (o) {
        o.style.display = 'none';
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [showOverlay, trajectory, videoWidth, videoHeight]);

  if (!videoSrc) {
    return (
      <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
        <p>Loading preview…</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full aspect-video bg-black rounded-lg overflow-hidden shadow-xl">
      <video
        ref={videoRef}
        src={videoSrc}
        controls
        loop
        autoPlay
        muted
        className="w-full h-full object-contain"
      />
      {showOverlay && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="pointer-events-none absolute hidden"
          style={{
            border: '2px solid #f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.18)',
            zIndex: 10,
          }}
        />
      )}
    </div>
  );
};

const SoraWatermarkRemover: React.FC = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [quality, setQuality] = useState<SoraRemovalQuality>('balanced');
  const [manualMode, setManualMode] = useState(false);
  const [manualRegion, setManualRegion] = useState<WatermarkCoords>({
    x: 20, y: 20, width: 200, height: 80,
  });

  const { state, detect, remove, cancelDetection, cancelRemoval, reset } = useSoraWatermarkRemoval();

  useEffect(() => {
    if (!videoFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(videoFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const handleFileSelect = (file: File) => {
    setVideoFile(file);
    setFileError(null);
    setVideoDuration(undefined);
    reset();

    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      if (isFinite(probe.duration)) setVideoDuration(probe.duration);
      // Seed manual region to a corner-ish default sized to the video.
      if (probe.videoWidth && probe.videoHeight) {
        const w = Math.round(probe.videoWidth * 0.12);
        const h = Math.round(probe.videoHeight * 0.06);
        setManualRegion({ x: 24, y: 24, width: Math.max(80, w), height: Math.max(40, h) });
      }
      URL.revokeObjectURL(probe.src);
    };
    probe.src = URL.createObjectURL(file);
  };

  const handleFileError = (error: string) => {
    setFileError(error);
    setVideoFile(null);
    reset();
  };

  const handleUploadDifferent = () => {
    setVideoFile(null);
    setFileError(null);
    reset();
  };

  const handleDetect = () => {
    if (!videoFile) return;
    detect(videoFile, manualMode ? manualRegion : undefined);
  };

  const handleRemove = () => {
    if (!videoFile) return;
    remove(videoFile, quality);
  };

  const detection = state.detection;
  const downloadName = useMemo(() => {
    const base = videoFile?.name.replace(/\.[^.]+$/, '') || 'video';
    const ext = state.processedMimeType?.includes('mp4') ? 'mp4' : 'webm';
    return `sora_clean_${base}.${ext}`;
  }, [videoFile, state.processedMimeType]);

  const busy = state.isDetecting || state.isRemoving;

  return (
    <div className="w-full space-y-6">
      {!videoFile ? (
        <>
          <VideoUploader
            onFileSelect={handleFileSelect}
            onFileError={handleFileError}
            disabled={busy}
          />
          {fileError && (
            <div className="bg-red-700 p-4 rounded-lg text-red-100">
              <p className="font-semibold">File Upload Error:</p>
              <p className="text-sm">{fileError}</p>
            </div>
          )}
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-sm text-gray-300">
            <p className="font-semibold text-gray-100 mb-2">What this does</p>
            <ul className="list-disc ml-5 space-y-1 text-gray-400">
              <li>Targets the bouncing white logo from <span className="text-white">Sora 2 / ChatGPT video</span> (and similar moving overlays).</li>
              <li>Tracks the watermark across the whole clip, then reconstructs each covered pixel from another moment in the video where the watermark wasn't there.</li>
              <li>Edges of the patched region are feathered for seamless blending.</li>
              <li>Works entirely in your browser — no upload, no server.</li>
            </ul>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">Original (with tracking overlay)</h4>
              <PlaybackWithOverlay
                videoSrc={previewUrl}
                trajectory={detection?.trajectory}
                videoWidth={detection?.videoWidth}
                videoHeight={detection?.videoHeight}
                showOverlay={!!detection?.detected}
              />
            </div>
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">
                {state.processedVideoUrl ? 'Watermark Removed' : 'Result'}
              </h4>
              <PlaybackWithOverlay videoSrc={state.processedVideoUrl ?? previewUrl} />
            </div>
          </div>

          <VideoInfo
            fileName={videoFile.name}
            fileSize={videoFile.size}
            fileType={videoFile.type}
            duration={videoDuration}
          />

          {/* Detection controls */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-lg space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-semibold text-gray-100">Sora Watermark Removal</h3>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={manualMode}
                  onChange={(e) => setManualMode(e.target.checked)}
                  disabled={busy}
                  className="accent-indigo-500"
                />
                Manual region
              </label>
            </div>

            {manualMode && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-gray-900 rounded-md border border-gray-700">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <label key={key} className="text-xs text-gray-300">
                    <span className="block mb-1 capitalize">{key}</span>
                    <input
                      type="number"
                      value={manualRegion[key]}
                      onChange={(e) => setManualRegion({
                        ...manualRegion,
                        [key]: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })}
                      disabled={busy}
                      className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-gray-100 disabled:opacity-50"
                    />
                  </label>
                ))}
                <p className="col-span-2 sm:col-span-4 text-xs text-gray-500">
                  Coordinates are in source video pixels. Skip auto-detection and use this exact region.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={handleDetect}
                disabled={busy}
                className="flex-1 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.isDetecting ? (
                  <>
                    <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                    {state.stageMessage || 'Detecting…'} ({state.progress}%)
                  </>
                ) : manualMode ? 'Use Manual Region' : 'Detect Sora Watermark'}
              </button>
              {state.isDetecting && (
                <button
                  onClick={cancelDetection}
                  className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
                >
                  Cancel
                </button>
              )}
            </div>

            {state.isDetecting && (
              <div className="w-full bg-gray-700 rounded-full h-2.5">
                <div className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${state.progress}%` }} />
              </div>
            )}

            {detection && !state.isDetecting && (
              <div className={`p-4 rounded-lg ${detection.detected ? 'bg-emerald-900 border-2 border-emerald-500' : 'bg-blue-900 border-2 border-blue-500'}`}>
                <h4 className="font-semibold text-lg mb-2">
                  {detection.detected ? '✓ Trajectory locked' : 'No moving watermark found'}
                </h4>
                {detection.detected ? (
                  <ul className="text-sm space-y-1 text-emerald-100">
                    <li>Samples tracked: {detection.trajectory.length}</li>
                    <li>Average confidence: {detection.averageConfidence}%</li>
                    <li>Frame size: {detection.videoWidth} × {detection.videoHeight}</li>
                  </ul>
                ) : (
                  <p className="text-sm text-blue-100">{detection.message}</p>
                )}
              </div>
            )}

            {/* Quality + run */}
            {detection?.detected && (
              <div className="space-y-3 pt-3 border-t border-gray-700">
                <div>
                  <label htmlFor="soraQuality" className="block text-sm font-medium text-gray-300 mb-1">
                    Reconstruction quality
                  </label>
                  <select
                    id="soraQuality"
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as SoraRemovalQuality)}
                    disabled={busy}
                    className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md text-gray-100 disabled:opacity-50"
                  >
                    {QUALITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label} — {opt.description}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    onClick={handleRemove}
                    disabled={busy}
                    className="flex-1 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {state.isRemoving ? (
                      <>
                        <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                        {state.stageMessage || 'Removing…'} ({state.progress}%)
                      </>
                    ) : 'Remove Watermark'}
                  </button>
                  {state.isRemoving && (
                    <button
                      onClick={cancelRemoval}
                      className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {state.isRemoving && (
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${state.progress}%` }} />
                  </div>
                )}
              </div>
            )}

            {state.error && (
              <div className="bg-red-700 p-4 rounded-lg text-red-100">
                <p className="font-semibold">Error:</p>
                <p className="text-sm">{state.error}</p>
              </div>
            )}

            {state.processedVideoUrl && !state.isRemoving && (
              <div className="bg-emerald-700 p-4 rounded-lg">
                <h4 className="text-lg font-semibold text-emerald-100 mb-2">Watermark removed!</h4>
                <p className="text-sm text-emerald-200 mb-3">
                  Your processed video is ready ({state.processedMimeType?.includes('mp4') ? 'MP4' : 'WEBM'}).
                </p>
                <a
                  href={state.processedVideoUrl}
                  download={downloadName}
                  className="w-full px-6 py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200"
                >
                  <DownloadIcon className="w-5 h-5 mr-2" />
                  Download Clean Video
                </a>
              </div>
            )}

            <button
              onClick={handleUploadDifferent}
              disabled={busy}
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

export default SoraWatermarkRemover;
