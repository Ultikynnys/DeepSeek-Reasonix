import type { DeclarativeOutputFilter } from "../declarative-filter.js";

export const BUILTIN_DECLARATIVE_FILTERS: readonly DeclarativeOutputFilter[] = [
  {
    id: "biome-check",
    commandFamily: "biome",
    executable: "biome",
    subcommand: "check",
    stripAnsi: true,
    stripLines: [/^\s*$/, /^Checked \d+ files?/, /^The following command/, /^Run it with/],
    maxLines: 80,
    onEmpty: "biome: ok",
  },
];
