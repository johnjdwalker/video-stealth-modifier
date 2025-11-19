import { useState, useCallback, useRef, useEffect } from 'react';
import { WatermarkRemovalState, WatermarkDetectionResult } from '../types';
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

  const detectionCancelledRef = useRef<boolean>(false);
  const removalCancelledRef = useRef<boolean>(false);

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
    // Reset cancellation flag
    detectionCancelledRef.current = false;

    setState((prev) => ({
      ...prev,
      isDetecting: true,
      error: null,
      detectionResult: null,
      progress: 0,
    }));

    try {
      const result = await detectWatermark(videoFile, (progress) => {
        if (!detectionCancelledRef.current) {
          setState((prev) => ({ ...prev, progress }));
        }
      });

      if (!detectionCancelledRef.current) {
        setState((prev) => ({
          ...prev,
          isDetecting: false,
          detectionResult: result,
          progress: 100,
        }));
      }
    } catch (error: any) {
      if (!detectionCancelledRef.current) {
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

    // Reset cancellation flag
    removalCancelledRef.current = false;

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
          if (!removalCancelledRef.current) {
            setState((prev) => ({ ...prev, progress }));
          }
        }
      );

      if (!removalCancelledRef.current) {
        const url = URL.createObjectURL(blob);
        setState((prev) => ({
          ...prev,
          isRemoving: false,
          processedVideoUrl: url,
          progress: 100,
        }));
      }
    } catch (error: any) {
      if (!removalCancelledRef.current) {
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
      detectionCancelledRef.current = true;
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
      removalCancelledRef.current = true;
      setState((prev) => ({
        ...prev,
        isRemoving: false,
        progress: 0,
        error: 'Removal cancelled',
      }));
    }
  }, [state.isRemoving]);

  const reset = useCallback(() => {
    detectionCancelledRef.current = true;
    removalCancelledRef.current = true;
    
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
