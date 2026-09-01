import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoUploader from './VideoUploader';
import VideoInfo from './VideoInfo';
import DownloadIcon from './icons/DownloadIcon';
import ProcessingSpinnerIcon from './icons/ProcessingSpinnerIcon';
import { useSoraWatermarkRemoval } from '../hooks/useSoraWatermarkRemoval';
import { SoraDwell, SoraFillMode, SoraRemovalQuality, WatermarkCoords } from '../types';
import { boxAtTime, describeMimeType, snapBoxToClick } from '../services/soraWatermarkService';

const QUALITY_OPTIONS: Array<{ value: SoraRemovalQuality; label: string; description: string }> = [
  { value: 'fast',     label: 'Fast',     description: '4 reference frames — quickest, weaker on busy backgrounds.' },
  { value: 'balanced', label: 'Balanced', description: '10 reference frames — good speed/quality trade-off.' },
  { value: 'high',     label: 'High',     description: '18 reference frames — cleanest fill on moving scenes.' },
];

const FILL_OPTIONS: Array<{ value: SoraFillMode; label: string; description: string }> = [
  { value: 'auto',     label: 'Auto',              description: 'Borrow real pixels when a clean donor frame exists, otherwise inpaint.' },
  { value: 'temporal', label: 'Borrow from frame', description: 'Take pixels from a moment when the watermark was elsewhere. Sharpest when the background is still.' },
  { value: 'inpaint',  label: 'Inpaint edges',     description: 'Rebuild from the surrounding pixels. Never ghosts, but softer over detail.' },
];

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
}

interface VideoStageProps {
  src: string | null;
  dwells?: SoraDwell[];
  padding?: number;
  showOverlay?: boolean;
  onPickPoint?: (videoX: number, videoY: number, time: number, video: HTMLVideoElement) => void;
  onTimeUpdate?: (time: number) => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  placeholder?: string;
}

const VideoStage: React.FC<VideoStageProps> = ({
  src, dwells, padding = 10, showOverlay, onPickPoint, onTimeUpdate, videoRef, placeholder,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const video = videoRef ?? localRef;
  // Canvas overlay — avoids getBoundingClientRect on the video element entirely.
  // We compute object-contain scale from clientWidth/clientHeight and draw in
  // video-pixel coordinates with a matching transform. This is immune to the
  // letterbox coordinate errors the old div overlay had.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastReportedTime = useRef(0);
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const v = video.current;
      const c = containerRef.current;
      const cvs = canvasRef.current;
      if (!v || !c) return;

      if (onTimeUpdate && Math.abs(v.currentTime - lastReportedTime.current) > 0.1) {
        lastReportedTime.current = v.currentTime;
        onTimeUpdate(v.currentTime);
      }

      if (!cvs) return;
      const ctx = cvs.getContext('2d');
      if (!ctx) return;

      const containerW = c.clientWidth;
      const containerH = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(containerW * dpr));
      const H = Math.max(1, Math.round(containerH * dpr));
      if (cvs.width !== W || cvs.height !== H) {
        cvs.width = W;
        cvs.height = H;
      }
      ctx.clearRect(0, 0, W, H);

      if (!showOverlay || !dwells || dwells.length === 0 || !v.videoWidth || !v.videoHeight) return;

      const box = boxAtTime(dwells, v.currentTime, padding, v.videoWidth, v.videoHeight);
      if (!box) return;

      // Replicate object-contain: scale to fill whichever axis is tighter.
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const scale = Math.min(W / vw, H / vh);
      const ox = (W - vw * scale) / 2; // horizontal letterbox offset
      const oy = (H - vh * scale) / 2; // vertical letterbox offset

      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, ox, oy);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2 / scale;
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3 / scale;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.restore();
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [showOverlay, dwells, padding, onTimeUpdate, video]);

  // Click handler: converts click to video-pixel coordinates using the same
  // object-contain math as the canvas overlay.
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onPickPoint) return;
    const v = video.current;
    const c = containerRef.current;
    if (!v || !c || !v.videoWidth || !v.videoHeight) return;

    const containerW = c.clientWidth;
    const containerH = c.clientHeight;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const scale = Math.min(containerW / vw, containerH / vh);
    const ox = (containerW - vw * scale) / 2;
    const oy = (containerH - vh * scale) / 2;

    const cRect = c.getBoundingClientRect();
    const cx = e.clientX - cRect.left;
    const cy = e.clientY - cRect.top;

    const x = (cx - ox) / scale;
    const y = (cy - oy) / scale;
    if (x < 0 || y < 0 || x > vw || y > vh) return;

    onPickPoint(x, y, v.currentTime, v);
  }, [onPickPoint, video]);

  if (!src) {
    return (
      <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500">
        <p>{placeholder ?? 'Loading preview…'}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full bg-black rounded-lg overflow-hidden shadow-xl mx-auto"
      style={{ aspectRatio: aspect ? `${aspect}` : '16 / 9', maxHeight: '58vh' }}
    >
      <video
        ref={video}
        src={src}
        controls
        loop
        autoPlay
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (el.videoWidth && el.videoHeight) setAspect(el.videoWidth / el.videoHeight);
        }}
        className="w-full h-full object-contain"
      />
      {/* Canvas overlay: drawn in video-pixel coordinates, immune to letterbox bugs */}
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      />
      {onPickPoint && (
        <div
          onClick={handleClick}
          className="absolute inset-x-0 top-0 cursor-crosshair"
          style={{ bottom: '3.5rem', zIndex: 15 }}
          aria-label="Click the watermark to set its position"
        />
      )}
    </div>
  );
};

/** Horizontal map of where the watermark sits over the clip's duration. */
const DwellTimeline: React.FC<{
  dwells: SoraDwell[];
  duration: number;
  currentTime: number;
  corrections: { id: string; time: number }[];
  onSeek: (time: number) => void;
}> = ({ dwells, duration, currentTime, corrections, onSeek }) => {
  if (duration <= 0) return null;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
        <span>Watermark positions over time</span>
        <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
      </div>
      <div
        className="relative h-8 w-full bg-gray-900 rounded-md border border-gray-700 overflow-hidden cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - rect.left) / rect.width) * duration);
        }}
        role="presentation"
      >
        {dwells.map((dwell, i) => (
          <div
            key={`${dwell.startTime}-${i}`}
            className={`absolute top-0 bottom-0 border-r border-gray-900 ${
              dwell.source === 'manual' ? 'bg-emerald-600/70' : 'bg-indigo-600/60'
            }`}
            style={{ left: pct(dwell.startTime), width: pct(dwell.endTime - dwell.startTime) }}
            title={`${dwell.source === 'manual' ? 'Manual' : 'Detected'} · ${formatTime(dwell.startTime)}–${formatTime(dwell.endTime)} · ${dwell.confidence}% confidence`}
          />
        ))}
        {corrections.map((c) => (
          <div
            key={c.id}
            className="absolute top-0 bottom-0 w-0.5 bg-emerald-300"
            style={{ left: pct(c.time) }}
            title={`Your correction at ${formatTime(c.time)}`}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white"
          style={{ left: pct(currentTime) }}
        />
      </div>
      <div className="flex gap-4 mt-1 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 bg-indigo-600/60 rounded-sm" /> detected</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 bg-emerald-600/70 rounded-sm" /> your correction</span>
        <span>click to seek</span>
      </div>
    </div>
  );
};

const SoraWatermarkRemover: React.FC = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);
  const [quality, setQuality] = useState<SoraRemovalQuality>('balanced');
  const [fillMode, setFillMode] = useState<SoraFillMode>('auto');
  const [correcting, setCorrecting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const sourceVideoRef = useRef<HTMLVideoElement>(null);

  const {
    state, timeline, preview, isPreviewing,
    detect, remove, addCorrection, removeCorrection, clearCorrections,
    previewFill, clearPreview, cancelDetection, cancelRemoval, reset,
  } = useSoraWatermarkRemoval();

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
    setCorrecting(false);
    setCurrentTime(0);
    setLastAction(null);
    reset();

    const probe = document.createElement('video');
    const probeUrl = URL.createObjectURL(file);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      if (isFinite(probe.duration)) setVideoDuration(probe.duration);
      URL.revokeObjectURL(probeUrl);
    };
    probe.onerror = () => URL.revokeObjectURL(probeUrl);
    probe.src = probeUrl;
  };

  const handleFileError = (error: string) => {
    setFileError(error);
    setVideoFile(null);
    reset();
  };

  const handleUploadDifferent = () => {
    setVideoFile(null);
    setFileError(null);
    setCorrecting(false);
    reset();
  };

  // When detection finishes with no result, turn on click-to-fix automatically
  // so the user can just click the watermark without having to find the toggle.
  const prevDetecting = useRef(false);
  useEffect(() => {
    if (prevDetecting.current && !state.isDetecting) {
      // Detection just finished
      if (state.detection && !state.detection.detected) {
        setCorrecting(true);
        setLastAction('Auto-detect found nothing. Click directly on the watermark in the video to place it manually.');
      }
    }
    prevDetecting.current = state.isDetecting;
  }, [state.isDetecting, state.detection]);

  const handlePickPoint = useCallback((x: number, y: number, time: number, video: HTMLVideoElement) => {
    video.pause();
    const box: WatermarkCoords = snapBoxToClick(video, x, y, state.detection?.logoSize ?? null);
    addCorrection(time, box);
    clearPreview();
    setLastAction(`Watermark position set at ${formatTime(time)} — amber box should now sit on the mark.`);
  }, [addCorrection, clearPreview, state.detection]);

  const seekTo = useCallback((time: number) => {
    const v = sourceVideoRef.current;
    if (v) v.currentTime = Math.max(0, Math.min(time, v.duration || time));
  }, []);

  const detection = state.detection;
  const busy = state.isDetecting || state.isRemoving;
  const hasTimeline = timeline.length > 0;

  const downloadName = useMemo(() => {
    const base = videoFile?.name.replace(/\.[^.]+$/, '') || 'video';
    const ext = state.processedMimeType?.includes('mp4') ? 'mp4' : 'webm';
    return `sora_clean_${base}.${ext}`;
  }, [videoFile, state.processedMimeType]);

  const currentBox = useMemo(() => {
    if (!hasTimeline || !detection) return null;
    return boxAtTime(timeline, currentTime, detection.padding, detection.videoWidth, detection.videoHeight);
  }, [hasTimeline, timeline, currentTime, detection]);

  return (
    <div className="w-full space-y-6">
      {!videoFile ? (
        <>
          <VideoUploader onFileSelect={handleFileSelect} onFileError={handleFileError} disabled={busy} />
          {fileError && (
            <div className="bg-red-700 p-4 rounded-lg text-red-100">
              <p className="font-semibold">File Upload Error:</p>
              <p className="text-sm">{fileError}</p>
            </div>
          )}
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-sm text-gray-300">
            <p className="font-semibold text-gray-100 mb-2">How this works</p>
            <ol className="list-decimal ml-5 space-y-1 text-gray-400">
              <li><span className="text-gray-200">Detect</span> — samples frames and tracks where the watermark sits over time.</li>
              <li><span className="text-gray-200">Correct</span> — if the amber box is off, click directly on the watermark to fix it.</li>
              <li><span className="text-gray-200">Preview the fill</span> — compare fill methods on a single frame before committing.</li>
              <li><span className="text-gray-200">Remove</span> — rebuilds the clip at high bitrate, MP4 where the browser allows it.</li>
            </ol>
            <p className="text-gray-500 mt-2">Everything runs in your browser. Nothing is uploaded.</p>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">
                Original
                {hasTimeline && <span className="text-sm font-normal text-amber-400"> · amber box = watermark region</span>}
                {correcting && <span className="text-sm font-normal text-emerald-400"> · click the watermark</span>}
              </h4>
              <VideoStage
                src={previewUrl}
                dwells={timeline}
                padding={detection?.padding ?? 10}
                showOverlay={hasTimeline}
                onPickPoint={correcting ? handlePickPoint : undefined}
                onTimeUpdate={setCurrentTime}
                videoRef={sourceVideoRef}
              />
            </div>
            <div>
              <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">
                {state.processedVideoUrl ? 'Watermark removed' : 'Result'}
              </h4>
              <VideoStage
                src={state.processedVideoUrl}
                placeholder="Run removal to see the result here"
              />
            </div>
          </div>

          {hasTimeline && videoDuration !== undefined && (
            <div className="bg-gray-800 p-4 rounded-lg shadow-lg">
              <DwellTimeline
                dwells={timeline}
                duration={videoDuration}
                currentTime={currentTime}
                corrections={state.corrections}
                onSeek={seekTo}
              />
            </div>
          )}

          <VideoInfo
            fileName={videoFile.name}
            fileSize={videoFile.size}
            fileType={videoFile.type}
            duration={videoDuration}
          />

          <div className="bg-gray-800 p-6 rounded-lg shadow-lg space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-xl font-semibold text-gray-100">Sora Watermark Removal</h3>
              <button
                onClick={handleUploadDifferent}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md bg-yellow-600 hover:bg-yellow-700 text-white font-medium transition-colors disabled:opacity-50"
              >
                Upload different video
              </button>
            </div>

            {/* Step 1 — detect */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => videoFile && detect(videoFile)}
                disabled={busy}
                className="flex-1 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state.isDetecting ? (
                  <>
                    <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                    {state.stageMessage || 'Detecting…'} ({state.progress}%)
                  </>
                ) : detection ? 'Re-run detection' : '1. Detect Sora watermark'}
              </button>
              {state.isDetecting && (
                <button
                  onClick={cancelDetection}
                  className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>

            {detection && detection.detected && (
              <div className="bg-gray-900 border border-emerald-700 rounded-lg p-4 text-sm">
                <p className="text-emerald-300 font-semibold mb-2">
                  Tracked {detection.dwells.length} position{detection.dwells.length === 1 ? '' : 's'}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-gray-300">
                  <div><span className="block text-xs text-gray-500">Frames analysed</span>{detection.samplesAnalyzed}</div>
                  <div><span className="block text-xs text-gray-500">Confidence</span>{detection.averageConfidence}%</div>
                  <div><span className="block text-xs text-gray-500">Clip covered</span>{Math.round(detection.coverage * 100)}%</div>
                  <div>
                    <span className="block text-xs text-gray-500">Mark size</span>
                    {detection.logoSize ? `${detection.logoSize.width}×${detection.logoSize.height}px` : '—'}
                  </div>
                </div>
              </div>
            )}

            {detection && !detection.detected && (
              <div className="bg-amber-900/40 border border-amber-700 rounded-lg p-4 text-sm">
                <p className="text-amber-300 font-semibold mb-1">Auto-detect found nothing</p>
                <p className="text-amber-200/80">
                  Click-to-fix is now on — click directly on the watermark in the video above.
                  The amber box will appear and you can then remove it.
                </p>
              </div>
            )}

            {/* Step 2 — correct */}
            <div className="border-t border-gray-700 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                <h4 className="font-semibold text-gray-100">2. Fix the position (optional)</h4>
                <button
                  onClick={() => { setCorrecting(!correcting); setLastAction(null); }}
                  disabled={busy}
                  className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 ${
                    correcting ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                  }`}
                >
                  {correcting ? 'Click-to-fix: ON' : 'Click-to-fix: OFF'}
                </button>
              </div>
              <p className="text-sm text-gray-400">
                {correcting
                  ? 'Click directly on the watermark in the video. The video pauses so you can verify the amber box is correct.'
                  : 'Turn this on if the amber box is off-target, then click the watermark in the video.'}
              </p>
              {lastAction && <p className="text-sm text-emerald-400 mt-2" role="status">{lastAction}</p>}

              {state.corrections.length > 0 && (
                <div className="mt-3 space-y-2">
                  {state.corrections
                    .slice()
                    .sort((a, b) => a.time - b.time)
                    .map((c) => (
                      <div key={c.id} className="flex items-center gap-2 text-sm bg-gray-900 border border-gray-700 rounded-md px-3 py-2">
                        <button
                          onClick={() => seekTo(c.time)}
                          className="text-emerald-300 hover:text-emerald-200 font-mono"
                        >
                          {formatTime(c.time)}
                        </button>
                        <span className="text-gray-500 text-xs">
                          {c.bbox.width}×{c.bbox.height} at ({c.bbox.x}, {c.bbox.y})
                        </span>
                        <button
                          onClick={() => removeCorrection(c.id)}
                          disabled={busy}
                          className="ml-auto px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  <button
                    onClick={clearCorrections}
                    disabled={busy}
                    className="text-xs text-gray-400 hover:text-gray-200 underline disabled:opacity-50"
                  >
                    Clear all corrections
                  </button>
                </div>
              )}
            </div>

            {/* Step 3 — fill method + preview */}
            <div className="border-t border-gray-700 pt-4">
              <h4 className="font-semibold text-gray-100 mb-2">3. Choose how the area is filled</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {FILL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => { setFillMode(opt.value); clearPreview(); }}
                    disabled={busy}
                    className={`text-left p-3 rounded-lg border transition-colors disabled:opacity-50 ${
                      fillMode === opt.value
                        ? 'border-indigo-500 bg-indigo-600/20'
                        : 'border-gray-700 bg-gray-900 hover:border-gray-600'
                    }`}
                  >
                    <div className="font-semibold text-sm text-gray-100">{opt.label}</div>
                    <div className="text-xs text-gray-400 mt-1">{opt.description}</div>
                  </button>
                ))}
              </div>

              <button
                onClick={() => videoFile && previewFill(videoFile, currentTime, fillMode)}
                disabled={busy || isPreviewing || !hasTimeline}
                className="mt-3 w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                {isPreviewing ? (
                  <><ProcessingSpinnerIcon className="w-4 h-4 mr-2" /> Rendering preview…</>
                ) : (
                  `Preview fill on current frame (${formatTime(currentTime)})`
                )}
              </button>

              {preview && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <figure>
                    <figcaption className="text-xs text-gray-400 mb-1 text-center">Before</figcaption>
                    <img src={preview.beforeUrl} alt="Region before removal" className="w-full rounded-md border border-gray-700 bg-black" />
                  </figure>
                  <figure>
                    <figcaption className="text-xs text-gray-400 mb-1 text-center">After ({FILL_OPTIONS.find((o) => o.value === fillMode)?.label})</figcaption>
                    <img src={preview.afterUrl} alt="Region after removal" className="w-full rounded-md border border-emerald-700 bg-black" />
                  </figure>
                </div>
              )}
              {currentBox && (
                <p className="text-xs text-gray-500 mt-2">
                  Region at this moment: {currentBox.width}×{currentBox.height}px at ({currentBox.x}, {currentBox.y}).
                </p>
              )}
            </div>

            {/* Step 4 — remove */}
            <div className="border-t border-gray-700 pt-4 space-y-3">
              <h4 className="font-semibold text-gray-100">4. Remove and export</h4>
              {fillMode !== 'inpaint' && (
                <div>
                  <label htmlFor="soraQuality" className="block text-sm text-gray-300 mb-1">Reference frames</label>
                  <select
                    id="soraQuality"
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as SoraRemovalQuality)}
                    disabled={busy}
                    className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md text-gray-100 disabled:opacity-50"
                  >
                    {QUALITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label} — {o.description}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => videoFile && remove(videoFile, quality, fillMode)}
                  disabled={busy || !hasTimeline}
                  className="flex-1 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {state.isRemoving ? (
                    <>
                      <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                      {state.stageMessage || 'Removing…'} ({state.progress}%)
                    </>
                  ) : 'Remove watermark'}
                </button>
                {state.isRemoving && (
                  <button
                    onClick={cancelRemoval}
                    className="px-4 py-3 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors"
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

              {!hasTimeline && !state.isDetecting && (
                <p className="text-sm text-gray-400">
                  Run detection first — or turn on Click-to-fix and click the watermark to place it yourself.
                </p>
              )}
            </div>

            {state.error && (
              <div className="bg-red-900/60 border border-red-700 p-4 rounded-lg text-red-100 text-sm" role="alert">
                {state.error}
              </div>
            )}

            {state.processedVideoUrl && !state.isRemoving && (
              <div className="bg-green-700 p-5 rounded-lg shadow-lg">
                <h4 className="text-lg font-semibold text-green-100 mb-1">Ready</h4>
                <p className="text-sm text-green-200 mb-3">
                  Exported as {describeMimeType(state.processedMimeType)} at high bitrate.
                </p>
                <a
                  href={state.processedVideoUrl}
                  download={downloadName}
                  className="w-full px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors"
                >
                  <DownloadIcon className="w-5 h-5 mr-2" />
                  Download cleaned video
                </a>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SoraWatermarkRemover;
