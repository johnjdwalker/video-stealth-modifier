import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VideoSettings } from '../types';
import { UseTimeline } from '../hooks/useTimeline';
import TimelinePlayer, { TimelinePlayerHandle } from './TimelinePlayer';
import Timeline from './Timeline';

interface TimelineWorkspaceProps {
  timeline: UseTimeline;
  /** Debounced global settings (same preview source as single-clip mode). */
  settings: VideoSettings;
  disabled?: boolean;
  onDetectSilences: () => void;
  isDetectingSilences: boolean;
  silenceCount: number | null;
  skipSilences: boolean;
  onToggleSkipSilences: (v: boolean) => void;
  onRemoveClip: (id: string) => void;
}

/**
 * The multi-clip editing workspace: sequential preview player on top, the
 * track below. Owns the playhead time and the clip selection so both stay in
 * sync; structural changes (add/remove/split) live in the useTimeline hook.
 */
const TimelineWorkspace: React.FC<TimelineWorkspaceProps> = ({
  timeline,
  settings,
  disabled,
  onDetectSilences,
  isDetectingSilences,
  silenceCount,
  skipSilences,
  onToggleSkipSilences,
  onRemoveClip,
}) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const playerRef = useRef<TimelinePlayerHandle>(null);

  const handleSeek = useCallback((t: number) => {
    playerRef.current?.seekTo(t);
  }, []);

  const handleTimeUpdate = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  const handleAddFiles = useCallback(async (files: File[]) => {
    setAddError(null);
    const errors = await timeline.addFiles(files);
    if (errors.length > 0) {
      setAddError(errors.join('\n'));
    }
  }, [timeline]);

  const handleSplitAtPlayhead = useCallback(() => {
    const newId = timeline.splitClipAt(currentTime);
    if (newId) {
      setSelectedId(newId);
    }
  }, [timeline, currentTime]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedId) {
      onRemoveClip(selectedId);
      setSelectedId(null);
    }
  }, [selectedId, onRemoveClip]);

  // Clamp the playhead when the timeline shrinks (delete/clear/trim).
  useEffect(() => {
    if (currentTime > timeline.totalDuration) {
      const t = Math.max(0, timeline.totalDuration - 0.05);
      setCurrentTime(t);
      playerRef.current?.seekTo(t);
    }
    if (selectedId && !timeline.clips.some((c) => c.id === selectedId)) {
      setSelectedId(null);
    }
  }, [timeline.totalDuration, timeline.clips, currentTime, selectedId]);

  // Delete / Backspace removes the selected clip (never while typing).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !disabled) {
        e.preventDefault();
        handleDeleteSelected();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, disabled, handleDeleteSelected]);

  return (
    <div className="space-y-4">
      <TimelinePlayer
        ref={playerRef}
        clips={timeline.clips}
        settings={settings}
        onTimeUpdate={handleTimeUpdate}
        disabled={disabled}
      />
      <Timeline
        timeline={timeline}
        currentTime={currentTime}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onSeek={handleSeek}
        onSplitAtPlayhead={handleSplitAtPlayhead}
        onDeleteSelected={handleDeleteSelected}
        onAddFiles={handleAddFiles}
        addError={addError}
        disabled={disabled}
        onDetectSilences={onDetectSilences}
        isDetectingSilences={isDetectingSilences}
        silenceCount={silenceCount}
        skipSilences={skipSilences}
        onToggleSkipSilences={onToggleSkipSilences}
      />
      <p className="text-xs text-gray-500">
        Your look, speed, volume and fades apply to every clip on export. Trim each clip on the
        timeline — the export stitches them into one video.
      </p>
    </div>
  );
};

export default TimelineWorkspace;
