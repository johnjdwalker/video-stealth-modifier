
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

const SliderControl: React.FC<SliderControlProps> = ({ label, id, value, min, max, step, unit = '', onChange, disabled }) => {
  return (
    <div className="mb-4">
      <label htmlFor={id} className={`block text-sm font-medium text-gray-300 mb-1 ${disabled ? 'opacity-70' : ''}`}>
        {label}: <span className="font-semibold text-indigo-400">{value.toFixed(unit === 'x' ? 1: 0)}{unit}</span>
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
