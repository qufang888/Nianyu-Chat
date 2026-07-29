import React from 'react';
import { playSoundSync } from '../utils/sound';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 渲染崩溃时播放报错弹窗音效
    playSoundSync('error');
    // 同时把错误推给全局错误处理器，便于诊断
    try {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', error, info);
    } catch {
      /* ignore */
    }
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: 40,
            boxSizing: 'border-box',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          <h1 style={{ fontSize: 24, marginBottom: 12, color: '#e74c3c' }}>
            {'\u26A0\uFE0F'} Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: '#666', marginBottom: 8, textAlign: 'center', maxWidth: 500 }}>
            {this.state.error?.message || 'An unexpected error occurred in the application.'}
          </p>
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 16,
              padding: '10px 24px',
              fontSize: 14,
              backgroundColor: '#1677ff',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Reload Application
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
