
import React, { useState, useEffect, useCallback } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { VideoSettings } from './types';
import {
  DEFAULT_VIDEO_SETTINGS,
  APP_TITLE,
  SETTINGS_STORAGE_KEY,
  SETTINGS_RANGES,
  OUTPUT_FORMAT_EXTENSIONS,
} from './constants';
import VideoUploader from './components/VideoUploader';
import ComparePlayers from './components/ComparePlayers';
import ModificationControls from './components/ModificationControls';
import VideoInfo from './components/VideoInfo';
import WatermarkRemover from './components/WatermarkRemover';
import SoraWatermarkRemover from './components/SoraWatermarkRemover';
import { useVideoProcessor } from './hooks/useVideoProcessor';
import { useSettingsHistory } from './hooks/useSettingsHistory';
import { clearPresetShareFromLocation, readPresetShareFromLocation } from './utils/presetSharing';
import { detectSilences, SilenceRegion } from './utils/silenceDetection';
import DownloadIcon from './components/icons/DownloadIcon';
import ProcessingSpinnerIcon from './components/icons/ProcessingSpinnerIcon';

// Initialize Gemini AI client
// IMPORTANT: Ensure process.env.API_KEY is set in your environment
let ai: GoogleGenAI | null = null;
try {
  if (process.env.API_KEY) {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  } else {
    console.warn("API_KEY environment variable not found. AI features will be disabled.");
  }
} catch (error) {
  console.error("Failed to initialize GoogleGenAI:", error);
}


type FeatureMode = 'modify' | 'watermark' | 'sora';

const App: React.FC = () => {
  const [featureMode, setFeatureMode] = useState<FeatureMode>('modify');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  const loadInitialSettings = (): VideoSettings => {
    try {
      const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        return { ...DEFAULT_VIDEO_SETTINGS, ...parsed };
      }
      return DEFAULT_VIDEO_SETTINGS;
    } catch (error) {
      console.error("Failed to load settings from localStorage:", error);
      return DEFAULT_VIDEO_SETTINGS;
    }
  };

  const {
    settings: currentSettings,
    commit: commitSettings,
    updateTransient: updateTransientSettings,
    undo: undoSettings,
    redo: redoSettings,
    canUndo: canUndoSettings,
    canRedo: canRedoSettings,
  } = useSettingsHistory(loadInitialSettings);

  const [debouncedSettingsForPreview, setDebouncedSettingsForPreview] = useState<VideoSettings>(currentSettings);
  
  const {
    processVideo,
    cancelProcessing,
    isProcessing,
    isCancelling,
    processedVideoUrl,
    processedMimeType,
    processingError,
    processingWarning,
    progress,
    setProcessedVideoUrl,
  } = useVideoProcessor();

  const [geminiPrompt, setGeminiPrompt] = useState<string>("");
  const [isSuggestingSettings, setIsSuggestingSettings] = useState<boolean>(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [browserCompatibilityError, setBrowserCompatibilityError] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  // Silence detection results for the current video. Derived from the file
  // (not the settings), so they're cleared whenever the video changes.
  const [silenceRegions, setSilenceRegions] = useState<SilenceRegion[] | null>(null);
  const [skipSilences, setSkipSilences] = useState<boolean>(true);
  const [isDetectingSilences, setIsDetectingSilences] = useState<boolean>(false);
  const [silenceError, setSilenceError] = useState<string | null>(null);
  // Settings shared via a #preset= link. Read once on mount; the hash is
  // cleared when the user applies or dismisses the banner below.
  const [sharedPreset, setSharedPreset] = useState<VideoSettings | null>(() => readPresetShareFromLocation());

  const handleApplySharedPreset = () => {
    if (sharedPreset) {
      commitSettings({ ...sharedPreset });
    }
    clearPresetShareFromLocation();
    setSharedPreset(null);
  };

  const handleDismissSharedPreset = () => {
    clearPresetShareFromLocation();
    setSharedPreset(null);
  };

  const handleProcessVideo = useCallback(async () => {
    if (videoFile) {
      try {
        await processVideo(
          videoFile,
          currentSettings,
          skipSilences && silenceRegions && silenceRegions.length > 0
            ? { skipRanges: silenceRegions }
            : undefined
        );
      } catch (error) {
        console.error("Processing failed in App:", error);
        // Error is handled by useVideoProcessor's processingError state
      }
    }
  }, [videoFile, currentSettings, processVideo, skipSilences, silenceRegions]);

  // Effect to add keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Never steal keys while the user is typing in a field (AI prompt,
      // preset name, …) — Escape included.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }

      // Use Cmd on Mac, Ctrl on Windows/Linux
      const modifier = e.metaKey || e.ctrlKey;
      // Browser-safe combo (Alt+Shift) for actions browsers already claim:
      // Ctrl+P (print), Ctrl+D (bookmark), Ctrl+U (view source) all conflict.
      const altShift = e.altKey && e.shiftKey && !modifier;

      // Alt+Shift+U: Upload video
      if (altShift && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        if (!videoFile && !isProcessing && !isSuggestingSettings) {
          document.querySelector('input[type="file"]')?.dispatchEvent(new MouseEvent('click'));
        }
      }
      
      // Alt+Shift+P: Process video
      if (altShift && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (videoFile && !isProcessing && !isSuggestingSettings) {
          handleProcessVideo();
        }
      }
      
      // Alt+Shift+D: Download processed video
      if (altShift && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (processedVideoUrl && !isProcessing) {
          const link = document.querySelector('a[download]') as HTMLAnchorElement;
          link?.click();
        }
      }

      // Ctrl/Cmd + Z: Undo settings change
      if (modifier && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndoSettings && !isProcessing && !isSuggestingSettings) {
          undoSettings();
        }
      }

      // Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y: Redo settings change
      if (modifier && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (canRedoSettings && !isProcessing && !isSuggestingSettings) {
          redoSettings();
        }
      }
      
      // Escape: Cancel processing
      if (e.key === 'Escape') {
        if (isProcessing && !isCancelling) {
          cancelProcessing();
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [videoFile, isProcessing, isSuggestingSettings, processedVideoUrl, isCancelling, handleProcessVideo, cancelProcessing, canUndoSettings, canRedoSettings, undoSettings, redoSettings]);
  
  // Effect to check browser compatibility on mount
  useEffect(() => {
    const checkBrowserCompatibility = () => {
      const issues: string[] = [];
      
      // Check MediaRecorder support
      if (typeof MediaRecorder === 'undefined') {
        issues.push('MediaRecorder API (required for video recording)');
      } else {
        // Check WEBM support
        const mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          issues.push('WEBM video recording (VP8/Opus codecs)');
        }
      }
      
      // Check AudioContext support
      if (typeof AudioContext === 'undefined' && typeof (window as any).webkitAudioContext === 'undefined') {
        issues.push('AudioContext API (required for audio processing)');
      }
      
      // Check canvas captureStream support
      const testCanvas = document.createElement('canvas');
      if (typeof testCanvas.captureStream !== 'function') {
        issues.push('Canvas captureStream (required for video effects)');
      }
      
      if (issues.length > 0) {
        setBrowserCompatibilityError(
          `Your browser doesn't support the following features required by this application:\n\n` +
          issues.map(issue => `• ${issue}`).join('\n') +
          `\n\nPlease use a modern browser like Chrome 94+, Firefox 90+, Edge 94+, or Safari 16.4+.`
        );
      }
    };
    
    checkBrowserCompatibility();
  }, []);
  
  // Effect to save settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(currentSettings));
    } catch (error) {
      console.error("Failed to save settings to localStorage:", error);
    }
  }, [currentSettings]);

  // Effect to debounce settings for the preview
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSettingsForPreview(currentSettings);
    }, 300); // 300ms debounce delay

    return () => {
      clearTimeout(handler);
    };
  }, [currentSettings]);

  // Effect for creating/revoking object URL for original video preview
  useEffect(() => {
    if (videoFile) {
      const objectUrl = URL.createObjectURL(videoFile);
      setPreviewUrl(objectUrl);
      
      // Return cleanup function that revokes this specific URL
      return () => {
        URL.revokeObjectURL(objectUrl);
      };
    } else {
      // When videoFile becomes null, clear preview and revoke any existing URL
      setPreviewUrl((prevUrl) => {
        if (prevUrl) {
          URL.revokeObjectURL(prevUrl);
        }
        return null;
      });
    }
  }, [videoFile]);

  const handleFileSelect = (file: File) => {
    setVideoFile(file);
    setProcessedVideoUrl(null); 
    setGeminiError(null); // Clear AI error on new file
    setFileError(null); // Clear file error on successful selection
    setVideoDuration(undefined); // Reset duration
    setSilenceRegions(null); // Silence map belongs to the previous clip
    setSilenceError(null);
    // The trim window is measured against a specific video, so carrying one
    // over from the previous clip would silently truncate this export.
    commitSettings({ ...currentSettings, trimStartSeconds: null, trimEndSeconds: null });
    
    // Probe the file for its duration. The object URL is revoked on every
    // path — including load failures — so the blob is not pinned in memory.
    const video = document.createElement('video');
    const probeUrl = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
      URL.revokeObjectURL(probeUrl);
    };
    video.onerror = () => {
      URL.revokeObjectURL(probeUrl);
    };
    video.src = probeUrl;
  };
  
  const handleFileError = (error: string) => {
    setFileError(error);
    setVideoFile(null);
  };

  const handleSettingsChange = (newSettings: VideoSettings) => {
    commitSettings(newSettings);
  };

  const handleSettingsChangeTransient = (newSettings: VideoSettings) => {
    updateTransientSettings(newSettings);
  };

  const switchFeatureMode = (mode: FeatureMode) => {
    setFeatureMode(mode);
    setVideoFile(null);
    setProcessedVideoUrl(null);
    setGeminiError(null);
    setFileError(null);
    setVideoDuration(undefined);
    setSilenceRegions(null);
    setSilenceError(null);
  };

  const handleUploadDifferent = () => {
    setVideoFile(null); 
    setProcessedVideoUrl(null);
    setGeminiPrompt("");
    setGeminiError(null);
    setFileError(null);
    setVideoDuration(undefined);
    setSilenceRegions(null);
    setSilenceError(null);
  };

  // One-click silence removal: analyze the audio track on-device, map the
  // dead-air stretches, and offer them up as export skip ranges.
  const handleDetectSilences = async () => {
    if (!videoFile || isDetectingSilences) return;
    setIsDetectingSilences(true);
    setSilenceError(null);
    try {
      const { regions } = await detectSilences(videoFile);
      setSilenceRegions(regions);
      setSkipSilences(true);
    } catch (e) {
      setSilenceError(e instanceof Error ? e.message : 'Silence detection failed.');
      setSilenceRegions(null);
    } finally {
      setIsDetectingSilences(false);
    }
  };

  const runAiEdit = async (promptText: string) => {
    if (!ai) {
      setGeminiError("AI features are not available. API key might be missing or invalid.");
      return;
    }
    if (!promptText.trim()) {
      setGeminiError("Please enter a description for the AI edit.");
      return;
    }

    setIsSuggestingSettings(true);
    setGeminiError(null);

    const systemInstruction = `You are an expert video colorist and editor. Translate the user's plain-English description of a look or mood into exact video adjustment settings.
Return your answer *only* as a JSON object. Do not include any explanatory text before or after the JSON object.
The JSON object must contain ALL of the following fields with the specified types:
{
  "brightness": number,            /* Range: 0-200, 100 = unchanged. */
  "contrast": number,              /* Range: 0-200, 100 = unchanged. */
  "saturation": number,            /* Range: 0-200, 100 = unchanged. */
  "hueRotate": number,             /* Range: -180 to 180 degrees. 0 = unchanged. */
  "blur": number,                  /* Range: 0-10 pixels. 0 = none. */
  "sepia": number,                 /* Range: 0-100. 0 = none. */
  "grayscale": number,             /* Range: 0-100. 0 = none. */
  "vignette": number,              /* Range: 0-100. 0 = none. */
  "playbackSpeed": number,         /* Range: 0.5-2.0. 1.0 = unchanged. */
  "volume": number,                /* Range: 0-100. 100 = unchanged. */
  "audioFadeInSeconds": number,    /* Range: 0-10 seconds. */
  "audioFadeOutSeconds": number,   /* Range: 0-10 seconds. */
  "flipHorizontal": boolean,
  "enableRotatingLines": boolean,
  "enablePixelNoise": boolean,
  "audioPreservesPitch": boolean,
  "trimStartSeconds": number | null,   /* Seconds. null = start of video. Set ONLY when the user explicitly asks to cut/trim/remove/keep a time range. */
  "trimEndSeconds": number | null      /* Seconds. null = end of video. Set ONLY when the user explicitly asks to cut/trim/keep a time range. */
}
Rules:
- Be decisive. If the user wants drama, push values hard (contrast 130-160, saturation 120-150, vignette 40-70). Timid near-default values are a failure.
- Match the request literally: "black and white" means grayscale 100; "slow motion feel" means playbackSpeed 0.7-0.85; "fast and punchy" means playbackSpeed 1.2-1.5.
- Combine at most 3-4 strong adjustments; leave everything else at neutral.
- Neutral values: brightness 100, contrast 100, saturation 100, hueRotate 0, blur 0, sepia 0, grayscale 0, vignette 0, playbackSpeed 1.0, volume 100, audioFadeInSeconds 0, audioFadeOutSeconds 0, flipHorizontal false, enableRotatingLines false, enablePixelNoise false, audioPreservesPitch true, trimStartSeconds null, trimEndSeconds null.
- Trim ONLY when the request explicitly mentions cutting, trimming, removing, skipping, or keeping a time range. "cut the first 8 seconds" -> trimStartSeconds 8, trimEndSeconds null. "keep 0:10 to 0:45" -> trimStartSeconds 10, trimEndSeconds 45. "remove the last 5 seconds" -> trimStartSeconds null, trimEndSeconds (duration - 5). Parse m:ss as minutes*60+seconds. Never invent a trim the user didn't ask for; when no trim is requested, return both as null.
- When the request refines existing settings (words like "more", "less", "a bit", "stronger"), adjust relative to the provided current settings instead of starting from neutral.

Examples:
User: "moody noir film" -> {"brightness":92,"contrast":145,"saturation":100,"hueRotate":0,"blur":0,"sepia":0,"grayscale":100,"vignette":55,"playbackSpeed":0.9,"volume":100,"audioFadeInSeconds":1,"audioFadeOutSeconds":1.5,"flipHorizontal":false,"enableRotatingLines":false,"enablePixelNoise":true,"audioPreservesPitch":true,"trimStartSeconds":null,"trimEndSeconds":null}
User: "warm golden-hour glow" -> {"brightness":108,"contrast":105,"saturation":125,"hueRotate":-8,"blur":0,"sepia":18,"grayscale":0,"vignette":20,"playbackSpeed":1.0,"volume":100,"audioFadeInSeconds":0,"audioFadeOutSeconds":0,"flipHorizontal":false,"enableRotatingLines":false,"enablePixelNoise":false,"audioPreservesPitch":true,"trimStartSeconds":null,"trimEndSeconds":null}
User: "dreamy slow wedding video" -> {"brightness":110,"contrast":95,"saturation":115,"hueRotate":0,"blur":1.5,"sepia":10,"grayscale":0,"vignette":15,"playbackSpeed":0.8,"volume":95,"audioFadeInSeconds":1.5,"audioFadeOutSeconds":2,"flipHorizontal":false,"enableRotatingLines":false,"enablePixelNoise":false,"audioPreservesPitch":true,"trimStartSeconds":null,"trimEndSeconds":null}
User: "cut the first 8 seconds" -> {"brightness":100,"contrast":100,"saturation":100,"hueRotate":0,"blur":0,"sepia":0,"grayscale":0,"vignette":0,"playbackSpeed":1.0,"volume":100,"audioFadeInSeconds":0,"audioFadeOutSeconds":0,"flipHorizontal":false,"enableRotatingLines":false,"enablePixelNoise":false,"audioPreservesPitch":true,"trimStartSeconds":8,"trimEndSeconds":null}`;

    const durationNote = typeof videoDuration === 'number' && isFinite(videoDuration) && videoDuration > 0
      ? `Video duration: ${videoDuration.toFixed(1)} seconds.`
      : 'Video duration is unknown: return trimStartSeconds and trimEndSeconds as null.';
    const userRequestPrompt = `Current settings (JSON): ${JSON.stringify(currentSettings)}
${durationNote}

User request: "${promptText.trim()}"

Return the full JSON settings object as instructed. If the request refines the current settings, adjust relative to them; otherwise build the look fresh.`;

    try {
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: userRequestPrompt,
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
        },
      });

      const rawText = response.text;
      if (typeof rawText !== 'string' || !rawText.trim()) {
        throw new Error('The AI returned an empty response. Please try rephrasing your description.');
      }

      let jsonStr = rawText.trim();
      const fenceRegex = /^```(?:json)?\s*\n?(.*?)\n?\s*```$/s;
      const match = jsonStr.match(fenceRegex);
      if (match && match[1]) {
        jsonStr = match[1].trim();
      }

      const suggested = JSON.parse(jsonStr);

      // Start from current settings so we keep things the AI doesn't address
      // (e.g. trim window, output format) and only override the fields it returns.
      const newSettings: VideoSettings = { ...currentSettings };
      const aiAddressableKeys: Array<keyof VideoSettings> = [
        'brightness', 'contrast', 'saturation', 'hueRotate',
        'blur', 'sepia', 'grayscale', 'vignette',
        'playbackSpeed', 'volume',
        'audioFadeInSeconds', 'audioFadeOutSeconds',
        'flipHorizontal', 'enableRotatingLines', 'enablePixelNoise', 'audioPreservesPitch',
      ];
      let invalidFieldCount = 0;

      aiAddressableKeys.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(suggested, key)) {
          invalidFieldCount += 1;
          return;
        }
        const suggestedValue = suggested[key];
        const defaultValue = DEFAULT_VIDEO_SETTINGS[key];
        if (typeof suggestedValue !== typeof defaultValue) {
          invalidFieldCount += 1;
          return;
        }
        if (typeof suggestedValue === 'number') {
          const range = (SETTINGS_RANGES as Record<string, { min: number; max: number }>)[key as string];
          const clamped = range
            ? Math.max(range.min, Math.min(range.max, suggestedValue))
            : suggestedValue;
          (newSettings[key] as number) = clamped;
        } else {
          (newSettings[key] as any) = suggestedValue;
        }
      });

      // Trim is nullable and duration-aware, so it gets its own validation:
      // accept only finite numbers inside [0, duration], and require a valid
      // window when both ends are set. Anything else leaves the current trim.
      const applyTrim = (key: 'trimStartSeconds' | 'trimEndSeconds', value: unknown) => {
        if (value === null || value === undefined) return;
        if (typeof value !== 'number' || !isFinite(value)) {
          invalidFieldCount += 1;
          return;
        }
        if (typeof videoDuration !== 'number' || !isFinite(videoDuration) || videoDuration <= 0) {
          invalidFieldCount += 1;
          return;
        }
        (newSettings[key] as number | null) = Math.max(0, Math.min(videoDuration, value));
      };
      applyTrim('trimStartSeconds', (suggested as Record<string, unknown>).trimStartSeconds);
      applyTrim('trimEndSeconds', (suggested as Record<string, unknown>).trimEndSeconds);
      const aiTrimStart = newSettings.trimStartSeconds;
      const aiTrimEnd = newSettings.trimEndSeconds;
      if (aiTrimStart != null && aiTrimEnd != null && aiTrimStart >= aiTrimEnd) {
        newSettings.trimStartSeconds = currentSettings.trimStartSeconds;
        newSettings.trimEndSeconds = currentSettings.trimEndSeconds;
        invalidFieldCount += 1;
      }

      commitSettings(newSettings);
      if (invalidFieldCount > 0) {
        setGeminiError(`AI suggestion was partially applied (${invalidFieldCount} field${invalidFieldCount === 1 ? '' : 's'} missing or invalid).`);
      }

    } catch (e: any) {
      console.error("Error getting or parsing AI suggestions:", e);
      setGeminiError(`Failed to get AI suggestions: ${e.message || 'Unknown error'}. Please try again or adjust settings manually.`);
    } finally {
      setIsSuggestingSettings(false);
    }
  };

  const handleSuggestSettings = () => {
    void runAiEdit(geminiPrompt);
  };

  const handleSurpriseMe = () => {
    void runAiEdit(
      "Invent a bold, striking, unconventional video look — something a viewer would immediately notice. Surprise me."
    );
  };
  
  const controlsDisabled = !videoFile || isProcessing || isSuggestingSettings;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col items-center p-4 sm:p-8">
      <header className="w-full max-w-5xl mb-8 text-center">
        <h1 className="text-4xl font-bold text-indigo-400">{APP_TITLE}</h1>
        <p className="text-gray-400 mt-2">
          Subtly modify your videos. Adjust visual properties, speed, and audio. Compare original with modified preview. Get AI suggestions!
        </p>
        <div className="flex flex-wrap justify-center gap-2 mt-4">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-900/60 text-emerald-300 border border-emerald-700/50">
            🔒 100% on-device — your video never leaves this browser
          </span>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-indigo-900/60 text-indigo-300 border border-indigo-700/50">
            No watermark · Free 1080p exports · No account needed
          </span>
        </div>
        
        {/* Feature Tabs */}
        <div className="flex flex-wrap justify-center gap-3 mt-6">
          <button
            onClick={() => switchFeatureMode('modify')}
            className={`px-6 py-2 rounded-lg font-semibold transition-colors duration-200 ${
              featureMode === 'modify'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Video Modification
          </button>
          <button
            onClick={() => switchFeatureMode('watermark')}
            className={`px-6 py-2 rounded-lg font-semibold transition-colors duration-200 ${
              featureMode === 'watermark'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Watermark Removal
          </button>
          <button
            onClick={() => switchFeatureMode('sora')}
            className={`px-6 py-2 rounded-lg font-semibold transition-colors duration-200 ${
              featureMode === 'sora'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title="Remove the bouncing Sora 2 / ChatGPT video watermark"
          >
            Sora 2 Watermark Remover
          </button>
        </div>
      </header>

      {browserCompatibilityError && (
        <div className="w-full max-w-5xl mb-8">
          <div className="bg-red-900 border-2 border-red-500 p-6 rounded-lg">
            <div className="flex items-start">
              <svg className="w-6 h-6 text-red-400 mr-3 flex-shrink-0 mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <h3 className="text-xl font-bold text-red-200 mb-2">Browser Compatibility Issue</h3>
                <p className="text-red-100 whitespace-pre-line">{browserCompatibilityError}</p>
                <p className="text-red-300 text-sm mt-4">
                  The application may not work correctly. Please switch to a supported browser for the best experience.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="w-full max-w-5xl">
        {sharedPreset && (
          <div className="mb-8 bg-indigo-900 border-2 border-indigo-500 p-5 rounded-lg" role="status">
            <h3 className="text-lg font-bold text-indigo-200 mb-1">Shared settings detected 🔗</h3>
            <p className="text-indigo-100 text-sm mb-4">
              This link contains video settings shared with you. Applying them will replace your current adjustments (you can undo with Ctrl+Z).
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleApplySharedPreset}
                className="px-5 py-2 bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-lg transition-colors"
              >
                Apply shared settings
              </button>
              <button
                onClick={handleDismissSharedPreset}
                className="px-5 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 font-semibold rounded-lg transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {featureMode === 'sora' ? (
          <SoraWatermarkRemover />
        ) : featureMode === 'watermark' ? (
          <WatermarkRemover />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              {!videoFile ? (
                <>
                  <VideoUploader 
                    onFileSelect={handleFileSelect} 
                    onFileError={handleFileError}
                    disabled={isProcessing || isSuggestingSettings} 
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
                  {!previewUrl ? (
                    <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500" style={{minHeight: '200px'}}>
                      <p>Loading preview data...</p>
                    </div>
                  ) : (
                    <>
                      <ComparePlayers
                        src={previewUrl}
                        settings={debouncedSettingsForPreview}
                        disabled={isProcessing || isSuggestingSettings}
                      />
                      <VideoInfo 
                        fileName={videoFile.name}
                        fileSize={videoFile.size}
                        fileType={videoFile.type}
                        duration={videoDuration}
                      />
                    </>
                  )}
                 <button
                    onClick={handleUploadDifferent}
                    className="w-full mt-4 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200 disabled:opacity-50"
                    disabled={isProcessing || isSuggestingSettings}
                 >
                    Upload Different Video
                 </button>
                </>
              )}
            </div>

            <aside className="lg:col-span-1 space-y-6">
              <ModificationControls
                settings={currentSettings}
                onSettingsChange={handleSettingsChange}
                onSettingsChangeTransient={handleSettingsChangeTransient}
                onUndo={undoSettings}
                onRedo={redoSettings}
                canUndo={canUndoSettings}
                canRedo={canRedoSettings}
                disabled={controlsDisabled}
                geminiPrompt={geminiPrompt}
                onGeminiPromptChange={setGeminiPrompt}
                onSuggestSettings={handleSuggestSettings}
                onSurpriseMe={handleSurpriseMe}
                isSuggestingSettings={isSuggestingSettings}
                geminiError={geminiError}
                aiAvailable={!!ai}
                videoDuration={videoDuration}
                silenceRegions={silenceRegions}
                skipSilences={skipSilences}
                onToggleSkipSilences={setSkipSilences}
                onDetectSilences={handleDetectSilences}
                isDetectingSilences={isDetectingSilences}
                silenceError={silenceError}
              />
              
              {videoFile && (
                <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
                  <h3 className="text-xl font-semibold text-gray-100 mb-4">Process & Download</h3>
                  <button
                    onClick={handleProcessVideo}
                    disabled={controlsDisabled || isProcessing} // Double ensure processing takes precedence
                    className="w-full px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isProcessing ? (
                      <>
                        <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                        Processing... ({progress}%)
                      </>
                    ) : (
                      "Apply Modifications & Prepare Download"
                    )}
                  </button>
                  {isProcessing && (
                    <>
                      <div className="w-full bg-gray-700 rounded-full h-2.5 mt-3">
                        <div className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                      </div>
                      <button
                        onClick={cancelProcessing}
                        disabled={isCancelling}
                        className="w-full mt-3 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCancelling ? 'Cancelling...' : 'Cancel Processing'}
                      </button>
                    </>
                  )}
                </div>
              )}

              {processingWarning && !isProcessing && (
                <div className="bg-yellow-800 p-4 rounded-lg text-yellow-100">
                  <p className="font-semibold">Video Processing Warning:</p>
                  <p className="text-sm">{processingWarning}</p>
                </div>
              )}

              {processingError && !isProcessing && ( // Show processingError only if not currently processing
                <div className="bg-red-700 p-4 rounded-lg text-red-100">
                  <p className="font-semibold">Video Processing Error:</p>
                  <p className="text-sm">{processingError}</p>
                </div>
              )}

              {processedVideoUrl && !isProcessing && (() => {
                const ext = (processedMimeType && processedMimeType.includes('mp4'))
                  ? 'mp4'
                  : OUTPUT_FORMAT_EXTENSIONS[currentSettings.outputFormat] || 'webm';
                const baseName = videoFile?.name.replace(/\.[^.]+$/, '') || 'video';
                return (
                  <div className="bg-green-700 p-6 rounded-lg shadow-lg">
                    <h3 className="text-xl font-semibold text-green-100 mb-3">Download Ready!</h3>
                    <p className="text-sm text-green-200 mb-3">
                      Your modified video is ready ({ext.toUpperCase()} format).
                    </p>
                    <a
                      href={processedVideoUrl}
                      download={`modified_${baseName}.${ext}`}
                      className="w-full px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200"
                    >
                      <DownloadIcon className="w-5 h-5 mr-2" />
                      Download Modified Video
                    </a>
                  </div>
                );
              })()}
            </aside>
          </div>
        )}
      </main>
      
      <footer className="w-full max-w-5xl mt-12 text-center text-gray-500 text-sm">
        <p>&copy; {new Date().getFullYear()} {APP_TITLE}. For educational and creative purposes.</p>
        <p className="mt-1">Note: Output format depends on your browser. WEBM (VP8/VP9) is supported widely; MP4 (H.264) only on browsers that allow it for MediaRecorder. AI suggestions provided by Gemini.</p>
        {!ai && <p className="text-yellow-400 mt-1">AI features disabled: API_KEY for Gemini not configured.</p>}
        <details className="mt-4 text-left inline-block">
          <summary className="cursor-pointer text-gray-400 hover:text-indigo-400 transition-colors">
            ⌨️ Keyboard Shortcuts
          </summary>
          <div className="mt-2 p-4 bg-gray-800 rounded-lg text-left">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Upload Video:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Alt+Shift+U</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Process Video:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Alt+Shift+P</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Download:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Alt+Shift+D</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Undo / Redo:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Ctrl+Z / Ctrl+Y</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Cancel:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Esc</kbd>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              * Use <kbd className="px-1 py-0.5 bg-gray-700 rounded text-xs">⌥⇧</kbd> instead of <kbd className="px-1 py-0.5 bg-gray-700 rounded text-xs">Alt+Shift</kbd> on Mac. Ctrl+P/D/U are left to the browser (print / bookmark / view source).
            </p>
          </div>
        </details>
      </footer>
    </div>
  );
};

export default App;
