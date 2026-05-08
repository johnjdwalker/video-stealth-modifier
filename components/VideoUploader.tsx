import React, { useCallback, useEffect, useRef, useState } from 'react';
import UploadIcon from './icons/UploadIcon';
import { MAX_FILE_SIZE, MAX_FILE_SIZE_MB, ALLOWED_VIDEO_TYPES } from '../constants';

interface VideoUploaderProps {
  onFileSelect: (file: File) => void;
  onFileError: (error: string) => void;
  disabled?: boolean;
  /** When true, listen for paste events on window so users can paste a video from the clipboard. */
  enableClipboardPaste?: boolean;
}

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    return `File is too large (${sizeMB}MB). Maximum allowed size is ${MAX_FILE_SIZE_MB}MB. Please choose a smaller video file.`;
  }
  if (!ALLOWED_VIDEO_TYPES.includes(file.type as any) && !file.type.startsWith('video/')) {
    return `Invalid file type: ${file.type || 'unknown'}. Please upload a valid video file (MP4, WEBM, MOV, etc.).`;
  }
  return null;
}

const VideoUploader: React.FC<VideoUploaderProps> = ({
  onFileSelect,
  onFileError,
  disabled,
  enableClipboardPaste = true,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const acceptFile = useCallback((file: File) => {
    const error = validateFile(file);
    if (error) {
      onFileError(error);
      return;
    }
    onFileSelect(file);
  }, [onFileError, onFileSelect]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.target.value = '';
  };

  const handleClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (disabled) return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      acceptFile(files[0]);
    }
  };

  // Allow pasting a video file from the clipboard (e.g. copy from Finder/Explorer).
  useEffect(() => {
    if (!enableClipboardPaste || disabled) return;

    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && (file.type.startsWith('video/') || ALLOWED_VIDEO_TYPES.includes(file.type as any))) {
            event.preventDefault();
            acceptFile(file);
            return;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enableClipboardPaste, disabled, acceptFile]);

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
        type="button"
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        disabled={disabled}
        aria-label="Upload video by clicking, drag-and-drop, or pasting from clipboard"
        className={`w-full flex flex-col items-center justify-center px-6 py-10 border-2 border-dashed rounded-lg transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
          isDragOver
            ? 'border-indigo-400 bg-indigo-900/20'
            : 'border-gray-600 hover:border-indigo-500 focus:border-indigo-500'
        }`}
      >
        <UploadIcon className="w-12 h-12 text-gray-400 mb-3" />
        <span className="text-lg font-medium text-gray-300">
          {isDragOver ? 'Drop video to upload' : 'Click, drag-and-drop, or paste a video'}
        </span>
        <span className="text-sm text-gray-500 mt-1">MP4, WEBM, MOV, AVI, MKV (up to {MAX_FILE_SIZE_MB}MB)</span>
      </button>
    </div>
  );
};

export default VideoUploader;
