import { useState, useCallback, useRef, useEffect } from 'react';
import { WatermarkRemovalState } from '../types';
import { detectWatermark, removeWatermark } from '../services/watermarkService';

export function useWatermarkRemoval() {
  const [state, setState] = useState<WatermarkRemovalState>({
    isDetecting: false,
    isRemoving: false,
    detectionResult: null,
    progress: 0,
    error: null,
    processedVideoUrl: null,
  });

  // AbortControllers rather than plain flags: a flag only stopped the hook
  // from applying results, it never told the service to stop decoding.
  const detectionAbortRef = useRef<AbortController | null>(null);
  const removalAbortRef = useRef<AbortController | null>(null);

  // Cleanup processed video URL on unmount
  useEffect(() => {
    const urlToRevoke = state.processedVideoUrl;
    return () => {
      if (urlToRevoke) {
        URL.revokeObjectURL(urlToRevoke);
      }
    };
  }, [state.processedVideoUrl]);

  const detectWatermarkHandler = useCallback(async (videoFile: File) => {
    detectionAbortRef.current?.abort();
    const ac = new AbortController();
    detectionAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isDetecting: true,
      error: null,
      detectionResult: null,
      progress: 0,
    }));

    try {
      const result = await detectWatermark(videoFile, (progress) => {
        if (!ac.signal.aborted) {
          setState((prev) => ({ ...prev, progress }));
        }
      }, ac.signal);

      if (!ac.signal.aborted) {
        setState((prev) => ({
          ...prev,
          isDetecting: false,
          detectionResult: result,
          progress: 100,
        }));
      }
    } catch (error: any) {
      if (!ac.signal.aborted) {
        setState((prev) => ({
          ...prev,
          isDetecting: false,
          error: error.message || 'Watermark detection failed',
          progress: 0,
        }));
      }
    }
  }, []);

  const removeWatermarkHandler = useCallback(async (videoFile: File) => {
    if (!state.detectionResult?.coords) {
      setState((prev) => ({
        ...prev,
        error: 'No watermark coordinates available. Please detect watermark first.',
      }));
      return;
    }

    removalAbortRef.current?.abort();
    const ac = new AbortController();
    removalAbortRef.current = ac;

    setState((prev) => ({
      ...prev,
      isRemoving: true,
      error: null,
      progress: 0,
    }));

    try {
      const blob = await removeWatermark(
        videoFile,
        state.detectionResult.coords,
        (progress) => {
          if (!ac.signal.aborted) {
            setState((prev) => ({ ...prev, progress }));
          }
        },
        ac.signal
      );

      if (!ac.signal.aborted) {
        const url = URL.createObjectURL(blob);
        setState((prev) => ({
          ...prev,
          isRemoving: false,
          processedVideoUrl: url,
          progress: 100,
        }));
      }
    } catch (error: any) {
      if (!ac.signal.aborted) {
        setState((prev) => ({
          ...prev,
          isRemoving: false,
          error: error.message || 'Watermark removal failed',
          progress: 0,
        }));
      }
    }
  }, [state.detectionResult]);

  const cancelDetection = useCallback(() => {
    if (state.isDetecting) {
      detectionAbortRef.current?.abort();
      setState((prev) => ({
        ...prev,
        isDetecting: false,
        progress: 0,
        error: 'Detection cancelled',
      }));
    }
  }, [state.isDetecting]);

  const cancelRemoval = useCallback(() => {
    if (state.isRemoving) {
      removalAbortRef.current?.abort();
      setState((prev) => ({
        ...prev,
        isRemoving: false,
        progress: 0,
        error: 'Removal cancelled',
      }));
    }
  }, [state.isRemoving]);

  const reset = useCallback(() => {
    detectionAbortRef.current?.abort();
    removalAbortRef.current?.abort();
    
    setState({
      isDetecting: false,
      isRemoving: false,
      detectionResult: null,
      progress: 0,
      error: null,
      processedVideoUrl: null,
    });
  }, []);

  return {
    detectWatermark: detectWatermarkHandler,
    removeWatermark: removeWatermarkHandler,
    cancelDetection,
    cancelRemoval,
    reset,
    state,
  };
}
