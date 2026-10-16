/**
 * Error boundary de red.
 *
 * Captura errores de conexión y ofrece reintento SIN bloquear la app cuando el
 * navegador está offline: el modo local (medición y guardado cifrado local)
 * sigue operativo; únicamente un error real capturado muestra el fallback.
 */
import { Component, type ReactNode } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';

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
    console.error('[NetworkErrorBoundary] Network error:', {
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
      <div className="flex flex-col items-center justify-center min-h-[400px] p-6 bg-yellow-950/20 border border-yellow-900/30 rounded-lg">
        <CloudOff className="w-16 h-16 text-yellow-500 mb-4" />
        <h3 className="text-xl font-semibold text-yellow-400 mb-2">Error de Red</h3>
        <p className="text-yellow-300/70 text-center mb-4 max-w-md">
          {offline
            ? 'La conexión cayó durante esta operación. La app sigue funcionando en modo local; reintenta cuando recuperes la conexión.'
            : 'Hubo un error de conexión. Los datos locales no se pierden: se guardan cifrados en este dispositivo.'}
        </p>
        <div className="text-xs text-yellow-400/50 mb-4 font-mono max-w-md break-all">
          {this.state.error?.message}
        </div>
        <button
          onClick={this.handleReset}
          className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Reintentar
        </button>
      </div>
    );
  }
}
