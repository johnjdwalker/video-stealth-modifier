import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log the error to console for debugging
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center p-4">
          <div className="max-w-2xl w-full bg-gray-800 rounded-lg shadow-xl p-8">
            <div className="flex items-center mb-6">
              <svg 
                className="w-12 h-12 text-red-500 mr-4" 
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  strokeWidth={2} 
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" 
                />
              </svg>
              <h1 className="text-3xl font-bold text-red-400">Something went wrong</h1>
            </div>

            <div className="mb-6">
              <p className="text-gray-300 mb-4">
                The application encountered an unexpected error. This could be due to:
              </p>
              <ul className="list-disc list-inside text-gray-400 space-y-1 mb-4">
                <li>A corrupted or unsupported video file</li>
                <li>Browser compatibility issues</li>
                <li>Insufficient memory or resources</li>
                <li>A bug in the application</li>
              </ul>
            </div>

            {this.state.error && (
              <details className="mb-6 bg-gray-900 p-4 rounded-lg">
                <summary className="cursor-pointer text-red-400 font-semibold mb-2">
                  Error Details (Click to expand)
                </summary>
                <div className="text-sm text-gray-400 font-mono">
                  <p className="mb-2">
                    <strong className="text-red-300">Error:</strong> {this.state.error.toString()}
                  </p>
                  {this.state.errorInfo && (
                    <pre className="overflow-auto max-h-64 text-xs bg-gray-950 p-2 rounded">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  )}
                </div>
              </details>
            )}

            <div className="flex flex-col sm:flex-row gap-4">
              <button
                onClick={this.handleReload}
                className="flex-1 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
              >
                Reload Application
              </button>
              <button
                onClick={this.handleReset}
                className="flex-1 px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg shadow-md transition-colors duration-200"
              >
                Try to Continue
              </button>
            </div>

            <div className="mt-6 pt-6 border-t border-gray-700">
              <p className="text-sm text-gray-500">
                If this error persists, try:
              </p>
              <ul className="text-sm text-gray-500 list-disc list-inside mt-2 space-y-1">
                <li>Clearing your browser cache</li>
                <li>Using a different browser (Chrome, Firefox, Edge)</li>
                <li>Uploading a different video file</li>
                <li>Reducing the video file size</li>
              </ul>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
