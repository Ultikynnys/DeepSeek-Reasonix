export interface DeclarativeOutputFilter {
  id: string;
  commandFamily: string;
  executable: string;
  subcommand?: string;
  stripAnsi?: boolean;
  stripLines?: RegExp[];
  keepLines?: RegExp[];
  maxLines?: number;
  onEmpty?: string;
}

export interface DeclarativeFilterResult {
  output: string;
  changed: boolean;
  truncated: boolean;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export function validateDeclarativeFilter(filter: DeclarativeOutputFilter): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(filter.id)) throw new Error(`invalid filter id: ${filter.id}`);
  if (!/^[a-z0-9][a-z0-9+._-]*$/i.test(filter.executable)) {
    throw new Error(`invalid exact executable: ${filter.executable}`);
  }
  if (filter.subcommand && /\s/.test(filter.subcommand)) {
    throw new Error(`subcommand must be one exact argv token: ${filter.subcommand}`);
  }
  if (filter.stripLines?.length && filter.keepLines?.length) {
    throw new Error("stripLines and keepLines are mutually exclusive");
  }
  if (
    filter.maxLines !== undefined &&
    (!Number.isInteger(filter.maxLines) || filter.maxLines < 1)
  ) {
    throw new Error("maxLines must be a positive integer");
  }
}

export function declarativeFilterMatches(
  filter: DeclarativeOutputFilter,
  argv: readonly string[],
): boolean {
  validateDeclarativeFilter(filter);
  const executable = argv[0]?.replaceAll("\\", "/").split("/").pop();
  if (executable !== filter.executable) return false;
  return filter.subcommand === undefined || argv[1] === filter.subcommand;
}

export function applyDeclarativeFilter(
  filter: DeclarativeOutputFilter,
  raw: string,
): DeclarativeFilterResult {
  validateDeclarativeFilter(filter);
  let text = filter.stripAnsi ? stripAnsi(raw) : raw;
  let lines = text.split(/\r?\n/);
  if (filter.stripLines?.length) {
    lines = lines.filter((line) => !filter.stripLines!.some((rule) => rule.test(line)));
  } else if (filter.keepLines?.length) {
    lines = lines.filter((line) => filter.keepLines!.some((rule) => rule.test(line)));
  }
  let truncated = false;
  if (filter.maxLines !== undefined && lines.length > filter.maxLines) {
    const hidden = lines.length - filter.maxLines;
    lines = [...lines.slice(0, filter.maxLines), `[… ${hidden} lines omitted by ${filter.id} …]`];
    truncated = true;
  }
  text = lines.join("\n").trim();
  if (!text && filter.onEmpty) text = filter.onEmpty;
  return { output: text, changed: text !== raw.trim(), truncated };
}
