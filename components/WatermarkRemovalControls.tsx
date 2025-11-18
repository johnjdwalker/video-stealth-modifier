import React, { useMemo } from 'react';
import SliderControl from './SliderControl';
import { VideoSettings, WatermarkPresetKey } from '../types';
import { WATERMARK_PRESETS } from '../constants';

interface WatermarkRemovalControlsProps {
  settings: VideoSettings;
  onSettingsChange: (newSettings: VideoSettings) => void;
  disabled?: boolean;
}

const MAX_CROP_PERCENT = 35;
const MIN_MASK_SIZE = 4;
const MAX_MASK_SIZE = 60;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const WatermarkRemovalControls: React.FC<WatermarkRemovalControlsProps> = ({
  settings,
  onSettingsChange,
  disabled = false,
}) => {
  const updateSettings = (patch: Partial<VideoSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const handleCropChange = (key: 'cropTop' | 'cropBottom' | 'cropLeft' | 'cropRight', value: number) => {
    const safeValue = clamp(value, 0, MAX_CROP_PERCENT);
    updateSettings({ [key]: safeValue } as Partial<VideoSettings>);
  };

  const applyPreset = (preset: WatermarkPresetKey) => {
    if (preset === 'custom') {
      updateSettings({ watermarkPreset: 'custom' });
      return;
    }
    const presetConfig = WATERMARK_PRESETS[preset];
    updateSettings({
      watermarkPreset: preset,
      watermarkX: presetConfig.xPercent,
      watermarkY: presetConfig.yPercent,
      watermarkWidth: presetConfig.widthPercent,
      watermarkHeight: presetConfig.heightPercent,
    });
  };

  const handleMaskNumericChange = (
    key: 'watermarkX' | 'watermarkY' | 'watermarkWidth' | 'watermarkHeight' | 'watermarkBlurAmount' | 'watermarkFeather',
    value: number,
  ) => {
    let nextValue = value;
    if (key === 'watermarkWidth') {
      const maxWidth = 100 - settings.watermarkX;
      nextValue = clamp(value, MIN_MASK_SIZE, Math.max(MIN_MASK_SIZE, Math.min(maxWidth, MAX_MASK_SIZE)));
    } else if (key === 'watermarkHeight') {
      const maxHeight = 100 - settings.watermarkY;
      nextValue = clamp(value, MIN_MASK_SIZE, Math.max(MIN_MASK_SIZE, Math.min(maxHeight, MAX_MASK_SIZE)));
    } else if (key === 'watermarkX') {
      const maxX = 100 - settings.watermarkWidth;
      nextValue = clamp(value, 0, Math.max(0, maxX));
    } else if (key === 'watermarkY') {
      const maxY = 100 - settings.watermarkHeight;
      nextValue = clamp(value, 0, Math.max(0, maxY));
    } else if (key === 'watermarkBlurAmount') {
      nextValue = clamp(value, 8, 64);
    } else if (key === 'watermarkFeather') {
      nextValue = clamp(value, 0, 40);
    }

    updateSettings({ [key]: nextValue } as Partial<VideoSettings>);
  };

  const presetOptions = useMemo(() => Object.entries(WATERMARK_PRESETS) as Array<[Exclude<WatermarkPresetKey, 'custom'>, typeof WATERMARK_PRESETS.sora2]>, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-lg font-semibold text-gray-100">Edge Cropping</h4>
          <span className="text-xs text-gray-500">Use when Sora 2 adds thin banners.</span>
        </div>
        <p className="text-xs text-gray-400 mt-1 mb-4">
          Trims a few percent from each edge before export to physically remove static overlays.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SliderControl
            label="Crop Top"
            id="cropTop"
            value={settings.cropTop}
            min={0}
            max={MAX_CROP_PERCENT}
            step={0.5}
            unit="%"
            onChange={(val) => handleCropChange('cropTop', val)}
            disabled={disabled}
          />
          <SliderControl
            label="Crop Bottom"
            id="cropBottom"
            value={settings.cropBottom}
            min={0}
            max={MAX_CROP_PERCENT}
            step={0.5}
            unit="%"
            onChange={(val) => handleCropChange('cropBottom', val)}
            disabled={disabled}
          />
          <SliderControl
            label="Crop Left"
            id="cropLeft"
            value={settings.cropLeft}
            min={0}
            max={MAX_CROP_PERCENT}
            step={0.5}
            unit="%"
            onChange={(val) => handleCropChange('cropLeft', val)}
            disabled={disabled}
          />
          <SliderControl
            label="Crop Right"
            id="cropRight"
            value={settings.cropRight}
            min={0}
            max={MAX_CROP_PERCENT}
            step={0.5}
            unit="%"
            onChange={(val) => handleCropChange('cropRight', val)}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="pt-4 border-t border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-lg font-semibold text-gray-100">Watermark Mask</h4>
            <p className="text-xs text-gray-400">Blur + feather only the Sora 2 watermark plate.</p>
          </div>
          <button
            type="button"
            onClick={() => updateSettings({ watermarkRemovalEnabled: !settings.watermarkRemovalEnabled })}
            disabled={disabled}
            className={`${
              settings.watermarkRemovalEnabled ? 'bg-indigo-600' : 'bg-gray-600'
            } relative inline-flex items-center h-6 rounded-full w-11 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-indigo-500 disabled:opacity-50`}
            aria-pressed={settings.watermarkRemovalEnabled}
          >
            <span className="sr-only">Toggle watermark removal</span>
            <span
              className={`${
                settings.watermarkRemovalEnabled ? 'translate-x-6' : 'translate-x-1'
              } inline-block w-4 h-4 transform bg-white rounded-full transition-transform`}
            />
          </button>
        </div>

        <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="watermarkPreset">
          Preset
        </label>
        <select
          id="watermarkPreset"
          className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          disabled={disabled || !settings.watermarkRemovalEnabled}
          value={settings.watermarkPreset}
          onChange={(event) => applyPreset(event.target.value as WatermarkPresetKey)}
        >
          {presetOptions.map(([key, preset]) => (
            <option key={key} value={key}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom placement</option>
        </select>
        {settings.watermarkRemovalEnabled && settings.watermarkPreset !== 'custom' && (
          <p className="text-xs text-gray-500 mt-2">
            {WATERMARK_PRESETS[settings.watermarkPreset]?.description || 'Preset values applied.'}
          </p>
        )}

        {settings.watermarkRemovalEnabled && settings.watermarkPreset === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <SliderControl
              label="Mask X Offset"
              id="watermarkX"
              value={settings.watermarkX}
              min={0}
              max={100}
              step={0.5}
              unit="%"
              onChange={(val) => handleMaskNumericChange('watermarkX', val)}
              disabled={disabled}
            />
            <SliderControl
              label="Mask Y Offset"
              id="watermarkY"
              value={settings.watermarkY}
              min={0}
              max={100}
              step={0.5}
              unit="%"
              onChange={(val) => handleMaskNumericChange('watermarkY', val)}
              disabled={disabled}
            />
            <SliderControl
              label="Mask Width"
              id="watermarkWidth"
              value={settings.watermarkWidth}
              min={MIN_MASK_SIZE}
              max={MAX_MASK_SIZE}
              step={0.5}
              unit="%"
              onChange={(val) => handleMaskNumericChange('watermarkWidth', val)}
              disabled={disabled}
            />
            <SliderControl
              label="Mask Height"
              id="watermarkHeight"
              value={settings.watermarkHeight}
              min={MIN_MASK_SIZE}
              max={MAX_MASK_SIZE}
              step={0.5}
              unit="%"
              onChange={(val) => handleMaskNumericChange('watermarkHeight', val)}
              disabled={disabled}
            />
            <SliderControl
              label="Blur Strength"
              id="watermarkBlurAmount"
              value={settings.watermarkBlurAmount}
              min={8}
              max={64}
              step={1}
              unit="px"
              onChange={(val) => handleMaskNumericChange('watermarkBlurAmount', val)}
              disabled={disabled}
            />
            <SliderControl
              label="Feather"
              id="watermarkFeather"
              value={settings.watermarkFeather}
              min={0}
              max={40}
              step={1}
              unit="px"
              onChange={(val) => handleMaskNumericChange('watermarkFeather', val)}
              disabled={disabled}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default WatermarkRemovalControls;
