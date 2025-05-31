
import React, { useRef } from 'react';
import UploadIcon from './icons/UploadIcon';

interface VideoUploaderProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

const VideoUploader: React.FC<VideoUploaderProps> = ({ onFileSelect, disabled }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      onFileSelect(event.target.files[0]);
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="w-full">
      <input
        type="file"
        accept="video/*"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />
      <button
        onClick={handleClick}
        disabled={disabled}
        className="w-full flex flex-col items-center justify-center px-6 py-10 border-2 border-dashed border-gray-600 rounded-lg hover:border-indigo-500 focus:border-indigo-500 transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <UploadIcon className="w-12 h-12 text-gray-400 mb-3" />
        <span className="text-lg font-medium text-gray-300">Click to upload video</span>
        <span className="text-sm text-gray-500">MP4, WEBM, MOV, etc.</span>
      </button>
    </div>
  );
};

export default VideoUploader;
    