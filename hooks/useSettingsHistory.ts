import { useCallback, useRef, useState } from 'react';
import { VideoSettings } from '../types';

// Cap the undo stack so a long editing session can't grow memory without bound.
// A full VideoSettings object is tiny, so 50 entries is generous.
const MAX_HISTORY_ENTRIES = 50;
// Slider drags commit one undo entry per gesture: the entry is flushed after
// this long without further changes.
const TRANSIENT_FLUSH_DELAY_MS = 600;

interface HistoryState {
  settings: VideoSettings;
  past: VideoSettings[];
  future: VideoSettings[];
}

/**
 * Undo/redo history for the editor's VideoSettings.
 *
 * Two kinds of changes:
 * - commit(next): a discrete change (preset applied, toggle flipped, AI edit,
 *   reset). Records exactly one undo step.
 * - updateTransient(next): a continuous change (slider drag). Updates the live
 *   settings immediately but records a single undo entry per drag gesture.
 *
 * State is mirrored in a ref so callbacks always operate on fresh values.
 * (React StrictMode double-invokes state updaters, so updaters must stay
 * side-effect free — hence no setPast-inside-setSettings tricks here.)
 */
export function useSettingsHistory(getInitial: () => VideoSettings) {
  const initialRef = useRef<VideoSettings | null>(null);
  if (initialRef.current === null) {
    initialRef.current = getInitial();
  }

  const [settings, setSettings] = useState<VideoSettings>(initialRef.current);
  const [past, setPast] = useState<VideoSettings[]>([]);
  const [future, setFuture] = useState<VideoSettings[]>([]);

  const stateRef = useRef<HistoryState>({
    settings: initialRef.current,
    past: [],
    future: [],
  });
  const transientStartRef = useRef<VideoSettings | null>(null);
  const transientTimerRef = useRef<number | null>(null);

  const applyState = useCallback((next: HistoryState) => {
    stateRef.current = next;
    setSettings(next.settings);
    setPast(next.past);
    setFuture(next.future);
  }, []);

  /** Flush a pending slider-gesture entry onto the undo stack. */
  const flushTransient = useCallback(() => {
    if (transientTimerRef.current !== null) {
      window.clearTimeout(transientTimerRef.current);
      transientTimerRef.current = null;
    }
    const start = transientStartRef.current;
    transientStartRef.current = null;
    if (start === null) return;
    const { settings: current, past: prevPast } = stateRef.current;
    const nextPast = [...prevPast, start].slice(-MAX_HISTORY_ENTRIES);
    applyState({ settings: current, past: nextPast, future: [] });
  }, [applyState]);

  /** Discrete change — records exactly one undo step. */
  const commit = useCallback(
    (next: VideoSettings) => {
      flushTransient();
      const { settings: current, past: prevPast } = stateRef.current;
      const nextPast = [...prevPast, current].slice(-MAX_HISTORY_ENTRIES);
      applyState({ settings: next, past: nextPast, future: [] });
    },
    [flushTransient, applyState]
  );

  /**
   * Continuous change (e.g. slider drag). The live settings update on every
   * call, but only one undo entry is recorded per gesture: the settings value
   * from before the gesture started.
   */
  const updateTransient = useCallback(
    (next: VideoSettings) => {
      if (transientStartRef.current === null) {
        transientStartRef.current = stateRef.current.settings;
      }
      const { past: prevPast, future: prevFuture } = stateRef.current;
      applyState({ settings: next, past: prevPast, future: prevFuture });
      if (transientTimerRef.current !== null) {
        window.clearTimeout(transientTimerRef.current);
      }
      transientTimerRef.current = window.setTimeout(() => {
        transientTimerRef.current = null;
        flushTransient();
      }, TRANSIENT_FLUSH_DELAY_MS);
    },
    [flushTransient, applyState]
  );

  const undo = useCallback(() => {
    flushTransient();
    const { settings: current, past: prevPast, future: prevFuture } = stateRef.current;
    if (prevPast.length === 0) return;
    const previous = prevPast[prevPast.length - 1];
    applyState({
      settings: previous,
      past: prevPast.slice(0, -1),
      future: [...prevFuture, current],
    });
  }, [flushTransient, applyState]);

  const redo = useCallback(() => {
    flushTransient();
    const { settings: current, past: prevPast, future: prevFuture } = stateRef.current;
    if (prevFuture.length === 0) return;
    const next = prevFuture[prevFuture.length - 1];
    applyState({
      settings: next,
      past: [...prevPast, current],
      future: prevFuture.slice(0, -1),
    });
  }, [flushTransient, applyState]);

  return {
    settings,
    commit,
    updateTransient,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
}
