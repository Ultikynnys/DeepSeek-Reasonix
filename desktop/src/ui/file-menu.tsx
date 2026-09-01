import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openWithDialog, revealInExplorer } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";

type MenuItem = { label: string; icon: React.ReactNode; onSelect: () => void };

/** Clamp a context menu anchored at (x, y) inside the viewport, keeping an 8px margin. */
function useClampedMenuPosition(
  ref: { current: HTMLDivElement | null },
  anchor: { x: number; y: number },
  pos: { left: number; top: number },
  setPos: (next: { left: number; top: number }) => void,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + pad > vw) left = Math.max(pad, vw - rect.width - pad);
    if (top + rect.height + pad > vh) top = Math.max(pad, vh - rect.height - pad);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [ref.current, anchor.x, anchor.y, pos.left, pos.top, setPos]);
}

/**
 * Shared right-click menu for a file path. Offers "Show in file explorer"
 * (reveals the file/directory in the OS file manager), "Open with…" (the
 * native OS app picker), and "Copy path". Dismisses on outside click or Escape.
 */
export function FileMenu({
  anchor,
  abs,
  onClose,
}: {
  anchor: { x: number; y: number };
  abs: string;
  onClose: () => void;
}) {
  useLang();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });
  useClampedMenuPosition(ref, anchor, pos, setPos);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".file-menu")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const open = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch {
      /* ignore — the OS picker / explorer reveal is best-effort */
    }
    onClose();
  };

  const items: MenuItem[] = [
    {
      label: t("fileMenu.showInExplorer"),
      icon: <I.link size={12} />,
      onSelect: open(() => revealInExplorer(abs)),
    },
    {
      label: t("fileMenu.openWith"),
      icon: <I.external size={12} />,
      onSelect: open(() => openWithDialog(abs)),
    },
    {
      label: t("fileMenu.copyPath"),
      icon: <I.copy size={12} />,
      onSelect: () => {
        void navigator.clipboard?.writeText(abs)?.catch(() => undefined);
        onClose();
      },
    },
  ];

  return (
    <div
      ref={ref}
      className="file-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="file-menu-item"
          role="menuitem"
          onClick={item.onSelect}
        >
          <span className="ico">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
