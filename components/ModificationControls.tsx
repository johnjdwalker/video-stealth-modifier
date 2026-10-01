import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CustomPreset, VideoSettings } from '../types';
import { SilenceRegion, formatSilenceTime } from '../utils/silenceDetection';
import {
  CUSTOM_PRESETS_STORAGE_KEY,
  DEFAULT_VIDEO_SETTINGS,
  OUTPUT_FORMAT_LABELS,
  OUTPUT_FORMAT_MIME_TYPES,
  OUTPUT_QUALITY_PRESETS,
  PRESET_DESCRIPTIONS,
  SETTINGS_PRESETS,
} from '../constants';
import {
  buildPresetShareUrl,
  parsePresetFile,
  serializePresetFile,
} from '../utils/presetSharing';
import SliderControl from './SliderControl';
import ResetIcon from './icons/ResetIcon';
import ProcessingSpinnerIcon from './icons/ProcessingSpinnerIcon';

interface ModificationControlsProps {
  settings: VideoSettings;
  /** Discrete change: preset applied, toggle flipped, reset — one undo step. */
  onSettingsChange: (newSettings: VideoSettings) => void;
  /** Continuous change (slider drag) — live update, one undo step per gesture. */
  onSettingsChangeTransient: (newSettings: VideoSettings) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  disabled?: boolean;
  geminiPrompt: string;
  onGeminiPromptChange: (prompt: string) => void;
  onSuggestSettings: () => void;
  onSurpriseMe: () => void;
  isSuggestingSettings: boolean;
  geminiError: string | null;
  aiAvailable: boolean;
  /** Source video duration in seconds, used for trim controls. */
  videoDuration?: number;
  /** Detected silence regions for the current video (null = not analyzed yet). */
  silenceRegions: SilenceRegion[] | null;
  /** Whether detected silences are cut from the export. */
  skipSilences: boolean;
  onToggleSkipSilences: (skip: boolean) => void;
  onDetectSilences: () => void;
  isDetectingSilences: boolean;
  silenceError: string | null;
}

function loadCustomPresets(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CustomPreset =>
        p && typeof p.name === 'string' && p.settings && typeof p.settings === 'object'
    );
  } catch (err) {
    console.error('Failed to load custom presets:', err);
    return [];
  }
}

function saveCustomPresets(presets: CustomPreset[]): void {
  try {
    localStorage.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch (err) {
    console.error('Failed to save custom presets:', err);
  }
}

function formatSeconds(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

interface SectionProps {
  title: string;
  initiallyOpen?: boolean;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, initiallyOpen = false, children }) => {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="border-t border-gray-700 pt-3 mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between text-left text-gray-200 font-semibold hover:text-indigo-300"
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-xs text-gray-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
};

const ToggleRow: React.FC<{
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}> = ({ id, label, description, checked, onChange, disabled }) => (
  <div className="mb-3">
    <div className="flex items-center justify-between">
      <label htmlFor={id} className={`text-sm font-medium text-gray-300 ${disabled ? 'opacity-70' : ''}`}>
        {label}: <span className="font-semibold text-indigo-400">{checked ? 'On' : 'Off'}</span>
      </label>
      <button
        type="button"
        id={id}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`${
          checked ? 'bg-indigo-600' : 'bg-gray-600'
        } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
        aria-pressed={checked}
      >
        <span className="sr-only">{label}</span>
        <span
          className={`${
            checked ? 'translate-x-6' : 'translate-x-1'
          } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
        />
      </button>
    </div>
    {description && (
      <p className={`text-xs text-gray-400 mt-1 ${disabled ? 'opacity-70' : ''}`}>{description}</p>
    )}
  </div>
);

const ModificationControls: React.FC<ModificationControlsProps> = ({
  settings,
  onSettingsChange,
  onSettingsChangeTransient,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  disabled,
  geminiPrompt,
  onGeminiPromptChange,
  onSuggestSettings,
  onSurpriseMe,
  isSuggestingSettings,
  geminiError,
  aiAvailable,
  videoDuration,
  silenceRegions,
  skipSilences,
  onToggleSkipSilences,
  onDetectSilences,
  isDetectingSilences,
  silenceError,
}) => {
  const [showPresets, setShowPresets] = useState(false);
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(() => loadCustomPresets());
  const [newPresetName, setNewPresetName] = useState('');
  const [presetMessage, setPresetMessage] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    saveCustomPresets(customPresets);
  }, [customPresets]);

  const supportedFormats = useMemo(() => {
    const result: Array<{ value: VideoSettings['outputFormat']; label: string; supported: boolean }> = [];
    (Object.keys(OUTPUT_FORMAT_MIME_TYPES) as Array<VideoSettings['outputFormat']>).forEach((fmt) => {
      const supported = OUTPUT_FORMAT_MIME_TYPES[fmt].some(
        (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)
      );
      result.push({ value: fmt, label: OUTPUT_FORMAT_LABELS[fmt], supported });
    });
    return result;
  }, []);

  const updateNumber = <K extends keyof VideoSettings>(key: K, value: number) => {
    onSettingsChangeTransient({ ...settings, [key]: value as VideoSettings[K] });
  };

  const updateBool = <K extends keyof VideoSettings>(key: K, value: boolean) => {
    onSettingsChange({ ...settings, [key]: value as VideoSettings[K] });
  };

  const handleReset = () => {
    onSettingsChange(DEFAULT_VIDEO_SETTINGS);
  };

  const handleBuiltInPreset = (presetName: string) => {
    const preset = SETTINGS_PRESETS[presetName];
    if (preset) {
      onSettingsChange({ ...preset });
      setShowPresets(false);
    }
  };

  const handleCustomPreset = (preset: CustomPreset) => {
    onSettingsChange({ ...DEFAULT_VIDEO_SETTINGS, ...preset.settings });
    setShowPresets(false);
  };

  const handleSavePreset = () => {
    const name = newPresetName.trim();
    if (!name) {
      setPresetMessage('Preset name cannot be empty.');
      return;
    }
    const existingIndex = customPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    const next: CustomPreset = { name, settings: { ...settings }, createdAt: Date.now() };
    let updated: CustomPreset[];
    if (existingIndex >= 0) {
      updated = [...customPresets];
      updated[existingIndex] = next;
      setPresetMessage(`Preset "${name}" updated.`);
    } else {
      updated = [...customPresets, next];
      setPresetMessage(`Preset "${name}" saved.`);
    }
    setCustomPresets(updated);
    setNewPresetName('');
  };

  const handleDeletePreset = (name: string) => {
    setCustomPresets(customPresets.filter((p) => p.name !== name));
    setPresetMessage(`Preset "${name}" deleted.`);
  };

  const copyTextToClipboard = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for browsers without async clipboard permission.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      } catch {
        return false;
      }
    }
  };

  const handleCopyShareLink = async () => {
    const url = buildPresetShareUrl(settings);
    const ok = await copyTextToClipboard(url);
    setShareMessage(
      ok
        ? 'Share link copied! Anyone opening it can apply these exact settings.'
        : 'Could not copy automatically — your browser blocked clipboard access.'
    );
  };

  const handleDownloadPreset = () => {
    const blob = new Blob([serializePresetFile(settings)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'video-stealth-modifier-preset.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setShareMessage('Preset file downloaded.');
  };

  const handleImportPresetFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parsePresetFile(typeof reader.result === 'string' ? reader.result : '');
      if (parsed) {
        onSettingsChange({ ...DEFAULT_VIDEO_SETTINGS, ...parsed });
        setShareMessage(`Preset imported from "${file.name}".`);
      } else {
        setShareMessage(`Could not import "${file.name}" — it is not a valid preset file.`);
      }
    };
    reader.onerror = () => {
      setShareMessage(`Could not read "${file.name}".`);
    };
    reader.readAsText(file);
  };

  const commonDisabledState = disabled || isSuggestingSettings;

  const trimStart = settings.trimStartSeconds ?? 0;
  const trimEnd = settings.trimEndSeconds ?? (videoDuration ?? 0);
  const hasDuration = typeof videoDuration === 'number' && isFinite(videoDuration) && videoDuration > 0;

  return (
    <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
      {aiAvailable && (
        <div className="mb-6 pb-6 border-b border-gray-700">
          <h4 className="text-lg font-semibold text-gray-100 mb-3">AI Edit Mode ✨</h4>
          <label htmlFor="geminiPrompt" className="block text-sm font-medium text-gray-300 mb-1">
            Describe the look you want (e.g., "moody noir film", "warm golden-hour glow"):
          </label>
          <textarea
            id="geminiPrompt"
            value={geminiPrompt}
            onChange={(e) => onGeminiPromptChange(e.target.value)}
            placeholder='e.g., "moody noir film", "more contrast", or "cut the first 8 seconds"'
            rows={3}
            className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md text-gray-100 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
            disabled={commonDisabledState}
            aria-label="Describe the look you want for the AI edit"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={onSuggestSettings}
              disabled={commonDisabledState || !geminiPrompt.trim()}
              className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg shadow-md flex items-center justify-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-live="polite"
            >
              {isSuggestingSettings ? (
                <>
                  <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                  Editing...
                </>
              ) : (
                'Apply AI Edit'
              )}
            </button>
            <button
              onClick={onSurpriseMe}
              disabled={commonDisabledState}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 font-semibold rounded-lg shadow-md transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Let the AI invent a bold, unexpected look"
            >
              🎲 Surprise me
            </button>
          </div>
          {geminiError && <p className="text-red-400 text-xs mt-2" role="alert">{geminiError}</p>}
        </div>
      )}

      <div className="mb-6 pb-6 border-b border-gray-700">
        <h4 className="text-lg font-semibold text-gray-100 mb-3">🎙️ Silence Removal</h4>
        <p className="text-sm text-gray-400 mb-3">
          Detect dead air in the audio and cut it from the export — on-device, no upload.
        </p>
        {!silenceRegions ? (
          <button
            onClick={onDetectSilences}
            disabled={commonDisabledState || isDetectingSilences}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-lg shadow-md flex items-center transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDetectingSilences ? (
              <>
                <ProcessingSpinnerIcon className="w-5 h-5 mr-2" />
                Analyzing audio...
              </>
            ) : (
              'Detect silences'
            )}
          </button>
        ) : (
          <div>
            <p className="text-sm text-gray-300 mb-2">
              Found <span className="font-semibold text-teal-300">{silenceRegions.length}</span>{' '}
              silent {silenceRegions.length === 1 ? 'stretch' : 'stretches'} (
              {silenceRegions.reduce((sum, r) => sum + (r.end - r.start), 0).toFixed(1)}s total).
            </p>
            {silenceRegions.length > 0 && (
              <>
                <label className="flex items-center gap-2 text-sm text-gray-200 mb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipSilences}
                    onChange={(e) => onToggleSkipSilences(e.target.checked)}
                    disabled={commonDisabledState}
                    className="w-4 h-4 accent-teal-500"
                  />
                  Cut silences from the export
                </label>
                <ul className="text-xs text-gray-400 space-y-0.5 mb-2 max-h-24 overflow-y-auto">
                  {silenceRegions.slice(0, 12).map((r, i) => (
                    <li key={i}>
                      {formatSilenceTime(r.start)} → {formatSilenceTime(r.end)}
                      <span className="text-gray-500"> ({(r.end - r.start).toFixed(1)}s)</span>
                    </li>
                  ))}
                  {silenceRegions.length > 12 && (
                    <li className="text-gray-500">…and {silenceRegions.length - 12} more</li>
                  )}
                </ul>
              </>
            )}
            <button
              onClick={onDetectSilences}
              disabled={commonDisabledState || isDetectingSilences}
              className="text-xs text-gray-400 hover:text-gray-200 underline disabled:opacity-50"
            >
              Re-analyze
            </button>
          </div>
        )}
        {silenceError && <p className="text-red-400 text-xs mt-2" role="alert">{silenceError}</p>}
      </div>

      <div className="mb-2">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-xl font-semibold text-gray-100">Manual Adjustments</h3>
          <div className="flex gap-2">
            <button
              onClick={onUndo}
              disabled={commonDisabledState || !canUndo}
              className="px-3 py-1.5 text-sm rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium transition-colors disabled:opacity-50"
              title="Undo settings change (Ctrl+Z)"
              aria-label="Undo settings change"
            >
              ↩ Undo
            </button>
            <button
              onClick={onRedo}
              disabled={commonDisabledState || !canRedo}
              className="px-3 py-1.5 text-sm rounded-md bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium transition-colors disabled:opacity-50"
              title="Redo settings change (Ctrl+Shift+Z)"
              aria-label="Redo settings change"
            >
              ↪ Redo
            </button>
            <button
              onClick={() => setShowPresets(!showPresets)}
              disabled={commonDisabledState}
              className="px-3 py-1.5 text-sm rounded-md bg-purple-600 hover:bg-purple-700 text-white font-medium transition-colors disabled:opacity-50"
              title="Quick presets"
            >
              Presets
            </button>
            <button
              onClick={handleReset}
              disabled={commonDisabledState}
              className="p-2 rounded-md text-gray-400 hover:bg-gray-700 hover:text-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-800 disabled:opacity-50"
              title="Reset to defaults"
              aria-label="Reset all adjustments to default values"
            >
              <ResetIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {showPresets && (
          <div className="mb-4 p-3 bg-gray-900 rounded-lg border border-gray-700 space-y-3">
            <div>
              <p className="text-xs text-gray-400 mb-2">Built-in presets:</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.keys(SETTINGS_PRESETS).map((presetName) => (
                  <button
                    key={presetName}
                    onClick={() => handleBuiltInPreset(presetName)}
                    disabled={commonDisabledState}
                    className="px-3 py-2 text-sm bg-gray-800 hover:bg-indigo-600 text-gray-300 hover:text-white rounded-md transition-colors disabled:opacity-50 text-left"
                    title={PRESET_DESCRIPTIONS[presetName]}
                  >
                    <div className="font-medium capitalize">{presetName}</div>
                    <div className="text-xs text-gray-500 line-clamp-1">{PRESET_DESCRIPTIONS[presetName]}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-400 mb-2">My presets ({customPresets.length}):</p>
              {customPresets.length === 0 ? (
                <p className="text-xs text-gray-500 italic mb-2">No saved presets yet. Save the current settings below.</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 mb-2">
                  {customPresets.map((preset) => (
                    <div key={preset.name} className="flex items-center gap-2">
                      <button
                        onClick={() => handleCustomPreset(preset)}
                        disabled={commonDisabledState}
                        className="flex-1 px-3 py-2 text-sm bg-gray-800 hover:bg-indigo-600 text-gray-300 hover:text-white rounded-md transition-colors disabled:opacity-50 text-left"
                        title={`Saved ${new Date(preset.createdAt).toLocaleString()}`}
                      >
                        {preset.name}
                      </button>
                      <button
                        onClick={() => handleDeletePreset(preset.name)}
                        disabled={commonDisabledState}
                        className="px-2 py-2 text-xs bg-red-700 hover:bg-red-600 text-white rounded-md transition-colors disabled:opacity-50"
                        aria-label={`Delete preset ${preset.name}`}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Preset name…"
                  disabled={commonDisabledState}
                  className="flex-1 px-2 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-100 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSavePreset();
                    }
                  }}
                />
                <button
                  onClick={handleSavePreset}
                  disabled={commonDisabledState || !newPresetName.trim()}
                  className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white font-medium rounded-md transition-colors disabled:opacity-50"
                >
                  Save current
                </button>
              </div>
              {presetMessage && (
                <p className="text-xs text-gray-400 mt-2" role="status">{presetMessage}</p>
              )}
            </div>

            <div className="pt-3 border-t border-gray-800">
              <p className="text-xs text-gray-400 mb-2">Share this look:</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleCopyShareLink}
                  disabled={commonDisabledState}
                  className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md transition-colors disabled:opacity-50"
                  title="Copy a link that applies these exact settings when opened"
                >
                  Copy share link
                </button>
                <button
                  onClick={handleDownloadPreset}
                  disabled={commonDisabledState}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium rounded-md transition-colors disabled:opacity-50"
                  title="Download these settings as a JSON preset file"
                >
                  Download JSON
                </button>
                <button
                  onClick={() => importFileInputRef.current?.click()}
                  disabled={commonDisabledState}
                  className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium rounded-md transition-colors disabled:opacity-50"
                  title="Import settings from a JSON preset file"
                >
                  Import JSON
                </button>
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportPresetFile}
                  aria-label="Import preset JSON file"
                />
              </div>
              {shareMessage && (
                <p className="text-xs text-gray-400 mt-2" role="status">{shareMessage}</p>
              )}
            </div>
          </div>
        )}
      </div>

      <SliderControl
        label="Brightness" id="brightness" value={settings.brightness}
        min={0} max={200} step={1} unit="%"
        onChange={(v) => updateNumber('brightness', v)} disabled={commonDisabledState}
      />
      <SliderControl
        label="Contrast" id="contrast" value={settings.contrast}
        min={0} max={200} step={1} unit="%"
        onChange={(v) => updateNumber('contrast', v)} disabled={commonDisabledState}
      />
      <SliderControl
        label="Saturation" id="saturation" value={settings.saturation}
        min={0} max={200} step={1} unit="%"
        onChange={(v) => updateNumber('saturation', v)} disabled={commonDisabledState}
      />
      <SliderControl
        label="Playback Speed" id="playbackSpeed" value={settings.playbackSpeed}
        min={0.5} max={2.0} step={0.1} unit="x"
        onChange={(v) => updateNumber('playbackSpeed', v)} disabled={commonDisabledState}
      />
      <SliderControl
        label="Audio Volume" id="volume" value={settings.volume}
        min={0} max={100} step={1} unit="%"
        onChange={(v) => updateNumber('volume', v)} disabled={commonDisabledState}
      />

      <Section title="Stylistic Filters">
        <SliderControl
          label="Hue Rotate" id="hueRotate" value={settings.hueRotate}
          min={-180} max={180} step={1} unit="°"
          onChange={(v) => updateNumber('hueRotate', v)} disabled={commonDisabledState}
        />
        <SliderControl
          label="Blur" id="blur" value={settings.blur}
          min={0} max={10} step={0.1} unit="px"
          onChange={(v) => updateNumber('blur', v)} disabled={commonDisabledState}
        />
        <SliderControl
          label="Sepia" id="sepia" value={settings.sepia}
          min={0} max={100} step={1} unit="%"
          onChange={(v) => updateNumber('sepia', v)} disabled={commonDisabledState}
        />
        <SliderControl
          label="Grayscale" id="grayscale" value={settings.grayscale}
          min={0} max={100} step={1} unit="%"
          onChange={(v) => updateNumber('grayscale', v)} disabled={commonDisabledState}
        />
        <SliderControl
          label="Vignette" id="vignette" value={settings.vignette}
          min={0} max={100} step={1} unit="%"
          onChange={(v) => updateNumber('vignette', v)} disabled={commonDisabledState}
        />
      </Section>

      <Section title="Audio Fades">
        <SliderControl
          label="Fade In" id="audioFadeIn" value={settings.audioFadeInSeconds}
          min={0} max={10} step={0.1} unit="s"
          onChange={(v) => updateNumber('audioFadeInSeconds', v)} disabled={commonDisabledState}
        />
        <SliderControl
          label="Fade Out" id="audioFadeOut" value={settings.audioFadeOutSeconds}
          min={0} max={10} step={0.1} unit="s"
          onChange={(v) => updateNumber('audioFadeOutSeconds', v)} disabled={commonDisabledState}
        />
        <p className="text-xs text-gray-400">
          Fades apply to the processed (downloaded) video only.
        </p>
      </Section>

      <Section title="Trim Video">
        {hasDuration ? (
          <>
            <SliderControl
              label={`Start (${formatSeconds(trimStart)})`} id="trimStart"
              value={trimStart}
              min={0} max={Math.max(0, (videoDuration as number) - 0.05)} step={0.05} unit="s"
              onChange={(v) => onSettingsChangeTransient({
                ...settings,
                trimStartSeconds: v,
                trimEndSeconds: Math.max(v + 0.05, settings.trimEndSeconds ?? (videoDuration as number)),
              })}
              disabled={commonDisabledState}
            />
            <SliderControl
              label={`End (${formatSeconds(trimEnd)})`} id="trimEnd"
              value={trimEnd}
              min={Math.min(trimStart + 0.05, videoDuration as number)}
              max={videoDuration as number} step={0.05} unit="s"
              onChange={(v) => onSettingsChangeTransient({
                ...settings,
                trimEndSeconds: v,
                trimStartSeconds: Math.min(v - 0.05, settings.trimStartSeconds ?? 0),
              })}
              disabled={commonDisabledState}
            />
            <button
              onClick={() => onSettingsChange({ ...settings, trimStartSeconds: null, trimEndSeconds: null })}
              disabled={commonDisabledState}
              className="text-xs text-indigo-300 hover:text-indigo-200 underline disabled:opacity-50"
            >
              Reset trim (use full video)
            </button>
          </>
        ) : (
          <p className="text-xs text-gray-400">Upload a video to enable trimming.</p>
        )}
      </Section>

      <Section title="Output">
        <label htmlFor="outputFormat" className="block text-sm font-medium text-gray-300 mb-1">
          Format:
        </label>
        <select
          id="outputFormat"
          value={settings.outputFormat}
          onChange={(e) => onSettingsChange({ ...settings, outputFormat: e.target.value as VideoSettings['outputFormat'] })}
          disabled={commonDisabledState}
          className="w-full mb-3 p-2 bg-gray-700 border border-gray-600 rounded-md text-gray-100 disabled:opacity-50"
        >
          {supportedFormats.map(({ value, label, supported }) => (
            <option key={value} value={value} disabled={!supported}>
              {label}{supported ? '' : ' (not supported by this browser)'}
            </option>
          ))}
        </select>

        <SliderControl
          label="Fine-tune bitrate"
          id="outputBitrate"
          value={settings.outputBitrateKbps}
          min={0} max={30000} step={500} unit=" kbps"
          onChange={(v) => updateNumber('outputBitrateKbps', v)}
          disabled={commonDisabledState}
        />
        <p className="text-xs text-gray-400 mb-2">
          0 kbps lets the browser pick a default. Higher values produce larger, higher-quality files.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Export quality presets">
          {OUTPUT_QUALITY_PRESETS.map((preset) => {
            const active = settings.outputBitrateKbps === preset.bitrateKbps;
            return (
              <button
                key={preset.id}
                onClick={() => onSettingsChange({ ...settings, outputBitrateKbps: preset.bitrateKbps })}
                disabled={commonDisabledState}
                title={preset.description}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors disabled:opacity-50 ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Effects & Geometry" initiallyOpen>
        <ToggleRow
          id="flipHorizontal"
          label="Flip Horizontal"
          checked={settings.flipHorizontal}
          onChange={(v) => updateBool('flipHorizontal', v)}
          disabled={commonDisabledState}
        />
        <ToggleRow
          id="enableRotatingLines"
          label="Rotating Lines"
          description="Effect only visible in final processed video."
          checked={settings.enableRotatingLines}
          onChange={(v) => updateBool('enableRotatingLines', v)}
          disabled={commonDisabledState}
        />
        <ToggleRow
          id="enablePixelNoise"
          label="Pixel Noise"
          description="Adds subtle random pixel noise. Effect in processed video."
          checked={settings.enablePixelNoise}
          onChange={(v) => updateBool('enablePixelNoise', v)}
          disabled={commonDisabledState}
        />
        <ToggleRow
          id="audioPreservesPitch"
          label="Preserve Audio Pitch"
          description="'On' maintains original pitch with speed changes. 'Off' shifts pitch."
          checked={settings.audioPreservesPitch}
          onChange={(v) => updateBool('audioPreservesPitch', v)}
          disabled={commonDisabledState}
        />
      </Section>
    </div>
  );
};

export default ModificationControls;
