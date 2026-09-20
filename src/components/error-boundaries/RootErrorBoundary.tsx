import React from 'react';

/**
 * Error boundary raíz: última línea de defensa cuando falla el renderizado
 * del árbol completo (incluidos los boundaries por dominio de App.tsx).
 * Render exacto preservado de la clase inline original de App.tsx.
 */
interface RootErrorBoundaryProps {
  children: React.ReactNode;
}

interface RootErrorBoundaryState {
  hasError: boolean;
}

export class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('ErrorBoundary caught:', error.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#000', color: '#fff',
          fontFamily: 'system-ui', gap: '16px'
        }}>
          <p style={{ fontSize: '18px' }}>Error de renderizado</p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '12px 24px', background: '#ef4444', color: '#fff',
              border: 'none', borderRadius: '8px', fontSize: '16px', cursor: 'pointer'
            }}
          >
            Recargar App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
