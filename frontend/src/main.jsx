import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message || 'Unknown error';
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#F7F8FA', fontFamily: "'DM Sans', sans-serif",
        }}>
          <div style={{
            background: '#fff', border: '1px solid #E8E9EE', borderRadius: 12,
            padding: '40px 48px', maxWidth: 480, textAlign: 'center',
            boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111318', marginBottom: 8 }}>
              Something went wrong
            </h2>
            <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 24, lineHeight: 1.6 }}>
              {msg}
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: '#1B2CC1', color: '#fff', border: 'none', borderRadius: 8,
                padding: '10px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
