
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
import VideoPlayer from './components/VideoPlayer';
import ModificationControls from './components/ModificationControls';
import VideoInfo from './components/VideoInfo';
import WatermarkRemover from './components/WatermarkRemover';
import SoraWatermarkRemover from './components/SoraWatermarkRemover';
import { useVideoProcessor } from './hooks/useVideoProcessor';
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
  
  const [currentSettings, setCurrentSettings] = useState<VideoSettings>(() => {
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
  });

  const [debouncedSettingsForPreview, setDebouncedSettingsForPreview] = useState<VideoSettings>(currentSettings);
  
  const {
    processVideo,
    cancelProcessing,
    isProcessing,
    isCancelling,
    processedVideoUrl,
    processedMimeType,
    processingError,
    progress,
    setProcessedVideoUrl,
  } = useVideoProcessor();

  const [geminiPrompt, setGeminiPrompt] = useState<string>("");
  const [isSuggestingSettings, setIsSuggestingSettings] = useState<boolean>(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [browserCompatibilityError, setBrowserCompatibilityError] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);

  const handleProcessVideo = useCallback(async () => {
    if (videoFile) {
      try {
        await processVideo(videoFile, currentSettings);
      } catch (error) {
        console.error("Processing failed in App:", error);
        // Error is handled by useVideoProcessor's processingError state
      }
    }
  }, [videoFile, currentSettings, processVideo]);

  // Effect to add keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Use Cmd on Mac, Ctrl on Windows/Linux
      const modifier = e.metaKey || e.ctrlKey;
      
      // Ctrl/Cmd + U: Upload video
      if (modifier && e.key === 'u') {
        e.preventDefault();
        if (!videoFile && !isProcessing && !isSuggestingSettings) {
          document.querySelector('input[type="file"]')?.dispatchEvent(new MouseEvent('click'));
        }
      }
      
      // Ctrl/Cmd + P: Process video
      if (modifier && e.key === 'p') {
        e.preventDefault();
        if (videoFile && !isProcessing && !isSuggestingSettings) {
          handleProcessVideo();
        }
      }
      
      // Ctrl/Cmd + D: Download processed video
      if (modifier && e.key === 'd') {
        e.preventDefault();
        if (processedVideoUrl && !isProcessing) {
          const link = document.querySelector('a[download]') as HTMLAnchorElement;
          link?.click();
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
  }, [videoFile, isProcessing, isSuggestingSettings, processedVideoUrl, isCancelling, handleProcessVideo, cancelProcessing]);
  
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
    
    // Get video duration
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (isFinite(video.duration)) {
        setVideoDuration(video.duration);
      }
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  };
  
  const handleFileError = (error: string) => {
    setFileError(error);
    setVideoFile(null);
  };

  const handleSettingsChange = (newSettings: VideoSettings) => {
    setCurrentSettings(newSettings); 
  };

  const handleUploadDifferent = () => {
    setVideoFile(null); 
    setProcessedVideoUrl(null);
    setGeminiPrompt("");
    setGeminiError(null);
    setFileError(null);
  };

  const handleSuggestSettings = async () => {
    if (!ai) {
      setGeminiError("AI features are not available. API key might be missing or invalid.");
      return;
    }
    if (!geminiPrompt.trim()) {
      setGeminiError("Please enter a description for AI suggestions.");
      return;
    }

    setIsSuggestingSettings(true);
    setGeminiError(null);

    const systemInstruction = `You are an expert video editing assistant. Your goal is to suggest subtle modifications for a video based on the user's request.
Return your suggestions *only* as a JSON object. Do not include any explanatory text before or after the JSON object.
The JSON object must strictly adhere to the following structure and data types. All fields are required:
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
  "audioPreservesPitch": boolean
}
Focus on subtle changes suitable for making a video distinct without being overly dramatic. Avoid combining many heavy effects at once.`;

    const userRequestPrompt = `User request: "${geminiPrompt.trim()}"

Based on the user's request, provide the JSON settings object as instructed.`;

    try {
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-04-17',
        contents: userRequestPrompt,
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
        },
      });

      let jsonStr = response.text.trim();
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

      setCurrentSettings(newSettings);
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
  
  const controlsDisabled = !videoFile || isProcessing || isSuggestingSettings;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col items-center p-4 sm:p-8">
      <header className="w-full max-w-5xl mb-8 text-center">
        <h1 className="text-4xl font-bold text-indigo-400">{APP_TITLE}</h1>
        <p className="text-gray-400 mt-2">
          Subtly modify your videos. Adjust visual properties, speed, and audio. Compare original with modified preview. Get AI suggestions!
        </p>
        
        {/* Feature Tabs */}
        <div className="flex flex-wrap justify-center gap-3 mt-6">
          <button
            onClick={() => {
              setFeatureMode('modify');
              setVideoFile(null);
            }}
            className={`px-6 py-2 rounded-lg font-semibold transition-colors duration-200 ${
              featureMode === 'modify'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Video Modification
          </button>
          <button
            onClick={() => {
              setFeatureMode('watermark');
              setVideoFile(null);
            }}
            className={`px-6 py-2 rounded-lg font-semibold transition-colors duration-200 ${
              featureMode === 'watermark'
                ? 'bg-indigo-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Watermark Removal
          </button>
          <button
            onClick={() => {
              setFeatureMode('sora');
              setVideoFile(null);
            }}
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
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">Original</h4>
                          <VideoPlayer src={previewUrl} settings={DEFAULT_VIDEO_SETTINGS} isOriginal={true} />
                        </div>
                        <div>
                          <h4 className="text-lg font-semibold mb-2 text-center text-gray-300">Modified Preview</h4>
                          <VideoPlayer src={previewUrl} settings={debouncedSettingsForPreview} />
                        </div>
                      </div>
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
                disabled={controlsDisabled}
                geminiPrompt={geminiPrompt}
                onGeminiPromptChange={setGeminiPrompt}
                onSuggestSettings={handleSuggestSettings}
                isSuggestingSettings={isSuggestingSettings}
                geminiError={geminiError}
                aiAvailable={!!ai}
                videoDuration={videoDuration}
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
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Ctrl+U</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Process Video:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Ctrl+P</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Download:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Ctrl+D</kbd>
              </div>
              <div className="flex justify-between items-center gap-4">
                <span className="text-gray-400">Cancel:</span>
                <kbd className="px-2 py-1 bg-gray-700 rounded text-xs font-mono">Esc</kbd>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-3">
              * Use <kbd className="px-1 py-0.5 bg-gray-700 rounded text-xs">Cmd</kbd> instead of <kbd className="px-1 py-0.5 bg-gray-700 rounded text-xs">Ctrl</kbd> on Mac
            </p>
          </div>
        </details>
      </footer>
    </div>
  );
};

export default App;
