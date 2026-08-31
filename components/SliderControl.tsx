
import React from 'react';

interface SliderControlProps {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

/**
 * Number of decimals implied by the slider's step, so a 0.1-step blur reads
 * "1.5px" instead of being rounded to "2px" and a 0.05-step trim point reads
 * "12.35s" instead of "12s".
 */
function decimalsForStep(step: number): number {
  if (!isFinite(step) || Number.isInteger(step)) return 0;
  const text = String(step);
  if (text.includes('e-')) return Math.min(4, Number(text.split('e-')[1]));
  return Math.min(4, text.split('.')[1]?.length ?? 0);
}

const SliderControl: React.FC<SliderControlProps> = ({ label, id, value, min, max, step, unit = '', onChange, disabled }) => {
  const decimals = decimalsForStep(step);
  return (
    <div className="mb-4">
      <label htmlFor={id} className={`block text-sm font-medium text-gray-300 mb-1 ${disabled ? 'opacity-70' : ''}`}>
        {label}: <span className="font-semibold text-indigo-400">{value.toFixed(decimals)}{unit}</span>
      </label>
      <input
        type="range"
        id={id}
        name={id}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed disabled:accent-gray-500"
      />
    </div>
  );
};

export default SliderControl;
