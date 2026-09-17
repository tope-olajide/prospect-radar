import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Root safety net: if any subscription or render throws, the user sees what
 * happened and a way back — never a blank page.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boundary">
          <strong>Radar hit an unexpected error.</strong>
          <p>{this.state.error.message}</p>
          <p className="muted">Your data is safe in Convex — this is a display problem only.</p>
          <div className="inline-actions">
            <button type="button" className="btn" onClick={() => { this.setState({ error: null }); window.location.href = "/"; }}>Go Home</button>
            <button type="button" className="btn ghost" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
