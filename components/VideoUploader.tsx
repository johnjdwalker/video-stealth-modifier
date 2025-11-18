
import React, { useRef } from 'react';
import UploadIcon from './icons/UploadIcon';
import { MAX_FILE_SIZE, MAX_FILE_SIZE_MB, ALLOWED_VIDEO_TYPES } from '../constants';

interface VideoUploaderProps {
  onFileSelect: (file: File) => void;
  onFileError: (error: string) => void;
  disabled?: boolean;
}

const VideoUploader: React.FC<VideoUploaderProps> = ({ onFileSelect, onFileError, disabled }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      const file = event.target.files[0];
      
      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
        onFileError(`File is too large (${sizeMB}MB). Maximum allowed size is ${MAX_FILE_SIZE_MB}MB. Please choose a smaller video file.`);
        event.target.value = '';
        return;
      }
      
      // Validate file type
      if (!ALLOWED_VIDEO_TYPES.includes(file.type as any) && !file.type.startsWith('video/')) {
        onFileError(`Invalid file type: ${file.type || 'unknown'}. Please upload a valid video file (MP4, WEBM, MOV, etc.).`);
        event.target.value = '';
        return;
      }
      
      onFileSelect(file);
      // Reset input value to allow selecting the same file again
      event.target.value = '';
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
    