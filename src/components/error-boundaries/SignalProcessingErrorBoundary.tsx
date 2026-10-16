import React, { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Activity } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const log = createLogger('SignalProcessingErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  maxRetries?: number;
  retryDelay?: number;
  enableDegradedMode?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  retryCount: number;
  isRetrying: boolean;
  inDegradedMode: boolean;
}

export class SignalProcessingErrorBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
      isRetrying: false,
      inDegradedMode: false,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      retryCount: 0,
      isRetrying: false,
      inDegradedMode: false,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const errorContext = {
      boundary: 'SignalProcessingErrorBoundary',
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
      retryCount: this.state.retryCount,
    };

    log.error('Signal processing error:', errorContext);

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
      isRetrying: false,
      inDegradedMode: false,
    });
  };

  handleRetry = () => {
    const maxRetries = this.props.maxRetries || 3;

    if (this.state.retryCount >= maxRetries) {
      this.setState({ inDegradedMode: true });
      return;
    }

    this.setState({ isRetrying: true });

    const delay = (this.props.retryDelay || 1000) * Math.pow(2, this.state.retryCount);

    this.retryTimer = setTimeout(() => {
      this.setState({
        hasError: false,
        error: null,
        errorInfo: null,
        retryCount: this.state.retryCount + 1,
        isRetrying: false,
      });
    }, delay);
  };

  handleDegradedMode = () => {
    if (this.props.enableDegradedMode) {
      this.props.enableDegradedMode();
    }
    this.handleReset();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const maxRetries = this.props.maxRetries || 3;
      const canRetry = this.state.retryCount < maxRetries;

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-6 bg-amber-950/20 border border-amber-900/30 rounded-lg">
          <AlertTriangle className="w-16 h-16 text-amber-400 mb-4" />
          <h3 className="text-xl font-semibold text-amber-300 mb-2">
            Error en Procesamiento de Señal
          </h3>
          <p className="text-zinc-400 text-center mb-4 max-w-md">
            El sistema de procesamiento de señal ha encontrado un error.
            Esto no afecta otras funciones de la aplicación.
          </p>
          <div className="text-xs text-zinc-500 mb-4 font-mono max-w-md break-all">
            {this.state.error?.message}
          </div>
          <div className="text-xs text-zinc-600 mb-4">
            Intento {this.state.retryCount} de {maxRetries}
          </div>

          {this.state.isRetrying ? (
            <div className="flex items-center gap-2 text-amber-300">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Reintentando...
            </div>
          ) : (
            <div className="flex gap-3">
              {canRetry && (
                <button
                  onClick={this.handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Reintentar
                </button>
              )}
              {this.state.inDegradedMode && this.props.enableDegradedMode && (
                <button
                  onClick={this.handleDegradedMode}
                  className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors"
                >
                  <Activity className="w-4 h-4" />
                  Modo Degradado
                </button>
              )}
              <button
                onClick={this.handleReset}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors"
              >
                Reiniciar Manual
              </button>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
