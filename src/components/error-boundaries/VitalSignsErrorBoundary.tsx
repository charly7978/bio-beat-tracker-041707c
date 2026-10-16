import React, { Component, ReactNode } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const log = createLogger('VitalSignsErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onDegradedMode?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class VitalSignsErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error('Vital signs error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleDegradedMode = () => {
    this.handleReset();
    if (this.props.onDegradedMode) {
      this.props.onDegradedMode();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center p-6 bg-emerald-950/20 border border-emerald-900/30 rounded-lg">
          <Activity className="w-16 h-16 text-emerald-400 mb-4" />
          <h3 className="text-xl font-semibold text-emerald-300 mb-2">
            Error en Signos Vitales
          </h3>
          <p className="text-zinc-400 text-center mb-4 max-w-md">
            El cálculo de signos vitales ha encontrado un error.
            Puede continuar en modo degradado (solo frecuencia cardíaca).
          </p>
          <div className="text-xs text-zinc-500 mb-4 font-mono">
            {this.state.error?.message}
          </div>
          <div className="flex gap-3">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reintentar
            </button>
            {this.props.onDegradedMode && (
              <button
                onClick={this.handleDegradedMode}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors"
              >
                <AlertTriangle className="w-4 h-4" />
                Modo Degradado
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
