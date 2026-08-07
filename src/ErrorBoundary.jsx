import React from 'react';

function reportClientError(payload) {
  const body = JSON.stringify({
    ...payload,
    href: typeof window !== 'undefined' ? window.location.href : null,
  });

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon('/api/client-errors', blob);
    return;
  }

  fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
    this.handleBrowserError = this.handleBrowserError.bind(this);
    this.handlePromiseRejection = this.handlePromiseRejection.bind(this);
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected error occurred.',
    };
  }

  componentDidCatch(error, info) {
    console.error('[ui-error-boundary] Render failure', error, info);
    reportClientError({
      category: 'render_error',
      severity: 'error',
      message: error?.message || 'Render failure',
      stack: error?.stack || null,
      componentStack: info?.componentStack || null,
    });
  }

  componentDidMount() {
    window.addEventListener('error', this.handleBrowserError);
    window.addEventListener('unhandledrejection', this.handlePromiseRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.handleBrowserError);
    window.removeEventListener('unhandledrejection', this.handlePromiseRejection);
  }

  handleBrowserError(event) {
    if (this.state.hasError) return;
    reportClientError({
      category: 'window_error',
      severity: 'error',
      message: event?.error?.message || event?.message || 'An unexpected browser error occurred.',
      stack: event?.error?.stack || null,
    });
    this.setState({
      hasError: true,
      errorMessage: event?.error?.message || event?.message || 'An unexpected browser error occurred.',
    });
  }

  handlePromiseRejection(event) {
    if (this.state.hasError) return;
    reportClientError({
      category: 'unhandled_rejection',
      severity: 'error',
      message: event?.reason?.message || 'An unexpected async error occurred.',
      stack: event?.reason?.stack || null,
      extra: typeof event?.reason === 'string' ? event.reason : null,
    });
    this.setState({
      hasError: true,
      errorMessage: event?.reason?.message || 'An unexpected async error occurred.',
    });
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="app-error-shell">
        <div className="app-error-card">
          <p className="eyebrow">Application error</p>
          <h1>Something went wrong</h1>
          <p>
            We hit an unexpected error while rendering this page. Reload the app to continue.
          </p>
          <p className="app-error-message">{this.state.errorMessage}</p>
          <div className="app-error-actions">
            <button className="btn-red" type="button" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}