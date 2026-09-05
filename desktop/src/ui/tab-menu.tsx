import { useEffect, useRef, useState } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { useClampedPopupPosition } from "./file-menu";

export type ClearTabsScope = "all" | "right" | "left";

export interface TabMenuProps {
  anchor: { x: number; y: number };
  tabs: readonly { id: string }[];
  activeId: string;
  onClear: (scope: ClearTabsScope) => void;
  onClose: () => void;
}

/**
 * Returns the subset of tabs to clear based on the active tab and scope:
 * - "all": every tab
 * - "right": all tabs to the right of the selected tab
 * - "left": all tabs to the left of the selected tab
 */
export function getTabsToClear<T extends { id: string }>(
  tabs: readonly T[],
  activeId: string,
  scope: ClearTabsScope,
): T[] {
  if (scope === "all") return [...tabs];
  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  if (activeIndex === -1) return [];
  if (scope === "left") return tabs.slice(0, activeIndex);
  if (scope === "right") return tabs.slice(activeIndex + 1);
  return [];
}

/**
 * Dropdown context menu opened on right-clicking the tabs ribbon.
 * Offers options to clear all tabs, tabs to the right, and tabs to the left.
 */
export function TabMenu({ anchor, tabs, activeId, onClear, onClose }: TabMenuProps) {
  useLang();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });

  useClampedPopupPosition(ref, anchor, pos, setPos);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".tab-menu")) onClose();
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

  const items: { scope: ClearTabsScope; label: string; icon: React.ReactNode }[] = [
    {
      scope: "all",
      label: t("app.tab.clearAll"),
      icon: <I.x size={12} />,
    },
    {
      scope: "right",
      label: t("app.tab.clearRight"),
      icon: <I.chevR size={12} />,
    },
    {
      scope: "left",
      label: t("app.tab.clearLeft"),
      icon: <I.chevL size={12} />,
    },
  ];

  return (
    <div
      ref={ref}
      className="file-menu tab-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const count = getTabsToClear(tabs, activeId, item.scope).length;
        return (
          <button
            key={item.scope}
            type="button"
            className="file-menu-item tab-menu-item"
            role="menuitem"
            data-empty={count === 0 ? "true" : undefined}
            onClick={() => {
              onClear(item.scope);
              onClose();
            }}
          >
            <span className="ico">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
