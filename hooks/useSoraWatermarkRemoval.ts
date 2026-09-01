import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SoraCorrection,
  SoraFillMode,
  SoraRemovalQuality,
  SoraRemovalState,
  WatermarkCoords,
} from '../types';
import {
  detectSoraWatermark,
  removeSoraWatermark,
  renderFillPreview,
  resolveTimeline,
  FillPreview,
} from '../services/soraWatermarkService';

const INITIAL_STATE: SoraRemovalState = {
  isDetecting: false,
  isRemoving: false,
  detection: null,
  corrections: [],
  progress: 0,
  stageMessage: '',
  error: null,
  processedVideoUrl: null,
  processedMimeType: null,
};

let correctionSeq = 0;

export function useSoraWatermarkRemoval() {
  const [state, setState] = useState<SoraRemovalState>(INITIAL_STATE);
  const [preview, setPreview] = useState<FillPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const detectAbortRef = useRef<AbortController | null>(null);
  const removeAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  // Revoke the processed object URL when it changes or unmounts.
  useEffect(() => {
    const url = state.processedVideoUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state.processedVideoUrl]);

  useEffect(() => () => {
    detectAbortRef.current?.abort();
    removeAbortRef.current?.abort();
    previewAbortRef.current?.abort();
  }, []);

  /** Detected dwells with the user's corrections applied. */
  const timeline = useMemo(
    () => resolveTimeline(
      state.detection,
      state.corrections,
      state.detection?.videoDuration ?? 0
    ),
    [state.detection, state.corrections]
  );

  const detect = useCallback(async (file: File) => {
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isDetecting: true,
      detection: null,
      corrections: [],
      error: null,
      progress: 0,
      stageMessage: 'Analysing frames…',
    }));

    try {
      const detection = await detectSoraWatermark(file, (progress, stage) => {
        if (ac.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          progress: Math.round(progress),
          stageMessage: stage ?? prev.stageMessage,
        }));
      }, { signal: ac.signal });

      if (ac.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        isDetecting: false,
        detection,
        progress: 100,
        stageMessage: detection.message ?? '',
        error: detection.detected ? null : (detection.message ?? 'No watermark detected.'),
      }));
    } catch (err: any) {
      if (ac.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        isDetecting: false,
        progress: 0,
        error: err?.message || 'Detection failed.',
      }));
    }
  }, []);

  /**
   * Records "the watermark is here at this moment". Overrides the detected
   * position for the stretch of timeline containing `time`.
   */
  const addCorrection = useCallback((time: number, bbox: WatermarkCoords) => {
    const correction: SoraCorrection = { id: `c${++correctionSeq}`, time, bbox };
    setState((prev) => {
      // One correction per dwell: replace any existing correction close in time.
      const kept = prev.corrections.filter((c) => Math.abs(c.time - time) > 0.001);
      return { ...prev, corrections: [...kept, correction], error: null };
    });
    return correction;
  }, []);

  const removeCorrection = useCallback((id: string) => {
    setState((prev) => ({ ...prev, corrections: prev.corrections.filter((c) => c.id !== id) }));
  }, []);

  const clearCorrections = useCallback(() => {
    setState((prev) => ({ ...prev, corrections: [] }));
  }, []);

  /** Renders a single frame with the chosen fill, for side-by-side comparison. */
  const previewFill = useCallback(async (file: File, time: number, fillMode: SoraFillMode) => {
    if (timeline.length === 0) return;
    previewAbortRef.current?.abort();
    const ac = new AbortController();
    previewAbortRef.current = ac;
    setIsPreviewing(true);
    try {
      const result = await renderFillPreview(
        file, time, timeline, state.detection?.padding ?? 10, fillMode, { signal: ac.signal }
      );
      if (!ac.signal.aborted) setPreview(result);
    } catch (err: any) {
      if (!ac.signal.aborted) {
        setState((prev) => ({ ...prev, error: err?.message || 'Could not render preview.' }));
      }
    } finally {
      if (!ac.signal.aborted) setIsPreviewing(false);
    }
  }, [timeline, state.detection]);

  const clearPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    setPreview(null);
    setIsPreviewing(false);
  }, []);

  const remove = useCallback(async (
    file: File,
    quality: SoraRemovalQuality = 'balanced',
    fillMode: SoraFillMode = 'auto'
  ) => {
    if (timeline.length === 0) {
      setState((prev) => ({ ...prev, error: 'Run detection, or click the watermark to place it manually.' }));
      return;
    }
    removeAbortRef.current?.abort();
    const ac = new AbortController();
    removeAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isRemoving: true,
      progress: 0,
      stageMessage: 'Preparing…',
      error: null,
      processedVideoUrl: null,
      processedMimeType: null,
    }));

    try {
      const { blob, mimeType } = await removeSoraWatermark(
        file,
        timeline,
        state.detection?.padding ?? 10,
        (progress, stage) => {
          if (ac.signal.aborted) return;
          setState((prev) => ({
            ...prev,
            progress: Math.round(progress),
            stageMessage: stage ?? prev.stageMessage,
          }));
        },
        { quality, fillMode, signal: ac.signal }
      );
      if (ac.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        isRemoving: false,
        progress: 100,
        stageMessage: 'Done',
        processedVideoUrl: URL.createObjectURL(blob),
        processedMimeType: mimeType,
      }));
    } catch (err: any) {
      if (ac.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        isRemoving: false,
        progress: 0,
        error: err?.message || 'Watermark removal failed.',
      }));
    }
  }, [timeline, state.detection]);

  const cancelDetection = useCallback(() => {
    detectAbortRef.current?.abort();
    setState((prev) => ({
      ...prev, isDetecting: false, progress: 0, stageMessage: '', error: 'Detection cancelled.',
    }));
  }, []);

  const cancelRemoval = useCallback(() => {
    removeAbortRef.current?.abort();
    setState((prev) => ({
      ...prev, isRemoving: false, progress: 0, stageMessage: '', error: 'Removal cancelled.',
    }));
  }, []);

  const reset = useCallback(() => {
    detectAbortRef.current?.abort();
    removeAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    setPreview(null);
    setIsPreviewing(false);
    setState((prev) => {
      if (prev.processedVideoUrl) URL.revokeObjectURL(prev.processedVideoUrl);
      return { ...INITIAL_STATE };
    });
  }, []);

  return {
    state,
    timeline,
    preview,
    isPreviewing,
    detect,
    remove,
    addCorrection,
    removeCorrection,
    clearCorrections,
    previewFill,
    clearPreview,
    cancelDetection,
    cancelRemoval,
    reset,
  };
}
