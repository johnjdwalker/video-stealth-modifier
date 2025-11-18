import React from 'react';

interface VideoInfoProps {
  fileName: string;
  fileSize: number;
  fileType: string;
  duration?: number;
}

const VideoInfo: React.FC<VideoInfoProps> = ({ fileName, fileSize, fileType, duration }) => {
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return 'Unknown';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getFileExtension = (filename: string, mimeType: string): string => {
    const ext = filename.split('.').pop()?.toUpperCase();
    if (ext) return ext;
    
    // Fallback to MIME type
    const typeMap: Record<string, string> = {
      'video/mp4': 'MP4',
      'video/webm': 'WEBM',
      'video/quicktime': 'MOV',
      'video/x-msvideo': 'AVI',
      'video/x-matroska': 'MKV',
      'video/ogg': 'OGG',
    };
    return typeMap[mimeType] || 'Unknown';
  };

  return (
    <div className="bg-gray-800 p-4 rounded-lg border border-gray-700">
      <h4 className="text-sm font-semibold text-gray-300 mb-3 flex items-center">
        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Video Information
      </h4>
      
      <div className="space-y-2 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-gray-400">File Name:</span>
          <span className="text-gray-200 font-mono text-xs truncate max-w-xs ml-2" title={fileName}>
            {fileName}
          </span>
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Size:</span>
          <span className="text-indigo-400 font-semibold">{formatFileSize(fileSize)}</span>
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-gray-400">Format:</span>
          <span className="text-indigo-400 font-semibold">{getFileExtension(fileName, fileType)}</span>
        </div>
        
        {duration !== undefined && (
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Duration:</span>
            <span className="text-indigo-400 font-semibold">{formatDuration(duration)}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoInfo;
