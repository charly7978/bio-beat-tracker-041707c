import { Component, type ReactNode } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const log = createLogger('NetworkErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class NetworkErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    log.error('Network error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      isOffline: typeof navigator !== 'undefined' && !navigator.onLine,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
    });
  }

  handleReset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const offline = typeof navigator !== 'undefined' && !navigator.onLine;

    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] p-6 bg-zinc-800/50 border border-zinc-700/50 rounded-lg">
        <CloudOff className="w-16 h-16 text-zinc-400 mb-4" />
        <h3 className="text-xl font-semibold text-zinc-200 mb-2">Error de Red</h3>
        <p className="text-zinc-400 text-center mb-4 max-w-md">
          {offline
            ? 'La conexión cayó durante esta operación. La app sigue funcionando en modo local; reintenta cuando recuperes la conexión.'
            : 'Hubo un error de conexión. Los datos locales no se pierden: se guardan cifrados en este dispositivo.'}
        </p>
        <div className="text-xs text-zinc-500 mb-4 font-mono max-w-md break-all">
          {this.state.error?.message}
        </div>
        <button
          onClick={this.handleReset}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reintentar
        </button>
      </div>
    );
  }
}
