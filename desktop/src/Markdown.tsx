import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, ExternalLink, FileText } from "lucide-react";
import {
  Children,
  type ReactNode,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeView } from "./CodeView";
import { t, useLang } from "./i18n";

/** Reveal a file or directory in the OS file explorer: a file opens its
 *  parent folder with the item selected, a directory opens itself. The
 *  workspace lets the Rust side resolve bare references (e.g. `web.ts`)
 *  to their real location when the joined path doesn't exist. */
export async function revealInExplorer(abs: string, workspace?: string): Promise<void> {
  try {
    await invoke("reveal_in_explorer", { path: abs, workspace: workspace ?? null });
  } catch {
    // Last resort: open the parent directory with the OS default handler.
    await openPath(parentDir(abs));
  }
}

function parentDir(abs: string): string {
  const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
  return idx > 0 ? abs.slice(0, idx) : abs;
}

/** Open a file with the native OS "Open with…" chooser, letting the user pick
 *  which app handles it (notepad++, notepad, etc.) instead of a code editor. */
export async function openWithDialog(abs: string): Promise<void> {
  await invoke("open_with_dialog", { path: abs });
}

type WorkspaceCtx = { dir?: string };
export const WorkspaceContext = createContext<WorkspaceCtx>({});
export const WorkspaceProvider = WorkspaceContext.Provider;

export function resolveAgainstWorkspace(rel: string, ws: string | undefined): string {
  if (!ws) return rel;
  const isWindows = ws.includes("\\");
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/")) {
    return isWindows ? rel.replace(/\//g, "\\") : rel;
  }
  const sep = isWindows ? "\\" : "/";
  const trimmed = ws.replace(/[\\/]$/, "");
  const relative = rel.replace(/^\.[\\/]/, "").replace(/\//g, sep);
  return `${trimmed}${sep}${relative}`;
}

const KNOWN_EXTS =
  "ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rs|go|json|jsonc|md|mdx|css|scss|less|html|htm|xml|svg|yaml|yml|toml|sh|bash|zsh|fish|sql|rb|java|kt|swift|c|cpp|cc|cxx|h|hpp|hxx|cs|php|lua|dart|ex|exs|erl|hs|clj|cljs|zig|vue|svelte|graphql|gql|proto";
const PATH_SEG = "[\\w.@()+~%#=-]+";
const FILE_NAME_SOURCE = `${PATH_SEG}\\.(?:${KNOWN_EXTS})`;
const GENERIC_FILE_NAME_SOURCE = `${PATH_SEG}\\.[A-Za-z0-9_-]{1,16}`;
function fileRefSource(fileNameSource: string): string {
  return [
    `[A-Za-z]:[\\\\/](?:${PATH_SEG}[\\\\/])*${fileNameSource}`,
    `/(?:${PATH_SEG}[\\\\/])*${fileNameSource}`,
    `(?:\\.{1,2}[\\\\/])?(?:${PATH_SEG}[\\\\/])+${fileNameSource}`,
    fileNameSource,
  ].join("|");
}
const FILE_REF_SOURCE = fileRefSource(FILE_NAME_SOURCE);
const GENERIC_FILE_REF_SOURCE = fileRefSource(GENERIC_FILE_NAME_SOURCE);
const GENERIC_PATH_SOURCE = [
  `[A-Za-z]:[\\\\/](?:${PATH_SEG}[\\\\/])*${GENERIC_FILE_NAME_SOURCE}`,
  `/(?:${PATH_SEG}[\\\\/])*${GENERIC_FILE_NAME_SOURCE}`,
  `(?:\\.{1,2}[\\\\/])?(?:${PATH_SEG}[\\\\/])+${GENERIC_FILE_NAME_SOURCE}`,
].join("|");
const LINE_VALUE_SOURCE = "\\d+(?::\\d+)?(?:-\\d+)?";
// No lookbehind here: Tauri's WKWebView on macOS Monterey (Safari < 16.4)
// cannot parse it. Generic extensions require a line suffix in prose to
// avoid turning ordinary dotted words into file references.
const FILE_PATH_RE = new RegExp(
  `(^|[\\s\`'"(\\[])((?:${FILE_REF_SOURCE}|${GENERIC_PATH_SOURCE})(?::${LINE_VALUE_SOURCE})?|(?:${GENERIC_FILE_REF_SOURCE}):${LINE_VALUE_SOURCE})(?=[\\s.,;!?\\]\\)'"\`]|$)`,
  "g",
);
const EXACT_FILE_REF_RE = new RegExp(`^(${GENERIC_FILE_REF_SOURCE})(?::(${LINE_VALUE_SOURCE}))?$`);

type ParsedFileRef = { path: string; line?: string };

function parseFileRef(value: string): ParsedFileRef | null {
  const trimmed = value.trim();
  const m = EXACT_FILE_REF_RE.exec(trimmed);
  if (!m) return null;
  return { path: m[1]!, line: m[2] };
}

function decodeMaybeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function stripFileScheme(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  let raw = decodeMaybeUri(value.replace(/^file:\/\//i, ""));
  if (/^\/[a-zA-Z]:[\\/]/.test(raw)) raw = raw.slice(1);
  return raw;
}

function protocolScheme(value: string): string | null {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return null;
  return /^([a-z][\w+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
}

function parseFileHref(value: string): ParsedFileRef | null {
  const stripped = stripFileScheme(value);
  const decoded = decodeMaybeUri(stripped);
  const hashLine = /#L?(\d+)/i.exec(decoded)?.[1];
  const clean = decoded.split("#")[0]!.split("?")[0]!;
  const parsed = parseFileRef(clean);
  if (!parsed) return null;
  return { ...parsed, line: parsed.line ?? hashLine };
}

type WorkspaceFileResolution =
  | { status: "exact" | "unique"; path: string }
  | { status: "ambiguous"; paths: string[] }
  | { status: "not_found" };

function FilePill({ path, line }: { path: string; line?: string }) {
  useLang();
  const ctx = useContext(WorkspaceContext);
  const [done, setDone] = useState<"open" | "copy" | "not-found" | null>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstMatchRef = useRef<HTMLButtonElement>(null);
  const matchesId = useId();
  const display = line ? `${path}:${line}` : path;
  const showDone = (state: "open" | "copy" | "not-found") => {
    setDone(state);
    if (state !== "not-found") setTimeout(() => setDone(null), 1200);
  };
  useEffect(() => {
    if (matches.length === 0) return;
    firstMatchRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setMatches([]);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMatches([]);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [matches]);
  const revealResolved = async (resolved: string) => {
    await revealInExplorer(resolved);
    setMatches([]);
    showDone("open");
  };
  const openInExplorer = async () => {
    if (matches.length > 0) {
      setMatches([]);
      return;
    }
    setDone(null);
    try {
      const result = await invoke<WorkspaceFileResolution>("resolve_workspace_file", {
        path,
        workspace: ctx.dir ?? null,
      });
      if (result.status === "exact" || result.status === "unique") {
        await revealResolved(result.path);
      } else if (result.status === "ambiguous") {
        setMatches(result.paths);
        setDone(null);
      } else {
        setMatches([]);
        showDone("not-found");
      }
    } catch {
      setMatches([]);
      showDone("not-found");
    }
  };
  const copyOnly = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(display);
      showDone("copy");
    } catch {
      /* ignore */
    }
  };
  return (
    <span className="file-pill-wrap" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`file-pill ${done ? `done ${done}` : ""}`}
        onClick={openInExplorer}
        aria-expanded={matches.length > 0}
        aria-controls={matches.length > 0 ? matchesId : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          void copyOnly(e);
        }}
        title={
          done === "not-found" ? t("markdown.fileNotFound", { path }) : t("markdown.filePillTitle")
        }
      >
        <FileText size={10} className="file-pill-icon" />
        <span className="file-pill-path">{path}</span>
        {line && <span className="file-pill-line">:{line}</span>}
        {(done === "open" || done === "copy") && <Check size={10} className="file-pill-check" />}
      </button>
      <output className="sr-only" aria-live="polite">
        {done === "not-found" ? t("markdown.fileNotFound", { path }) : ""}
      </output>
      {matches.length > 0 && (
        <span id={matchesId} className="file-pill-matches">
          <span className="file-pill-matches-label">{t("markdown.selectWorkspaceFile")}</span>
          {matches.map((match, index) => (
            <button
              key={match}
              ref={index === 0 ? firstMatchRef : undefined}
              type="button"
              title={match}
              onClick={() => revealResolved(match)}
            >
              {match}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function splitFilePaths(text: string): ReactNode[] | string {
  FILE_PATH_RE.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null = FILE_PATH_RE.exec(text);
  while (m !== null) {
    const prefix = m[1] ?? "";
    const reference = m[2]!;
    const parsed = parseFileRef(reference);
    const pillStart = m.index + prefix.length;
    if (pillStart > last) out.push(text.slice(last, pillStart));
    if (parsed) {
      out.push(<FilePill key={`fp-${pillStart}`} path={parsed.path} line={parsed.line} />);
    } else {
      out.push(reference);
    }
    last = pillStart + reference.length;
    m = FILE_PATH_RE.exec(text);
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type AnyProps = { children?: ReactNode } & Record<string, unknown>;

function withFilePills(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return splitFilePaths(child);
    if (isValidElement(child)) {
      if (typeof child.type === "string" && ["a", "code", "pre"].includes(child.type)) {
        return child;
      }
      const props = child.props as AnyProps;
      if (props.children !== undefined) {
        return cloneElement(child, undefined, withFilePills(props.children));
      }
    }
    return child;
  });
}

/**
 * Convert bracket-style math delimiters to dollar-style so they survive
 * the markdown parser (which would otherwise consume the backslash in `\[`
 * as an escape). Handles both display math \[...\] → $$...$$ and inline
 * math \(...\) → $...$.
 *
 * Protects `\\[` sequences (LaTeX line-break spacing like `\\[4pt]`)
 * from being mangled — the regex must not match the `\[` inside `\\[`.
 */
function normalizeMathDelimiters(source: string): string {
  // Protect LaTeX line-break spacing \\[ ... ] — use a sentinel that
  // can't appear in normal text.
  const LB = "\x00LB\x00";
  let result = source.replace(/\\\\\[/g, LB);
  result = result
    // display math: \[ ... \] → $$ ... $$
    .replace(/\\\[/g, "$$$$")
    .replace(/\\\]/g, "$$$$")
    // inline math: \( ... \) → $ ... $
    .replace(/\\\(/g, "$$")
    .replace(/\\\)/g, "$$");
  // Restore protected sequences
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL sentinel cannot appear in normal text — the marker is the point
  result = result.replace(/\x00LB\x00/g, "\\\\[");
  return result;
}

export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={{
          pre: ({ children }) => {
            // react-markdown v9 nests children unpredictably — flatten all text.
            const rawText = flattenChildText(children).trimEnd();
            return <CodeBlock lang={extractFencedLang(children)} text={rawText} />;
          },
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const parsed = !className ? parseFileRef(text.trim()) : null;
            if (parsed) return <FilePill path={parsed.path} line={parsed.line} />;
            return <code className={className}>{children}</code>;
          },
          a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
          p: ({ children }) => <p>{withFilePills(children)}</p>,
          li: ({ children }) => <li>{withFilePills(children)}</li>,
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
          td: ({ children }) => <td>{withFilePills(children)}</td>,
        }}
      >
        {normalizeMathDelimiters(source)}
      </ReactMarkdown>
    </div>
  );
});

function SafeLink({ href, children }: { href?: string; children: ReactNode }) {
  useLang();
  const ctx = useContext(WorkspaceContext);
  const [done, setDone] = useState(false);
  const scheme = href ? protocolScheme(href) : null;
  const isExternal = !!scheme && scheme !== "file";
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!href) return;
    if (isExternal) {
      try {
        await openUrl(href);
      } catch {
        window.open(href, "_blank", "noopener,noreferrer");
      }
      return;
    }
    try {
      const parsed = parseFileHref(href);
      const target = parsed ?? { path: decodeMaybeUri(stripFileScheme(href)) };
      const abs = resolveAgainstWorkspace(target.path, ctx.dir);
      await revealInExplorer(abs, ctx.dir);
    } catch {
      try {
        await navigator.clipboard.writeText(href);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      } catch {
        /* ignore */
      }
    }
  };
  return (
    <a
      href={href ?? "#"}
      onClick={onClick}
      className={`md-link ${isExternal ? "external" : "local"} ${done ? "done" : ""}`}
      title={
        isExternal
          ? t("markdown.externalLinkTitle", { href: href ?? "" })
          : t("markdown.localLinkTitle", { href: href ?? "" })
      }
    >
      {children}
      {isExternal ? (
        <ExternalLink size={10} className="md-link-icon" />
      ) : done ? (
        <Check size={10} className="md-link-icon" />
      ) : null}
    </a>
  );
}

export function extractFencedLang(children: ReactNode): string {
  for (const kid of Children.toArray(children)) {
    if (isValidElement(kid)) {
      const cls = (kid.props as Record<string, unknown>).className;
      if (typeof cls === "string") {
        const m = cls.match(/language-([\w-]+)/);
        if (m) return m[1]!;
      }
    }
  }
  return "text";
}

function flattenChildText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenChildText).join("");
  if (isValidElement(node))
    return flattenChildText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ lang, text }: { lang: string; text: string }): ReactNode {
  useLang();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang}</span>
        <span className="codeblock-copy-wrap">
          <button type="button" className={`copy-btn ${copied ? "done" : ""}`} onClick={onCopy}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </span>
      </div>
      <CodeView text={text} lang={lang} />
    </div>
  );
}
