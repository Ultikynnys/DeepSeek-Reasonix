import { Component, type ReactNode } from "react";
import { recordFrontendDiagnostic } from "../diagnostics";
import { t } from "../i18n";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null };

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    recordFrontendDiagnostic(
      "frontend.react_render_error",
      { panel: this.props.label, error, componentStack: info.componentStack },
      "error",
    );
    console.error(`[panel:${this.props.label}] render error`, error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="ctx-empty"
        style={{
          color: "var(--danger, #e25555)",
          padding: 12,
          fontSize: 12,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {t("panel.renderError", { panel: this.props.label })}
        {": "}
        {this.state.error.message}
      </div>
    );
  }
}
