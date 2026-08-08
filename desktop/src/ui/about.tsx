import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check as checkUpdate } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../format";
import { t } from "../i18n";
import { I } from "../icons";
import { escapeHandler } from "./keyboard";

const REPO_URL = "https://github.com/Ultikynnys/DeepSeek-Reasonix";
const RELEASES_PAGE = `${REPO_URL}/releases`;

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; latest: string }
  | { kind: "outdated"; latest: string; update: Update }
  | { kind: "downloading"; latest: string; downloaded: number; total: number | null }
  | { kind: "installing"; latest: string }
  | { kind: "error"; message: string; source: "check" | "install" };

export function AboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  const openGitHub = useCallback(() => {
    void openUrl(REPO_URL).catch(() => undefined);
  }, []);
  const openReleases = useCallback(() => {
    void openUrl(RELEASES_PAGE).catch(() => undefined);
  }, []);

  const checkForUpdates = useCallback(async () => {
    setCheck({ kind: "checking" });
    try {
      const update = await checkUpdate();
      if (!update) {
        setCheck({ kind: "up-to-date", latest: __APP_VERSION__ });
      } else {
        setCheck({ kind: "outdated", latest: update.version, update });
      }
    } catch (err) {
      setCheck({ kind: "error", message: (err as Error).message, source: "check" });
    }
  }, []);

  const installUpdate = useCallback(async (update: Update) => {
    setCheck({ kind: "downloading", latest: update.version, downloaded: 0, total: null });
    try {
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          setCheck({
            kind: "downloading",
            latest: update.version,
            downloaded: 0,
            total: evt.data.contentLength ?? null,
          });
        } else if (evt.event === "Progress") {
          setCheck((prev) =>
            prev.kind === "downloading"
              ? { ...prev, downloaded: prev.downloaded + evt.data.chunkLength }
              : prev,
          );
        } else if (evt.event === "Finished") {
          setCheck((prev) =>
            prev.kind === "downloading"
              ? { ...prev, downloaded: prev.total ?? prev.downloaded }
              : prev,
          );
        }
      });
      setCheck({ kind: "installing", latest: update.version });
      await relaunch();
    } catch (err) {
      setCheck({ kind: "error", message: (err as Error).message, source: "install" });
    }
  }, []);

  return (
    <div className="about-mask" onClick={onClose} onKeyDown={escapeHandler(onClose)} tabIndex={-1}>
      <div
        className="about-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="about-close"
          onClick={onClose}
          aria-label={t("about.close")}
        >
          <I.x size={14} />
        </button>
        <div className="about-brand">
          <div className="about-name">Reasonix</div>
          <div className="about-tagline">{t("about.tagline")}</div>
        </div>
        <div className="about-meta">
          <div className="about-row">
            <span className="about-label">{t("about.version")}</span>
            <code className="about-value">{__APP_VERSION__}</code>
          </div>
          <div className="about-row">
            <span className="about-label">{t("about.repo")}</span>
            <button type="button" className="about-link" onClick={openGitHub}>
              <I.link size={12} />
              <span>Ultikynnys/DeepSeek-Reasonix</span>
            </button>
          </div>
        </div>
        <div className="about-actions">
          <button
            type="button"
            className="about-check"
            onClick={checkForUpdates}
            disabled={
              check.kind === "checking" ||
              check.kind === "downloading" ||
              check.kind === "installing"
            }
          >
            <I.rotate size={12} />
            <span>{check.kind === "checking" ? t("about.checking") : t("about.checkUpdates")}</span>
          </button>
          <CheckStatus check={check} onOpenReleases={openReleases} onInstall={installUpdate} />
        </div>
      </div>
    </div>
  );
}

function CheckStatus({
  check,
  onOpenReleases,
  onInstall,
}: {
  check: CheckState;
  onOpenReleases: () => void;
  onInstall: (update: Update) => void;
}) {
  if (check.kind === "idle" || check.kind === "checking") return null;
  if (check.kind === "up-to-date") {
    return (
      <div className="about-status ok">
        <I.check size={12} />
        <span>{t("about.upToDate", { version: check.latest })}</span>
      </div>
    );
  }
  if (check.kind === "outdated") {
    return (
      <div className="about-status warn">
        <div className="about-update-line">
          <span>{t("about.updateAvailable", { version: check.latest })}</span>
          <button type="button" className="about-link" onClick={onOpenReleases}>
            <I.download size={12} />
            <span>{t("about.openReleases")}</span>
          </button>
        </div>
        <button type="button" className="about-install" onClick={() => onInstall(check.update)}>
          <I.download size={12} />
          <span>{t("about.downloadAndInstall")}</span>
        </button>
      </div>
    );
  }
  if (check.kind === "downloading") {
    const ratio =
      check.total && check.total > 0 ? Math.min(1, check.downloaded / check.total) : null;
    return (
      <div className="about-status warn">
        <span>
          {ratio !== null
            ? t("about.downloading", { pct: Math.round(ratio * 100) })
            : t("about.downloadingUnknown", { downloaded: formatBytes(check.downloaded) })}
        </span>
        {ratio !== null ? (
          <div className="about-meter" aria-label="download progress">
            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
        ) : null}
      </div>
    );
  }
  if (check.kind === "installing") {
    return (
      <div className="about-status warn">
        <span>{t("about.installing")}</span>
      </div>
    );
  }
  return (
    <div className="about-status err">
      <span>
        {check.source === "install"
          ? t("about.updateFailed", { message: check.message })
          : t("about.checkFailed", { message: check.message })}
      </span>
    </div>
  );
}
