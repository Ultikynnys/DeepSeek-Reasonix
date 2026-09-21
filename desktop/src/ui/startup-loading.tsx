import { t, useLang } from "../i18n";

export function StartupLoadingOverlay() {
  useLang();
  return (
    <div
      className="startup-loading-overlay"
      role="status"
      aria-live="polite"
      aria-label={t("app.loadingWorkspaces")}
    >
      <div className="startup-loading-card">
        <div className="startup-loading-spinner" />
        <div className="startup-loading-text">
          <div className="startup-loading-title">{t("app.loadingWorkspaces")}</div>
          <div className="startup-loading-sub">{t("app.loadingSessions")}</div>
        </div>
      </div>
    </div>
  );
}
