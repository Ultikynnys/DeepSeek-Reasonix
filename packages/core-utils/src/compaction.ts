/** Prefix the context-manager prepends when fold replaces older turns with a synthesized recap.
 *  Single-sourced here so the agent producer (src/context-manager) and the three UI surfaces
 *  (TUI, Desktop, Dashboard) all agree on the wire string. */
export const COMPACTION_SUMMARY_MARKER =
  "[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\n";

export function isCompactionSummary(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith(COMPACTION_SUMMARY_MARKER);
}

export function stripCompactionMarker(text: string): string {
  return text.startsWith(COMPACTION_SUMMARY_MARKER)
    ? text.slice(COMPACTION_SUMMARY_MARKER.length)
    : text;
}

/** Tag of the machine-readable marker the fold's file-triage step appends to the
 *  summary message when it drops paths from the session's "Files in context" list.
 *  Single-sourced here so the producer (src/context-manager) and the consumers
 *  (desktop panel, session reload derivation) agree on the wire string. */
export const FILES_DROPPED_TAG = "files-dropped-from-context";

/** Matches every marker block in a text payload (e.g. a loaded summary message). */
export const FILES_DROPPED_MARKER_REGEX = new RegExp(
  `<${FILES_DROPPED_TAG}>([\\s\\S]*?)</${FILES_DROPPED_TAG}>`,
  "g",
);

/** Builds the marker block persisted in the fold summary message. */
export function buildFilesDroppedMarker(paths: readonly string[]): string {
  return `<${FILES_DROPPED_TAG}>\n${paths.join("\n")}\n</${FILES_DROPPED_TAG}>`;
}

/** Extracts the paths from every marker block in a text payload (deduped, order kept). */
export function parseFilesDroppedMarker(text: string): string[] {
  const out: string[] = [];
  FILES_DROPPED_MARKER_REGEX.lastIndex = 0;
  for (const match of text.matchAll(FILES_DROPPED_MARKER_REGEX)) {
    for (const line of (match[1] ?? "").split("\n")) {
      const path = line.trim();
      if (path.length > 0) out.push(path);
    }
  }
  return [...new Set(out)];
}
