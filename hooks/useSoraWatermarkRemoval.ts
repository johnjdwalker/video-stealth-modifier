import { useCallback, useEffect, useRef, useState } from 'react';
import { SoraRemovalQuality, SoraRemovalState, WatermarkCoords } from '../types';
import { detectSoraWatermark, removeSoraWatermark } from '../services/soraWatermarkService';

const INITIAL_STATE: SoraRemovalState = {
  isDetecting: false,
  isRemoving: false,
  detection: null,
  progress: 0,
  stageMessage: '',
  error: null,
  processedVideoUrl: null,
  processedMimeType: null,
};

export function useSoraWatermarkRemoval() {
  const [state, setState] = useState<SoraRemovalState>(INITIAL_STATE);
  const detectAbortRef = useRef<AbortController | null>(null);
  const removeAbortRef = useRef<AbortController | null>(null);

  // Revoke the processed object URL when it changes or unmounts.
  useEffect(() => {
    const url = state.processedVideoUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [state.processedVideoUrl]);

  const detect = useCallback(async (file: File, manualRegion?: WatermarkCoords) => {
    detectAbortRef.current?.abort();
    const ac = new AbortController();
    detectAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isDetecting: true,
      detection: null,
      error: null,
      progress: 0,
      stageMessage: 'Sampling frames…',
    }));

    try {
      const detection = await detectSoraWatermark(
        file,
        (progress, stage) => {
          if (ac.signal.aborted) return;
          setState((prev) => ({
            ...prev,
            progress: Math.round(progress),
            stageMessage: stage ?? prev.stageMessage,
          }));
        },
        { manualRegion, signal: ac.signal }
      );
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

  const remove = useCallback(async (file: File, quality: SoraRemovalQuality = 'balanced') => {
    if (!state.detection?.detected || state.detection.trajectory.length === 0) {
      setState((prev) => ({ ...prev, error: 'Run detection first or set a manual region.' }));
      return;
    }
    removeAbortRef.current?.abort();
    const ac = new AbortController();
    removeAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isRemoving: true,
      progress: 0,
      stageMessage: 'Preparing reconstruction…',
      error: null,
      processedVideoUrl: null,
      processedMimeType: null,
    }));

    try {
      const { blob, mimeType } = await removeSoraWatermark(
        file,
        state.detection,
        (progress, stage) => {
          if (ac.signal.aborted) return;
          setState((prev) => ({
            ...prev,
            progress: Math.round(progress),
            stageMessage: stage ?? prev.stageMessage,
          }));
        },
        { quality, signal: ac.signal }
      );
      if (ac.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      setState((prev) => ({
        ...prev,
        isRemoving: false,
        progress: 100,
        stageMessage: 'Done',
        processedVideoUrl: url,
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
  }, [state.detection]);

  const cancelDetection = useCallback(() => {
    detectAbortRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isDetecting: false,
      progress: 0,
      stageMessage: '',
      error: 'Detection cancelled.',
    }));
  }, []);

  const cancelRemoval = useCallback(() => {
    removeAbortRef.current?.abort();
    setState((prev) => ({
      ...prev,
      isRemoving: false,
      progress: 0,
      stageMessage: '',
      error: 'Removal cancelled.',
    }));
  }, []);

  const reset = useCallback(() => {
    detectAbortRef.current?.abort();
    removeAbortRef.current?.abort();
    setState((prev) => {
      if (prev.processedVideoUrl) URL.revokeObjectURL(prev.processedVideoUrl);
      return { ...INITIAL_STATE };
    });
  }, []);

  return { state, detect, remove, cancelDetection, cancelRemoval, reset };
}
