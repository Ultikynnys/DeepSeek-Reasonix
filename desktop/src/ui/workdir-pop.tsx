import { useEffect, useMemo, useRef, useState } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { activationHandler } from "./keyboard";
import { Shortcut } from "./shortcut";

type Anchor = { top?: number; bottom?: number; left: number };

/** One clickable workspace row: folder/terminal icon, name, full path, and a
 *  current-check or remove button. Shared by the pinned Reasonix Local entry
 *  and the recent list. */
function WorkdirRow({
  path,
  label,
  icon,
  isCurrent,
  canRemove,
  onPick,
  onRemove,
}: {
  path: string;
  label?: string;
  icon: React.ReactNode;
  isCurrent: boolean;
  canRemove: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const name = label ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return (
    <div className="wd-row" onClick={onPick} onKeyDown={activationHandler(onPick)} title={path}>
      <span className="ic">{icon}</span>
      <div className="b">
        <div className="p">{name}</div>
        <div className="br">{path}</div>
      </div>
      {isCurrent ? (
        <span className="pin">
          <I.check size={11} />
        </span>
      ) : canRemove ? (
        <button
          type="button"
          className="wd-del"
          title={t("workdir.removeRecent")}
          aria-label={t("workdir.removeRecent")}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onRemove();
            }
          }}
        >
          <I.x size={11} />
        </button>
      ) : null}
    </div>
  );
}

export function WorkdirPop({
  open,
  onClose,
  recent,
  local,
  current,
  anchor,
  onPick,
  onRemove,
  onBrowse,
}: {
  open: boolean;
  onClose: () => void;
  recent: string[];
  /** Local Reasonix workspace dir — pinned above the recents as an always-
   *  available workspace choice. */
  local?: string;
  current?: string;
  anchor?: Anchor;
  onPick: (path: string) => void;
  onRemove?: (path: string) => void;
  onBrowse: () => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
  }, [open]);

  const items = useMemo(() => {
    const list = recent.length > 0 ? recent : current ? [current] : [];
    const q = query.trim().toLowerCase();
    const filtered = q ? list.filter((p) => p.toLowerCase().includes(q)) : list;
    // The local workspace dir is pinned above the list — never duplicate it here.
    return local ? filtered.filter((p) => p !== local) : filtered;
  }, [recent, current, query, local]);

  if (!open) return null;

  const left = anchor?.left ?? 240;
  const positionStyle =
    anchor?.bottom !== undefined
      ? { bottom: anchor.bottom, left }
      : { top: anchor?.top ?? 56, left };

  return (
    <div className="wd-mask" onMouseDown={onClose}>
      <div className="wd-pop" style={positionStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div className="wd-head">
          <I.folder size={12} />
          <span>{t("workdir.title")}</span>
          <span
            style={{
              marginLeft: "auto",
              fontFamily: "Geist Mono, monospace",
              fontSize: 10,
              color: "var(--muted)",
            }}
          >
            <Shortcut keys={["mod", "O"]} />
          </span>
        </div>
        <input
          ref={inputRef}
          className="wd-search"
          placeholder={t("workdir.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter" && items[0]) {
              e.preventDefault();
              onPick(items[0]);
              onClose();
            }
          }}
        />
        <div className="wd-list">
          {local ? (
            <WorkdirRow
              path={local}
              label={t("workdir.reasonixLocal")}
              icon={<I.terminal size={12} />}
              isCurrent={local === current}
              canRemove={false}
              onPick={() => {
                if (local !== current) onPick(local);
                onClose();
              }}
              onRemove={() => undefined}
            />
          ) : null}
          {items.length === 0 && !local ? (
            <div
              style={{
                padding: "16px 12px",
                fontSize: 11.5,
                color: "var(--muted)",
                fontFamily: "Geist Mono, monospace",
              }}
            >
              {t("workdir.empty")}
            </div>
          ) : null}
          {items.map((p) => {
            const isCurrent = p === current;
            return (
              <WorkdirRow
                key={p}
                path={p}
                icon={<I.folder size={12} />}
                isCurrent={isCurrent}
                canRemove={Boolean(onRemove)}
                onPick={() => {
                  if (!isCurrent) onPick(p);
                  onClose();
                }}
                onRemove={() => onRemove?.(p)}
              />
            );
          })}
        </div>
        <div className="wd-foot">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              onBrowse();
              onClose();
            }}
          >
            <I.plus size={11} /> {t("workdir.browse")}
          </button>
        </div>
      </div>
    </div>
  );
}
