import { EN } from "./EN.js";
import type { TranslationSchema } from "./types.js";

/** The project is English-only. All translations resolve from the English dictionary. */
const translations: TranslationSchema = EN;

/** Simple t() — nested keys (e.g. "common.error") + param replacement (e.g. "{code}"). */
export function t(path: string, params?: Record<string, string | number>): string {
  const parts = path.split(".");
  let val: any = translations;

  for (const part of parts) {
    val = val?.[part];
    if (val === undefined) break;
  }

  if (typeof val !== "string") {
    return path;
  }

  if (params) {
    let result = val;
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
    return result;
  }

  return val;
}
