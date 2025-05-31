
import React from 'react';
import { VideoSettings } from '../types';
import { DEFAULT_VIDEO_SETTINGS } from '../constants';
import SliderControl from './SliderControl';
import ResetIcon from './icons/ResetIcon';
import ProcessingSpinnerIcon from './icons/ProcessingSpinnerIcon'; // For AI suggestion loading

interface ModificationControlsProps {
  settings: VideoSettings;
  onSettingsChange: (newSettings: VideoSettings) => void;
  disabled?: boolean;
  geminiPrompt: string;
  onGeminiPromptChange: (prompt: string) => void;
  onSuggestSettings: () => void;
  isSuggestingSettings: boolean;
  geminiError: string | null;
  aiAvailable: boolean;
}

const ModificationControls: React.FC<ModificationControlsProps> = ({ 
  settings, 
  onSettingsChange, 
  disabled,
  geminiPrompt,
  onGeminiPromptChange,
  onSuggestSettings,
  isSuggestingSettings,
  geminiError,
  aiAvailable
 }) => {
  
  const handleSliderChange = (key: keyof Omit<VideoSettings, 'flipHorizontal' | 'enableRotatingLines' | 'enablePixelNoise' | 'audioPreservesPitch'>, value: number) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const handleToggleChange = (key: keyof Pick<VideoSettings, 'flipHorizontal' | 'enableRotatingLines' | 'enablePixelNoise' | 'audioPreservesPitch'>, value: boolean) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const handleReset = () => {
    onSettingsChange(DEFAULT_VIDEO_SETTINGS);
  };

  const commonDisabledState = disabled || isSuggestingSettings;

  return (
    <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
      {aiAvailable && (
        <div className="mb-6 pb-6 border-b border-gray-700">
          <h4 className="text-lg font-semibold text-gray-100 mb-3">AI Suggestions ✨</h4>
          <label htmlFor="geminiPrompt" className="block text-sm font-medium text-gray-300 mb-1">
            Describe desired changes (e.g., "vintage look", "more energetic"):
          </label>
          <textarea
            id="geminiPrompt"
            value={geminiPrompt}
            onChange={(e) => onGeminiPromptChange(e.target.value)}
            placeholder="e.g., make it feel like an old film, slightly brighter"
            rows={3}
            className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md text-gray-100 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            disabled={commonDisabledState}
            aria-label="Describe desired changes for AI suggestion"
          />
          <button
            onClick={onSuggestSettings}
            disabled={commonDisabledState || !geminiPrompt.trim()}
            className="mt-3 w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-live="polite"
          >
            {isSuggestingSettings ? (
              <>
                <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                Suggesting...
              </>
            ) : (
              "Suggest Settings with AI"
            )}
          </button>
          {geminiError && <p className="text-red-400 text-xs mt-2" role="alert">{geminiError}</p>}
        </div>
      )}

      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xl font-semibold text-gray-100">Manual Adjustments</h3>
        <button
            onClick={handleReset}
            disabled={commonDisabledState}
            className="p-2 rounded-md text-gray-400 hover:bg-gray-700 hover:text-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-800 disabled:opacity-50"
            title="Reset to defaults"
            aria-label="Reset all adjustments to default values"
        >
            <ResetIcon className="w-5 h-5"/>
        </button>
      </div>
      
      <SliderControl
        label="Brightness"
        id="brightness"
        value={settings.brightness}
        min={0} max={200} step={1} unit="%"
        onChange={(val) => handleSliderChange('brightness', val)}
        disabled={commonDisabledState}
      />
      <SliderControl
        label="Contrast"
        id="contrast"
        value={settings.contrast}
        min={0} max={200} step={1} unit="%"
        onChange={(val) => handleSliderChange('contrast', val)}
        disabled={commonDisabledState}
      />
      <SliderControl
        label="Saturation"
        id="saturation"
        value={settings.saturation}
        min={0} max={200} step={1} unit="%"
        onChange={(val) => handleSliderChange('saturation', val)}
        disabled={commonDisabledState}
      />
      <SliderControl
        label="Playback Speed"
        id="playbackSpeed"
        value={settings.playbackSpeed}
        min={0.5} max={2.0} step={0.1} unit="x"
        onChange={(val) => handleSliderChange('playbackSpeed', val)}
        disabled={commonDisabledState}
      />
      <SliderControl
        label="Audio Volume"
        id="volume"
        value={settings.volume}
        min={0} max={100} step={1} unit="%"
        onChange={(val) => handleSliderChange('volume', val)}
        disabled={commonDisabledState}
      />

      <div className="pt-2 border-t border-gray-700 mt-4">
        {/* Flip Horizontal Toggle */}
        <div className="flex items-center justify-between mb-3">
          <label htmlFor="flipHorizontal" className={`text-sm font-medium text-gray-300 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Flip Horizontal: <span className="font-semibold text-indigo-400">{settings.flipHorizontal ? 'On' : 'Off'}</span>
          </label>
          <button
            type="button"
            id="flipHorizontal"
            onClick={() => handleToggleChange('flipHorizontal', !settings.flipHorizontal)}
            disabled={commonDisabledState}
            className={`${
              settings.flipHorizontal ? 'bg-indigo-600' : 'bg-gray-600'
            } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
            aria-pressed={settings.flipHorizontal}
          >
            <span className="sr-only">Flip Horizontal</span>
            <span
              className={`${
                settings.flipHorizontal ? 'translate-x-6' : 'translate-x-1'
              } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
            />
          </button>
        </div>

        {/* Rotating Lines Toggle */}
        <div className="flex items-center justify-between mb-3">
          <label htmlFor="enableRotatingLines" className={`text-sm font-medium text-gray-300 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Rotating Lines: <span className="font-semibold text-indigo-400">{settings.enableRotatingLines ? 'On' : 'Off'}</span>
          </label>
          <button
            type="button"
            id="enableRotatingLines"
            onClick={() => handleToggleChange('enableRotatingLines', !settings.enableRotatingLines)}
            disabled={commonDisabledState}
            className={`${
              settings.enableRotatingLines ? 'bg-indigo-600' : 'bg-gray-600'
            } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
            aria-pressed={settings.enableRotatingLines}
            aria-describedby="rotating-lines-description"
          >
            <span className="sr-only">Enable Rotating Lines</span>
            <span
              className={`${
                settings.enableRotatingLines ? 'translate-x-6' : 'translate-x-1'
              } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
            />
          </button>
        </div>
        <p id="rotating-lines-description" className={`text-xs text-gray-400 mt-1 mb-3 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Effect only visible in final processed video.
        </p>

        {/* Pixel Noise Toggle */}
        <div className="flex items-center justify-between mb-3">
          <label htmlFor="enablePixelNoise" className={`text-sm font-medium text-gray-300 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Pixel Noise: <span className="font-semibold text-indigo-400">{settings.enablePixelNoise ? 'On' : 'Off'}</span>
          </label>
          <button
            type="button"
            id="enablePixelNoise"
            onClick={() => handleToggleChange('enablePixelNoise', !settings.enablePixelNoise)}
            disabled={commonDisabledState}
            className={`${
              settings.enablePixelNoise ? 'bg-indigo-600' : 'bg-gray-600'
            } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
            aria-pressed={settings.enablePixelNoise}
            aria-describedby="pixel-noise-description"
          >
            <span className="sr-only">Enable Pixel Noise</span>
            <span
              className={`${
                settings.enablePixelNoise ? 'translate-x-6' : 'translate-x-1'
              } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
            />
          </button>
        </div>
        <p id="pixel-noise-description" className={`text-xs text-gray-400 mt-1 mb-3 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Adds subtle random pixel noise. Effect in processed video.
        </p>

        {/* Preserve Audio Pitch Toggle */}
        <div className="flex items-center justify-between">
          <label htmlFor="audioPreservesPitch" className={`text-sm font-medium text-gray-300 ${commonDisabledState ? 'opacity-70' : ''}`}>
            Preserve Audio Pitch: <span className="font-semibold text-indigo-400">{settings.audioPreservesPitch ? 'On' : 'Off'}</span>
          </label>
          <button
            type="button"
            id="audioPreservesPitch"
            onClick={() => handleToggleChange('audioPreservesPitch', !settings.audioPreservesPitch)}
            disabled={commonDisabledState}
            className={`${
              settings.audioPreservesPitch ? 'bg-indigo-600' : 'bg-gray-600'
            } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
            aria-pressed={settings.audioPreservesPitch}
            aria-describedby="audio-pitch-description"
          >
            <span className="sr-only">Toggle Preserve Audio Pitch</span>
            <span
              className={`${
                settings.audioPreservesPitch ? 'translate-x-6' : 'translate-x-1'
              } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
            />
          </button>
        </div>
        <p id="audio-pitch-description" className={`text-xs text-gray-400 mt-1 ${commonDisabledState ? 'opacity-70' : ''}`}>
            'On' maintains original pitch with speed changes. 'Off' shifts pitch.
        </p>
      </div>
    </div>
  );
};

export default ModificationControls;
