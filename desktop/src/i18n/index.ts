import { useEffect, useState } from "react";
import { en } from "./en";

/** The project is English-only. The language never changes. */
export type Lang = "en";

function useTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    setTick((n) => n + 1);
  }, []);
}

/** Constant English locale. Kept so components that re-render on language
 *  change keep working without a mass refactor; it never varies. */
export function useLang(): Lang {
  useTick();
  return "en";
}

type Dict = typeof en;
type Path<T, K extends keyof T = keyof T> = K extends string
  ? T[K] extends Record<string, unknown>
    ? `${K}.${Path<T[K]>}`
    : K
  : never;
export type TKey = Path<Dict>;

function resolve(dict: Dict, key: string): string {
  const parts = key.split(".");
  let cursor: unknown = dict;
  for (const p of parts) {
    if (cursor && typeof cursor === "object" && p in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cursor === "string" ? cursor : key;
}

export function t(key: TKey, params?: Record<string, string | number>): string {
  const raw = resolve(en, key);
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}
