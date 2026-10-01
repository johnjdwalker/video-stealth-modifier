import React, { useCallback, useMemo, useRef, useState } from 'react';
import { UseTimeline } from '../hooks/useTimeline';
import {
  clipEffectiveDuration,
  formatTimelineTime,
} from '../utils/timeline';

interface TimelineProps {
  timeline: UseTimeline;
  currentTime: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: () => void;
  onAddFiles: (files: File[]) => void;
  addError: string | null;
  disabled?: boolean;
  /** Silence detection across clips (App-owned). */
  onDetectSilences: () => void;
  isDetectingSilences: boolean;
  silenceCount: number | null;
  skipSilences: boolean;
  onToggleSkipSilences: (v: boolean) => void;
}

const MIN_PX_PER_SEC = 24;
const MAX_PX_PER_SEC = 260;
const DEFAULT_PX_PER_SEC = 90;
const RULER_HEIGHT = 26;

/** Pick a tick step so labels stay ~70px+ apart. */
function tickStep(pxPerSec: number): number {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (s * pxPerSec >= 70) return s;
  }
  return 600;
}

interface TrimDrag {
  id: string;
  edge: 'start' | 'end';
  startX: number;
  origStart: number | null;
  origEnd: number | null;
  moved: boolean;
}

/**
 * The multi-clip track: clips as draggable blocks with trim handles,
 * a playhead, a time ruler, and zoom. Reorder is HTML5 drag-and-drop;
 * trim handles use pointer capture for pixel-accurate in/out points.
 */
const Timeline: React.FC<TimelineProps> = ({
  timeline,
  currentTime,
  selectedId,
  onSelect,
  onSeek,
  onSplitAtPlayhead,
  onDeleteSelected,
  onAddFiles,
  addError,
  disabled,
  onDetectSilences,
  isDetectingSilences,
  silenceCount,
  skipSilences,
  onToggleSkipSilences,
}) => {
  const { clips, totalDuration } = timeline;
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [trimDrag, setTrimDrag] = useState<TrimDrag | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const trimDragRef = useRef<TrimDrag | null>(null);
  trimDragRef.current = trimDrag;
  const pxPerSecRef = useRef(pxPerSec);
  pxPerSecRef.current = pxPerSec;
  const suppressClickRef = useRef(false);

  const trackWidth = Math.max(200, totalDuration * pxPerSec);

  // ---- trim handles -------------------------------------------------------
  const onTrimPointerMove = useCallback((e: PointerEvent) => {
    const drag = trimDragRef.current;
    if (!drag) return;
    const dxSec = (e.clientX - drag.startX) / pxPerSecRef.current;
    if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
    const clip = timeline.clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const baseStart = drag.origStart ?? 0;
    const baseEnd = drag.origEnd ?? clip.duration;
    if (drag.edge === 'start') {
      timeline.updateClipTrim(drag.id, baseStart + dxSec, drag.origEnd);
    } else {
      timeline.updateClipTrim(drag.id, drag.origStart, baseEnd + dxSec);
    }
  }, [timeline]);

  const endTrimDrag = useCallback(() => {
    const drag = trimDragRef.current;
    if (drag) {
      // Suppress the click that pointer-up would otherwise fire on the handle.
      if (drag.moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
    }
    setTrimDrag(null);
    window.removeEventListener('pointermove', onTrimPointerMove);
    window.removeEventListener('pointerup', endTrimDrag);
    window.removeEventListener('pointercancel', endTrimDrag);
  }, [onTrimPointerMove]);

  const beginTrimDrag = (e: React.PointerEvent, id: string, edge: 'start' | 'end') => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    const clip = clips.find((c) => c.id === id);
    if (!clip) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setTrimDrag({
      id,
      edge,
      startX: e.clientX,
      origStart: clip.trimStart,
      origEnd: clip.trimEnd,
      moved: false,
    });
    window.addEventListener('pointermove', onTrimPointerMove);
    window.addEventListener('pointerup', endTrimDrag);
    window.addEventListener('pointercancel', endTrimDrag);
  };

  // ---- reorder (HTML5 DnD) --------------------------------------------------
  const handleClipDragStart = (e: React.DragEvent, id: string) => {
    if (disabled) return;
    e.dataTransfer.setData('text/timeline-clip-id', id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
  };
  const handleClipDragEnd = () => {
    setDragId(null);
    setDropIndex(null);
  };
  const handleClipDragOver = (e: React.DragEvent, index: number) => {
    if (disabled || !e.dataTransfer.types.includes('text/timeline-clip-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    setDropIndex(after ? index + 1 : index);
  };
  const handleTrackDrop = (e: React.DragEvent) => {
    if (disabled) return;
    const id = e.dataTransfer.getData('text/timeline-clip-id');
    if (id && dropIndex !== null) {
      e.preventDefault();
      timeline.moveClip(id, dropIndex > clips.findIndex((c) => c.id === id) ? dropIndex - 1 : dropIndex);
    }
    setDragId(null);
    setDropIndex(null);
  };

  // ---- file drop ------------------------------------------------------------
  const handleFileDragOver = (e: React.DragEvent) => {
    if (disabled) return;
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsFileDragOver(true);
    }
  };
  const handleFileDrop = (e: React.DragEvent) => {
    if (disabled) return;
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsFileDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) onAddFiles(files);
    }
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || trimDragRef.current) return;
    const inner = e.currentTarget;
    const rect = inner.getBoundingClientRect();
    const t = (e.clientX - rect.left) / pxPerSec;
    onSelect(null);
    onSeek(Math.max(0, Math.min(totalDuration, t)));
  };

  const rulerTicks = useMemo(() => {
    const step = tickStep(pxPerSec);
    const ticks: number[] = [];
    for (let t = 0; t <= totalDuration + 0.001; t += step) ticks.push(t);
    return ticks;
  }, [pxPerSec, totalDuration]);

  const selectedClip = clips.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="bg-gray-800 rounded-lg shadow-lg p-4">
      <input
        type="file"
        accept="video/*"
        multiple
        ref={fileInputRef}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) onAddFiles(files);
        }}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || timeline.isProbing}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {timeline.isProbing ? 'Reading clips…' : '+ Add clips'}
        </button>
        <button
          type="button"
          onClick={onSplitAtPlayhead}
          disabled={disabled || clips.length === 0}
          title="Split the clip under the playhead into two"
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          ✂ Split at playhead
        </button>
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={disabled || !selectedClip}
          title="Remove the selected clip"
          className="px-4 py-2 bg-gray-700 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          🗑 Delete{selectedClip ? ` (${selectedClip.name.slice(0, 12)}…)` : ''}
        </button>

        <div className="flex items-center gap-2 ml-1 pl-3 border-l border-gray-700">
          <button
            type="button"
            onClick={onDetectSilences}
            disabled={disabled || clips.length === 0 || isDetectingSilences}
            title="Find dead air in every clip and cut it from the export"
            className="px-4 py-2 bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {isDetectingSilences ? 'Listening…' : silenceCount != null ? `🔇 Silence ×${silenceCount}` : '🔇 Remove silence'}
          </button>
          {silenceCount != null && silenceCount > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipSilences}
                onChange={(e) => onToggleSkipSilences(e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 accent-teal-500"
              />
              Cut it
            </label>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.max(MIN_PX_PER_SEC, z / 1.4))}
            disabled={disabled}
            className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg"
            aria-label="Zoom timeline out"
          >
            −
          </button>
          <input
            type="range"
            min={MIN_PX_PER_SEC}
            max={MAX_PX_PER_SEC}
            value={pxPerSec}
            disabled={disabled}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="w-28 accent-indigo-500"
            aria-label="Timeline zoom"
          />
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.min(MAX_PX_PER_SEC, z * 1.4))}
            disabled={disabled}
            className="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded-lg"
            aria-label="Zoom timeline in"
          >
            +
          </button>
          <span className="text-sm text-gray-400 font-mono whitespace-nowrap">
            {formatTimelineTime(totalDuration)} total
          </span>
        </div>
      </div>

      {addError && (
        <div className="mb-3 px-3 py-2 bg-red-900/60 border border-red-700 rounded-lg text-red-200 text-sm whitespace-pre-line">
          {addError}
        </div>
      )}

      {clips.length === 0 ? (
        <div
          onDragOver={handleFileDragOver}
          onDragLeave={() => setIsFileDragOver(false)}
          onDrop={handleFileDrop}
          onClick={() => !disabled && fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
            isFileDragOver ? 'border-indigo-400 bg-indigo-900/20' : 'border-gray-600 hover:border-indigo-500'
          }`}
        >
          <p className="text-gray-300 font-medium text-lg">
            {isFileDragOver ? 'Drop videos to add them' : 'Drop videos here, or click to browse'}
          </p>
          <p className="text-gray-500 text-sm mt-1">
            Add as many clips as you like — drag to reorder, drag the edges to trim, ✂ to split.
          </p>
        </div>
      ) : (
        <div
          ref={trackRef}
          className={`overflow-x-auto rounded-lg bg-gray-900 p-2 ${isFileDragOver ? 'ring-2 ring-indigo-400' : ''}`}
          onDragOver={handleFileDragOver}
          onDragLeave={() => setIsFileDragOver(false)}
          onDrop={handleFileDrop}
        >
          <div style={{ width: trackWidth }} className="relative select-none">
            {/* Ruler */}
            <div
              className="relative text-gray-500"
              style={{ height: RULER_HEIGHT }}
              onClick={(e) => {
                if (disabled) return;
                const rect = e.currentTarget.getBoundingClientRect();
                onSeek(Math.max(0, Math.min(totalDuration, (e.clientX - rect.left) / pxPerSec)));
              }}
            >
              {rulerTicks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 bottom-0 border-l border-gray-700"
                  style={{ left: t * pxPerSec }}
                >
                  <span className="ml-1 text-[10px] font-mono">{formatTimelineTime(t)}</span>
                </div>
              ))}
              {/* Playhead (ruler segment) */}
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
                style={{ left: Math.min(totalDuration, currentTime) * pxPerSec }}
              >
                <div className="w-2.5 h-2.5 bg-red-500 rotate-45 -translate-x-[5px] -translate-y-[2px]" />
              </div>
            </div>

            {/* Track */}
            <div
              className="relative flex items-stretch gap-1 mt-1"
              style={{ minHeight: 76 }}
              onClick={handleTrackClick}
              onDragOver={(e) => {
                // Reorder drops land here when not over a clip. Clips stop
                // this via their own handler; without the target check the
                // bubble would clobber the per-clip insertion indicator.
                if (e.target !== e.currentTarget) return;
                if (e.dataTransfer.types.includes('text/timeline-clip-id')) {
                  e.preventDefault();
                  setDropIndex(clips.length);
                }
              }}
              onDrop={handleTrackDrop}
            >
              {clips.map((clip, index) => {
                const effDur = clipEffectiveDuration(clip);
                const trimStart = clip.trimStart ?? 0;
                const fullW = clip.duration * pxPerSec;
                const activeX = trimStart * pxPerSec;
                const activeW = Math.max(8, effDur * pxPerSec);
                const isSelected = clip.id === selectedId;
                const isDragging = clip.id === dragId;
                return (
                  <React.Fragment key={clip.id}>
                    {dropIndex === index && dragId && (
                      <div className="w-1 self-stretch bg-indigo-400 rounded-full shrink-0" aria-hidden="true" />
                    )}
                    <div
                      draggable={!disabled}
                      onDragStart={(e) => handleClipDragStart(e, clip.id)}
                      onDragEnd={handleClipDragEnd}
                      onDragOver={(e) => handleClipDragOver(e, index)}
                      onClick={(e) => {
                        if (suppressClickRef.current) return;
                        e.stopPropagation();
                        onSelect(clip.id);
                      }}
                      title={`${clip.name} — ${formatTimelineTime(effDur)} (drag to reorder, drag edges to trim)`}
                      className={`relative rounded-md overflow-hidden shrink-0 border-2 transition-opacity ${
                        isSelected ? 'border-indigo-400' : 'border-gray-700 hover:border-gray-500'
                      } ${isDragging ? 'opacity-40' : ''} ${disabled ? '' : 'cursor-grab'}`}
                      style={{ width: fullW, minWidth: 24, height: 76 }}
                    >
                      {/* Thumbnail base (full source) */}
                      {clip.thumbnail ? (
                        <img
                          src={clip.thumbnail}
                          alt=""
                          draggable={false}
                          className="absolute inset-0 w-full h-full object-cover opacity-40"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gray-700" />
                      )}
                      {/* Trimmed-away dimming */}
                      <div className="absolute inset-y-0 left-0 bg-black/60" style={{ width: activeX }} />
                      <div
                        className="absolute inset-y-0 right-0 bg-black/60"
                        style={{ width: Math.max(0, fullW - activeX - activeW) }}
                      />
                      {/* Active region label */}
                      <div
                        className="absolute inset-y-0 flex flex-col justify-center px-2 overflow-hidden"
                        style={{ left: activeX, width: activeW }}
                      >
                        <span className="text-[11px] font-medium text-white truncate drop-shadow">
                          {index + 1}. {clip.name}
                        </span>
                        <span className="text-[10px] text-gray-300 font-mono">
                          {formatTimelineTime(effDur)}
                        </span>
                      </div>
                      {/* Trim handles */}
                      {!disabled && (
                        <>
                          <div
                            role="slider"
                            aria-label={`Trim start of ${clip.name}`}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(clip.duration)}
                            aria-valuenow={Math.round(trimStart)}
                            onPointerDown={(e) => beginTrimDrag(e, clip.id, 'start')}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute inset-y-0 left-0 w-3 cursor-ew-resize bg-indigo-500/70 hover:bg-indigo-400 z-10 touch-none"
                            style={{ left: activeX - 1 }}
                          />
                          <div
                            role="slider"
                            aria-label={`Trim end of ${clip.name}`}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(clip.duration)}
                            aria-valuenow={Math.round(trimStart + effDur)}
                            onPointerDown={(e) => beginTrimDrag(e, clip.id, 'end')}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute inset-y-0 w-3 cursor-ew-resize bg-indigo-500/70 hover:bg-indigo-400 z-10 touch-none"
                            style={{ left: activeX + activeW - 11 }}
                          />
                        </>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
              {dropIndex === clips.length && dragId && (
                <div className="w-1 self-stretch bg-indigo-400 rounded-full shrink-0" aria-hidden="true" />
              )}
              {/* Playhead (track segment) */}
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
                style={{ left: Math.min(totalDuration, currentTime) * pxPerSec }}
              />
            </div>
          </div>
        </div>
      )}

      {selectedClip && (
        <p className="mt-2 text-xs text-gray-400">
          Selected: <span className="text-gray-200 font-medium">{selectedClip.name}</span>
          {' '}— drag the indigo edges to trim, drag the block to reorder, ✂ splits at the playhead, 🗑 removes it.
        </p>
      )}
      {timeline.isProbing && (
        <p className="mt-2 text-xs text-indigo-300">Reading video files…</p>
      )}
    </div>
  );
};

export default Timeline;
