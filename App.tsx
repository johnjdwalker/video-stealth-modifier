
import React, { useState, useEffect, useCallback } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { VideoSettings } from './types';
import { DEFAULT_VIDEO_SETTINGS, APP_TITLE } from './constants';
import VideoUploader from './components/VideoUploader';
import VideoPlayer from './components/VideoPlayer';
import ModificationControls from './components/ModificationControls';
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


const App: React.FC = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  const [currentSettings, setCurrentSettings] = useState<VideoSettings>(() => {
    try {
      const savedSettings = localStorage.getItem('videoStealthModifierSettings');
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
    isProcessing, 
    processedVideoUrl, 
    processingError, 
    progress,
    setProcessedVideoUrl
  } = useVideoProcessor();

  const [geminiPrompt, setGeminiPrompt] = useState<string>("");
  const [isSuggestingSettings, setIsSuggestingSettings] = useState<boolean>(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);


  // Effect to save settings to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('videoStealthModifierSettings', JSON.stringify(currentSettings));
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
    let objectUrl: string | null = null;
    if (videoFile) {
      objectUrl = URL.createObjectURL(videoFile);
      setPreviewUrl(objectUrl);
    } else {
      setPreviewUrl(null); 
    }

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [videoFile]);

  const handleFileSelect = (file: File) => {
    setVideoFile(file);
    setProcessedVideoUrl(null); 
    setGeminiError(null); // Clear AI error on new file
  };

  const handleSettingsChange = (newSettings: VideoSettings) => {
    setCurrentSettings(newSettings); 
  };

  const handleProcessVideo = async () => {
    if (videoFile) {
      try {
        await processVideo(videoFile, currentSettings); 
      } catch (error) {
        console.error("Processing failed in App:", error);
        // Error is handled by useVideoProcessor's processingError state
      }
    }
  };

  const handleUploadDifferent = () => {
    setVideoFile(null); 
    setProcessedVideoUrl(null);
    setGeminiPrompt("");
    setGeminiError(null);
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
  "brightness": number, /* Example: 100. Range: 0-200. */
  "contrast": number, /* Example: 100. Range: 0-200. */
  "saturation": number, /* Example: 100. Range: 0-200. */
  "playbackSpeed": number, /* Example: 1.0. Range: 0.5-2.0. */
  "volume": number, /* Example: 100. Range: 0-100. */
  "flipHorizontal": boolean, /* Example: false. */
  "enableRotatingLines": boolean, /* Example: false. */
  "enablePixelNoise": boolean, /* Example: false. */
  "audioPreservesPitch": boolean /* Example: true. */
}
Focus on subtle changes suitable for making a video distinct without being overly dramatic.`;

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
      
      // Validate and apply settings
      const newSettings: VideoSettings = { ...DEFAULT_VIDEO_SETTINGS }; // Start with defaults
      let allFieldsValid = true;

      // Define min/max for clamping
      const ranges: Record<keyof Pick<VideoSettings, 'brightness'|'contrast'|'saturation'|'playbackSpeed'|'volume'>, {min: number, max: number}> = {
          brightness: {min: 0, max: 200},
          contrast: {min: 0, max: 200},
          saturation: {min: 0, max: 200},
          playbackSpeed: {min: 0.5, max: 2.0},
          volume: {min: 0, max: 100},
      };

      (Object.keys(DEFAULT_VIDEO_SETTINGS) as Array<keyof VideoSettings>).forEach(key => {
        if (suggested.hasOwnProperty(key)) {
          const suggestedValue = suggested[key];
          if (typeof suggestedValue === typeof DEFAULT_VIDEO_SETTINGS[key]) {
            if (typeof suggestedValue === 'number' && ranges[key as keyof typeof ranges]) {
              const range = ranges[key as keyof typeof ranges];
              (newSettings[key] as number) = Math.max(range.min, Math.min(range.max, suggestedValue));
            } else {
              (newSettings[key] as any) = suggestedValue;
            }
          } else {
            console.warn(`AI suggestion for '${key}' has mismatched type. Expected ${typeof DEFAULT_VIDEO_SETTINGS[key]}, got ${typeof suggestedValue}. Using default.`);
            allFieldsValid = false; // Or keep default from newSettings initialization
          }
        } else {
          console.warn(`AI suggestion missing field '${key}'. Using default.`);
          allFieldsValid = false; // Or keep default
        }
      });
      
      setCurrentSettings(newSettings);
      if (!allFieldsValid) {
        setGeminiError("AI suggestion was partially applied. Some fields were missing or invalid and set to defaults.");
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
      </header>

      <main className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          {!videoFile ? (
            <VideoUploader onFileSelect={handleFileSelect} disabled={isProcessing || isSuggestingSettings} />
          ) : (
            <>
              {!previewUrl ? (
                <div className="w-full aspect-video bg-gray-800 rounded-lg flex items-center justify-center text-gray-500" style={{minHeight: '200px'}}>
                  <p>Loading preview data...</p>
                </div>
              ) : (
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
                 <div className="w-full bg-gray-700 rounded-full h-2.5 mt-3">
                    <div className="bg-indigo-500 h-2.5 rounded-full" style={{ width: `${progress}%` }}></div>
                </div>
              )}
            </div>
          )}

          {processingError && !isProcessing && ( // Show processingError only if not currently processing
            <div className="bg-red-700 p-4 rounded-lg text-red-100">
              <p className="font-semibold">Video Processing Error:</p>
              <p className="text-sm">{processingError}</p>
            </div>
          )}

          {processedVideoUrl && !isProcessing && (
            <div className="bg-green-700 p-6 rounded-lg shadow-lg">
              <h3 className="text-xl font-semibold text-green-100 mb-3">Download Ready!</h3>
              <p className="text-sm text-green-200 mb-3">Your modified video is ready (WEBM format).</p>
              <a
                href={processedVideoUrl}
                download={`modified_${videoFile?.name.split('.')[0] || 'video'}.webm`}
                className="w-full px-6 py-3 bg-green-500 hover:bg-green-600 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200"
              >
                <DownloadIcon className="w-5 h-5 mr-2" />
                Download Modified Video
              </a>
            </div>
          )}
        </aside>
      </main>
      
      <footer className="w-full max-w-5xl mt-12 text-center text-gray-500 text-sm">
        <p>&copy; {new Date().getFullYear()} {APP_TITLE}. For educational and creative purposes.</p>
        <p className="mt-1">Note: Output video is in WEBM format. Ensure your target platform supports WEBM or convert it if necessary. AI suggestions provided by Gemini.</p>
         {!ai && <p className="text-yellow-400 mt-1">AI features disabled: API_KEY for Gemini not configured.</p>}
      </footer>
    </div>
  );
};

export default App;
