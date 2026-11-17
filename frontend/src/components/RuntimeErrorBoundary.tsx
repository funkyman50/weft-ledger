import { Component } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { downloadDiagnostics } from '../lib/diagnostics'

export class RuntimeErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return <main className="bp-runtime-recovery">
        <div className="bp-callout bp-callout--error" role="alert">
          <strong>Weft couldn’t display this page.</strong>
          <p>Download this page’s diagnostics before reloading. The report contains technical events, without account details or credentials.</p>
        </div>
        <div className="bp-button-group">
          <Button size="lg" onClick={() => downloadDiagnostics()}>Download browser diagnostics</Button>
          <Button size="lg" variant="primary" onClick={() => window.location.reload()}>Reload Weft</Button>
        </div>
      </main>
    }
    return this.props.children
  }
}
