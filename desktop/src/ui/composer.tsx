import { KNOWN_MODELS, SUPPORTED_IMAGE_EXTENSIONS, modelAcceptsImages } from "@reasonix/core-utils";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import { type TKey, t } from "../i18n";
import { I } from "../icons";
import { isImagePath, resolveImagePath } from "../image-attach";
import type { EditMode, ReasoningEffort } from "../protocol";
import { DEFAULT_COMPOSER_ROWS, applyComposerTextareaAutosize } from "./composer-sizing";
import { activationHandler } from "./keyboard";
import { TimerSpan } from "./live";
import { Shortcut } from "./shortcut";
export type { EditMode, ReasoningEffort };

type ModeEntry = { k: EditMode; label: TKey; icon: React.ReactNode; hint: TKey };

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

const MODE_INFO: ModeEntry[] = [
  { k: "plan", label: "editMode.plan", icon: <I.list size={11} />, hint: "editMode.planHint" },
  {
    k: "review",
    label: "editMode.review",
    icon: <I.shield size={11} />,
    hint: "editMode.reviewHint",
  },
  { k: "auto", label: "editMode.auto", icon: <I.zap size={11} />, hint: "editMode.autoHint" },
  { k: "yolo", label: "editMode.yolo", icon: <I.warn size={11} />, hint: "editMode.yoloHint" },
];

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: EditMode;
  onChange: (m: EditMode) => void;
}) {
  return (
    <div className="mode-switch" data-mode={mode}>
      {MODE_INFO.map((m) => (
        <button
          key={m.k}
          type="button"
          className="ms-seg"
          data-on={mode === m.k}
          data-k={m.k}
          onClick={() => onChange(m.k)}
          title={t(m.hint)}
        >
          {m.icon}
          <span>{t(m.label)}</span>
        </button>
      ))}
    </div>
  );
}

export type SlashCmd = {
  cmd: string;
  desc: string;
  run: () => void;
  kb?: string;
  insertOnly?: boolean;
};
export type MentionItem = {
  name: string;
  kind: "file" | "dir" | "url" | "agent" | "clip";
  desc?: string;
};

export type Chip = { kind: "at"; label: string } | { kind: "slash"; label: string };

type Popup = { kind: "slash"; query: string } | { kind: "at"; query: string; nonce: number } | null;

function slashIcon(cmd: string) {
  const m: Record<string, React.ReactNode> = {
    "/clear": <I.x size={12} />,
    "/new": <I.plus size={12} />,
    "/abort": <I.stop size={12} />,
    "/copy": <I.layers size={12} />,
    "/export": <I.download size={12} />,
    "/model": <I.cpu size={12} />,
    "/theme": <I.sun size={12} />,
    "/lang": <I.globe size={12} />,
  };
  return m[cmd] || <I.slash size={12} />;
}

/** Parent dir of the current @ query, with trailing slash. `null` = no parent to show (at workspace root). */
function parentOfAtQuery(query: string): string | null {
  const normalized = query.replace(/\\/g, "/");
  const trailingSlash = normalized.endsWith("/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return null;
  const dirContext = trailingSlash ? normalized.slice(0, -1) : normalized.slice(0, lastSlash);
  if (!dirContext) return null;
  const parentIdx = dirContext.lastIndexOf("/");
  return parentIdx >= 0 ? `${dirContext.slice(0, parentIdx)}/` : "";
}

function atIcon(k: MentionItem["kind"]) {
  if (k === "file") return <I.file size={12} />;
  if (k === "dir") return <I.folder size={12} />;
  if (k === "url") return <I.globe size={12} />;
  if (k === "agent") return <I.bot size={12} />;
  if (k === "clip") return <I.layers size={12} />;
  return <I.at size={12} />;
}

export function Composer({
  draft,
  setDraft,
  onSend,
  onAbort,
  disabled,
  busy,
  busyLabel,
  modelLabel,
  reasoningEffort,
  onModelChange,
  onEffortChange,
  editMode,
  onEditModeChange,
  /** Dynamically fetched Ollama models (`GET {base}/models`) — rendered as a scrollable
   *  group under the known models so the hundreds Ollama offers stay browsable. */
  ollamaModels,
  ollamaModelsError,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  antigravityModels,
  textareaRef,
  slashCommands,
  onMentionQuery,
  onMentionPreview,
  onMentionPicked,
  mentionResults,
  workspaceDir,
  queuedSends,
  onQueueWhileBusy,
  onDequeueSend,
  onSendNow,
  pendingImages,
  onRemoveImage,
  imageCapable,
  onPasteImage,
  onImageRejected,
  onPickImage,
}: {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  onSend: () => void;
  onAbort: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Replaces the hint-row left side while the agent is running — typically "Reasoning" or "Skill · <name>". */
  busyLabel?: string;
  modelLabel: string;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  editMode: EditMode;
  onEditModeChange: (mode: EditMode) => void;
  /** Dynamically fetched Ollama models (raw ids, e.g. `llama3.1:latest`). */
  ollamaModels?: string[];
  /** Why the fetch failed — replaces the list so the failure isn't silent. */
  ollamaModelsError?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Re-fetch the Ollama model list (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  /** Exact model ids returned by the signed-in Antigravity account. */
  antigravityModels?: string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  slashCommands: SlashCmd[];
  onMentionQuery?: (q: string, nonce: number) => void;
  onMentionPreview?: (path: string, nonce: number) => void;
  onMentionPicked?: (path: string) => void;
  mentionResults?: { nonce: number; query: string; results: string[] } | null;
  workspaceDir?: string;
  /** Messages typed while busy=true; rendered as removable chips above the textarea and auto-drained FIFO on turn-complete. */
  queuedSends?: string[];
  /** Called when the user presses Enter while busy with a non-empty draft. Owns clearing the draft. */
  onQueueWhileBusy?: (text: string) => void;
  onDequeueSend?: (index: number) => void;
  /** Sends the whole queue immediately — the app aborts the running turn so the drain fires on turn-complete. */
  onSendNow?: () => void;
  /** Vision attachments queued for the next send (ChatGPT models only). */
  pendingImages?: { id: string; thumbnail: string }[];
  onRemoveImage?: (id: string) => void;
  /** True when the active model accepts image content (gpt-*). */
  imageCapable?: boolean;
  /** Vision path for clipboard images — bytes downscaled and attached. */
  onPasteImage?: (file: File) => Promise<void>;
  /** Fired when a paste is dropped because the active model can't accept
   *  image attachments. Lets the app explain and point at vision models. */
  onImageRejected?: () => void;
  /** Vision path for picked/dropped image paths — daemon reads the bytes. */
  onPickImage?: (path: string) => void;
}) {
  const [chips, setChips] = useState<Chip[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const nonceRef = useRef(0);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  // macOS Chinese IME fires compositionend BEFORE the confirm keydown.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const [browseIdx, setBrowseIdx] = useState(-1);
  const savedDraftRef = useRef("");

  const insertMention = (picked: string) => {
    // ChatGPT models auto-attach supported image paths (paperclip / drag-drop
    // / paste) instead of text-mentioning them — the daemon reads the bytes.
    if (imageCapable && onPickImage && isImagePath(picked)) {
      onPickImage(resolveImagePath(picked, workspaceDir));
      return;
    }
    const rel =
      workspaceDir && picked.startsWith(workspaceDir)
        ? picked.slice(workspaceDir.length).replace(/^[\\/]+/, "")
        : picked;
    setDraft((current) => (current ? `${current.replace(/\s+$/, "")} @${rel} ` : `@${rel} `));
    setChips((c) => [...c, { kind: "at", label: rel }]);
    onMentionPicked?.(rel);
    textareaRef.current?.focus();
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    applyComposerTextareaAutosize(textarea);
  });

  // Programmatic draft transitions to "/" (e.g. /help suggestion in EmptyState, #929) must open the slash popup, since handleChange only fires on actual user input.
  const prevDraftRef = useRef(draft);
  useEffect(() => {
    const prev = prevDraftRef.current;
    prevDraftRef.current = draft;
    if (draft === "/" && prev !== "/") {
      setPopup({ kind: "slash", query: "" });
    }
  }, [draft]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelWrapRef.current && !modelWrapRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen]);

  const attachFile = async (filter?: "image") => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        defaultPath: workspaceDir,
        filters:
          filter === "image"
            ? [
                {
                  name: t("composer.imageFilterName"),
                  // Only raster formats the daemon reads (png/jpg/jpeg/webp) go
                  // down the vision path; keep the wider list for @-mentions.
                  extensions: imageCapable
                    ? [...SUPPORTED_IMAGE_EXTENSIONS]
                    : ["png", "jpg", "jpeg", "gif", "webp", "svg"],
                },
              ]
            : undefined,
      });
      if (typeof picked !== "string" || !picked) return;
      // gif/svg fall back to an @-mention (matching drag-drop) so a send can
      // never abort on a pick the daemon's accept-list doesn't read.
      if (filter === "image" && imageCapable && onPickImage && isImagePath(picked)) {
        onPickImage(picked);
        return;
      }
      insertMention(picked);
    } catch (err) {
      console.error("attach failed", err);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (imageCapable && onPasteImage) {
      try {
        await onPasteImage(file);
      } catch (err) {
        console.error("clipboard image attach failed", err);
      }
      return;
    }
    // Non-vision models can't receive image parts at all (the daemon hard-gates
    // them), so there's no point saving the bytes to a temp file and injecting
    // an @temp-path mention: the daemon only converts mentions for vision
    // models, and the temp dir sits outside the workspace the model's tools can
    // read. Reject loudly so the user switches models instead of sending a
    // dead path.
    onImageRejected?.();
  };

  const slashItems = useMemo(() => {
    if (!popup || popup.kind !== "slash") return [];
    const q = popup.query.toLowerCase();
    if (!q) return slashCommands;
    return slashCommands.filter((c) => c.cmd.toLowerCase().includes(q));
  }, [popup, slashCommands]);

  const atItems = useMemo<MentionItem[]>(() => {
    if (!popup || popup.kind !== "at") return [];
    if (!mentionResults || mentionResults.nonce !== popup.nonce) return [];
    const base: MentionItem[] = mentionResults.results.map((path) => ({
      name: path,
      kind: path.endsWith("/") || path.endsWith("\\") ? "dir" : "file",
      desc: path,
    }));
    // "../" entry (#1019): one level up whenever the @ query is inside a subdir.
    const parent = parentOfAtQuery(popup.query);
    if (parent !== null) {
      base.unshift({
        name: "..",
        kind: "dir",
        desc: parent ? `↑ ${parent}` : `↑ ${t("composer.workspaceRoot")}`,
      });
    }
    return base;
  }, [popup, mentionResults]);

  const items = popup?.kind === "slash" ? slashItems : popup?.kind === "at" ? atItems : [];

  useEffect(() => {
    // reset the highlighted row whenever the popup kind changes
    if (popup?.kind) setActiveIdx(0);
  }, [popup?.kind]);

  useEffect(() => {
    setActiveIdx((i) => (items.length ? Math.min(i, items.length - 1) : 0));
  }, [items.length]);

  useEffect(() => {
    if (!popup || popup.kind !== "at" || !onMentionQuery) return;
    onMentionQuery(popup.query, popup.nonce);
  }, [popup, onMentionQuery]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setDraft(v);
    const trail = v.match(/(^|\s)([/@])([^\s]*)$/);
    if (trail) {
      const sigil = trail[2];
      const query = trail[3] ?? "";
      if (sigil === "/") {
        setPopup({ kind: "slash", query });
      } else {
        const nonce = ++nonceRef.current;
        setPopup({ kind: "at", query, nonce });
      }
    } else if (popup) {
      setPopup(null);
    }
  };

  const dismiss = () => setPopup(null);

  const pickItem = (idx: number) => {
    const it = items[idx];
    if (!it || !popup) return;
    if (popup.kind === "slash") {
      const cmd = (it as SlashCmd).cmd;
      const insertOnly = (it as SlashCmd).insertOnly === true;
      if (insertOnly) {
        const next = draft.replace(/[/@][^\s]*$/, "").trimEnd();
        setDraft(next ? `${next} ${cmd} ` : `${cmd} `);
        setChips((c) => [...c, { kind: "slash", label: cmd.replace(/^\//, "") }]);
      } else {
        const next = draft.replace(/[/@][^\s]*$/, "").trimEnd();
        setDraft(next);
        setChips((c) => [...c, { kind: "slash", label: cmd.replace(/^\//, "") }]);
        (it as SlashCmd).run();
      }
    } else {
      const mention = it as MentionItem;
      if (mention.name === "..") {
        const parent = parentOfAtQuery(popup.query) ?? "";
        const next = draft.replace(/[@][^\s]*$/, `@${parent}`);
        setDraft(next);
        const nonce = ++nonceRef.current;
        setPopup({ kind: "at", query: parent, nonce });
        textareaRef.current?.focus();
        return;
      }
      // ChatGPT models attach mentioned image files directly — thumbnail
      // preview + vision content part instead of a text mention.
      if (imageCapable && onPickImage && isImagePath(mention.name)) {
        onPickImage(resolveImagePath(mention.name, workspaceDir));
        setPopup(null);
        textareaRef.current?.focus();
        return;
      }
      const next = draft.replace(/[/@][^\s]*$/, "").trimEnd();
      setDraft(next ? `${next} @${mention.name} ` : `@${mention.name} `);
      setChips((c) => [...c, { kind: "at", label: mention.name }]);
      onMentionPicked?.(mention.name);
    }
    setPopup(null);
    textareaRef.current?.focus();
  };

  const recordSendAndReset = () => {
    const trimmed = draft.trim();
    historyRef.current.push(trimmed);
    if (historyRef.current.length > 100) historyRef.current.shift();
    setBrowseIdx(-1);
  };

  const navigateHistory = (dir: -1 | 1) => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (dir === -1) {
      const nextIdx = browseIdx + 1;
      if (nextIdx < hist.length) {
        if (browseIdx === -1) savedDraftRef.current = draft;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      }
    } else {
      if (browseIdx > 0) {
        const nextIdx = browseIdx - 1;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      } else if (browseIdx === 0) {
        setBrowseIdx(-1);
        setDraft(savedDraftRef.current);
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (popup) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (items.length ? (i + 1) % items.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key === "Tab" && popup.kind === "at" && items.length > 0) {
        // Tab on a directory enters it — replaces `@src` with `@src/`
        // and re-queries so the popup shows that directory's children.
        // `..` is the synthetic parent-dir entry (#1019); same shape
        // but rewrites to the parent path.
        const it = items[activeIdx];
        if (it && (it as MentionItem).kind === "dir") {
          e.preventDefault();
          const mention = it as MentionItem;
          if (mention.name === "..") {
            const parent = parentOfAtQuery(popup.query) ?? "";
            const next = draft.replace(/[@][^\s]*$/, `@${parent}`);
            setDraft(next);
            const nonce = ++nonceRef.current;
            setPopup({ kind: "at", query: parent, nonce });
            return;
          }
          const dirPath = mention.name.replace(/\/+$/, "");
          const next = draft.replace(/[@][^\s]*$/, `@${dirPath}/`);
          setDraft(next);
          const nonce = ++nonceRef.current;
          setPopup({ kind: "at", query: `${dirPath}/`, nonce });
          return;
        }
      }
      if (e.key === "Enter") {
        if (items.length > 0) {
          e.preventDefault();
          pickItem(activeIdx);
          return;
        }
        dismiss();
      }
    }
    if (!popup) {
      const ta = textareaRef.current;
      if (e.key === "ArrowUp" && ta && ta.selectionStart === 0) {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
      if (e.key === "ArrowDown" && ta && ta.selectionStart === draft.length) {
        e.preventDefault();
        navigateHistory(1);
        return;
      }
    }
    if (composingRef.current || Date.now() - compositionEndedAtRef.current < 50) return;
    if (e.key === "Enter" && !e.shiftKey && !popup) {
      e.preventDefault();
      if (busy) {
        const text = draft.trim();
        if (text && onQueueWhileBusy) {
          onQueueWhileBusy(text);
          setChips([]);
        }
      } else if (!disabled && draft.trim()) {
        recordSendAndReset();
        onSend();
        setChips([]);
      }
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {queuedSends && queuedSends.length > 0 ? (
          <div className="composer-queued">
            <span className="composer-queued-label">
              {t("composer.queueCount", { n: queuedSends.length })}
            </span>
            {queuedSends.map((text, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: queue is dequeue-by-index; chips are text-only leaves
              <span key={i} className="composer-queue-chip" title={text}>
                <span className="text">{text}</span>
                {onDequeueSend ? (
                  <span
                    className="x"
                    onClick={() => onDequeueSend(i)}
                    onKeyDown={activationHandler(() => onDequeueSend(i))}
                  >
                    <I.x size={10} />
                  </span>
                ) : null}
              </span>
            ))}
            {onSendNow ? (
              <button type="button" className="composer-queued-send" onClick={onSendNow}>
                <I.send size={11} />
                {t("composer.sendNow")}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="hint-row">
          {busy && busyLabel ? (
            <>
              <span className="composer-busy-status">
                <span className="composer-busy-pip" />
                <span className="composer-busy-label">{busyLabel}</span>
                <TimerSpan active={busy ?? false} className="composer-busy-time" />
              </span>
              <span className="grow" />
              <ModeSwitch mode={editMode} onChange={onEditModeChange} />
              <span className="hint-sep" />
              <span>
                <Shortcut keys={["enter"]} /> {t("composer.queue")} &nbsp;·&nbsp;{" "}
                <Shortcut keys={["esc"]} /> {t("composer.interrupt")}
              </span>
            </>
          ) : (
            <>
              <span>
                <Shortcut keys={["/"]} /> {t("composer.commands")} &nbsp;·&nbsp;{" "}
                <Shortcut keys={["@"]} /> {t("composer.mentionFiles")}
                &nbsp;·&nbsp; <Shortcut keys={["mod", "K"]} /> {t("composer.commandPalette")}
              </span>
              <span className="grow" />
              <ModeSwitch mode={editMode} onChange={onEditModeChange} />
              <span className="hint-sep" />
              <span>
                <Shortcut keys={["enter"]} /> {t("composer.send")} &nbsp;{" "}
                <Shortcut keys={["shift", "enter"]} /> {t("composer.newline")}
              </span>
            </>
          )}
        </div>

        <div className="composer">
          {chips.length > 0 ? (
            <div className="composer-tags">
              {chips.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: chips are removed by index; label-keyed dupes possible
                <span key={i} className={`chip ${c.kind}`}>
                  {c.kind === "slash" ? <I.slash size={11} /> : <I.at size={11} />}
                  <span>{c.label}</span>
                  <span
                    className="x"
                    onClick={() => setChips((cs) => cs.filter((_, j) => j !== i))}
                    onKeyDown={activationHandler(() =>
                      setChips((cs) => cs.filter((_, j) => j !== i)),
                    )}
                  >
                    <I.x size={10} />
                  </span>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={t("composer.placeholder")}
            onChange={handleChange}
            onPaste={(e) => void handlePaste(e)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndedAtRef.current = Date.now();
            }}
            rows={DEFAULT_COMPOSER_ROWS}
            disabled={disabled}
          />

          {pendingImages && pendingImages.length > 0 ? (
            <div className="composer-images">
              {pendingImages.map((im) => (
                <div key={im.id} className="composer-image">
                  <img src={im.thumbnail} alt="" />
                  {onRemoveImage ? (
                    <button
                      type="button"
                      className="composer-image-remove"
                      title={t("composer.removeImage")}
                      onClick={() => onRemoveImage(im.id)}
                    >
                      <I.x size={11} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="composer-foot">
            <button
              type="button"
              className="cf-btn"
              title={t("composer.insertFile")}
              onClick={() => void attachFile()}
            >
              <span className="ico">
                <I.paperclip size={14} />
              </span>
            </button>
            <button
              type="button"
              className="cf-btn"
              title={t("composer.insertImage")}
              onClick={() => void attachFile("image")}
            >
              <span className="ico">
                <I.image size={14} />
              </span>
            </button>
            <button
              type="button"
              className="cf-btn"
              onClick={() => setPopup({ kind: "slash", query: "" })}
            >
              <span className="ico">
                <I.slash size={14} />
              </span>
              <span className="label">{t("composer.commandsLabel")}</span>
            </button>
            <button
              type="button"
              className="cf-btn"
              onClick={() => {
                const nonce = ++nonceRef.current;
                setPopup({ kind: "at", query: "", nonce });
              }}
            >
              <span className="ico">
                <I.at size={14} />
              </span>
              <span className="label">{t("composer.mentionLabel")}</span>
            </button>

            <span className="grow" />

            <div ref={modelWrapRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="model-pill"
                onClick={() => setModelMenuOpen((v) => !v)}
                title={t("composer.switchModel")}
              >
                <I.brain size={12} />
                <span>{modelLabel}</span>
                <span className="badge">{reasoningEffort}</span>
                <I.chev size={10} />
              </button>
              {modelMenuOpen ? (
                <ModelEffortMenu
                  modelLabel={modelLabel}
                  currentEffort={reasoningEffort}
                  ollamaModels={ollamaModels}
                  ollamaModelsError={ollamaModelsError}
                  ollamaHiddenCount={ollamaHiddenCount}
                  ollamaVisionModels={ollamaVisionModels}
                  antigravityModels={antigravityModels}
                  onRefreshOllamaModels={onRefreshOllamaModels}
                  onPickModel={(m) => {
                    onModelChange(m);
                    setModelMenuOpen(false);
                  }}
                  onPickEffort={(e) => {
                    onEffortChange(e);
                    setModelMenuOpen(false);
                  }}
                />
              ) : null}
            </div>
            {busy ? (
              <button
                type="button"
                className="send-btn"
                style={{ background: "var(--danger)" }}
                onClick={onAbort}
                title={t("composer.interrupt")}
              >
                <I.stop size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                disabled={disabled || !draft.trim()}
                onClick={() => {
                  if (!disabled && draft.trim()) {
                    recordSendAndReset();
                    onSend();
                    setChips([]);
                  }
                }}
              >
                <I.send size={14} />
              </button>
            )}
          </div>

          {popup ? (
            <Popup
              kind={popup.kind}
              items={items}
              activeIdx={activeIdx}
              onPick={(i) => pickItem(i)}
              onClose={dismiss}
              onHover={(i, item) => {
                setActiveIdx(i);
                if (popup.kind === "at" && onMentionPreview) {
                  const path = (item as MentionItem).name;
                  onMentionPreview(path, popup.nonce);
                }
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Popup({
  kind,
  items,
  activeIdx,
  onPick,
  onClose,
  onHover,
}: {
  kind: "slash" | "at";
  items: (SlashCmd | MentionItem)[];
  activeIdx: number;
  onPick: (i: number) => void;
  onClose: () => void;
  onHover: (i: number, item: SlashCmd | MentionItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll-follow must re-run per index change — the DOM query hides the read
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-active="true"]`);
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  }, [activeIdx]);

  return (
    <div className="popup" onMouseDown={(e) => e.preventDefault()}>
      <div className="ph">
        <span className="tok">{kind === "slash" ? "/" : "@"}</span>
        <span>{kind === "slash" ? t("composer.slashHeader") : t("composer.atHeader")}</span>
        <span className="grow" />
        <span
          style={{ cursor: "pointer" }}
          onClick={onClose}
          onKeyDown={activationHandler(onClose)}
        >
          <I.x size={11} />
        </span>
      </div>
      <div className={kind === "at" ? "popup-list at-popup-list" : "popup-list"} ref={listRef}>
        {items.length === 0 ? (
          <div
            style={{
              padding: "12px 8px",
              fontSize: 11.5,
              color: "var(--muted-2)",
              fontFamily: "Geist Mono, monospace",
            }}
          >
            {t("composer.noMatches")}
          </div>
        ) : null}
        {items.map((it, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: filtered popup items are a render snapshot
            key={i}
            className="popup-item"
            data-active={i === activeIdx}
            onClick={() => onPick(i)}
            onKeyDown={activationHandler(() => onPick(i))}
            onMouseEnter={() => onHover(i, it)}
          >
            <span className="ico">
              {kind === "slash"
                ? slashIcon((it as SlashCmd).cmd)
                : atIcon((it as MentionItem).kind)}
            </span>
            <div className="nm">
              {kind === "slash" ? (
                <>
                  <span className="cmd">{(it as SlashCmd).cmd}</span>
                  <span className="desc">{(it as SlashCmd).desc}</span>
                </>
              ) : (
                <>
                  <span>{(it as MentionItem).name}</span>
                  {(it as MentionItem).desc ? (
                    <div className="desc">{(it as MentionItem).desc}</div>
                  ) : null}
                </>
              )}
            </div>
            <span className="kb">{kind === "slash" ? ((it as SlashCmd).kb ?? "") : ""}</span>
          </div>
        ))}
      </div>
      <div className="popup-foot">
        <span>
          <Shortcut keys={["updown"]} /> {t("composer.select")}
        </span>
        <span>
          <Shortcut keys={["enter"]} /> {t("composer.confirm")}
        </span>
        <span>
          <Shortcut keys={["esc"]} /> {t("composer.close")}
        </span>
      </div>
    </div>
  );
}

function ModelEffortMenu({
  modelLabel,
  currentEffort,
  onPickModel,
  onPickEffort,
  ollamaModels,
  ollamaModelsError,
  ollamaHiddenCount,
  ollamaVisionModels,
  antigravityModels,
  onRefreshOllamaModels,
}: {
  modelLabel: string;
  currentEffort: ReasoningEffort;
  onPickModel: (model: string) => void;
  onPickEffort: (effort: ReasoningEffort) => void;
  ollamaModels?: string[];
  ollamaModelsError?: string;
  ollamaHiddenCount?: number;
  ollamaVisionModels?: ReadonlySet<string>;
  antigravityModels?: string[];
  onRefreshOllamaModels?: (force?: boolean) => void;
}) {
  const [draft, setDraft] = useState(modelLabel);
  const knownModels = KNOWN_MODELS.filter(
    (model) =>
      !model.startsWith("gemini-") &&
      !model.startsWith("claude-") &&
      !model.startsWith("gpt-oss-"),
  );
  const availableModels = [...knownModels, ...(antigravityModels ?? [])];
  const ollamaGroup = ollamaModels && ollamaModels.length > 0;
  return (
    <div
      className="popup"
      style={{
        bottom: "calc(100% + 6px)",
        left: "auto",
        right: 0,
        width: 560,
        position: "absolute",
      }}
    >
      <div className="ph">
        <span className="tok">M</span>
        <span>{t("composer.switchModel")}</span>
        <span className="grow" />
        <span className="tok">E</span>
        <span>{t("composer.switchEffort")}</span>
      </div>
      <div className="model-menu-cols">
        {/* Models column — the Ollama group alone can run to hundreds of ids. */}
        <div className="model-menu-col">
          <div className="popup-list model-menu-list">
            {availableModels.map((m) => (
              <div
                key={m}
                className="popup-item"
                data-active={m === modelLabel}
                onClick={() => onPickModel(m)}
                onKeyDown={activationHandler(() => onPickModel(m))}
              >
                <span className="ico">
                  <I.brain size={12} />
                </span>
                <div className="nm">
                  <span className="cmd">{m}</span>
                </div>
                {modelAcceptsImages(m, ollamaVisionModels) ? (
                  <span className="badge">vision</span>
                ) : null}
              </div>
            ))}
            {ollamaGroup || ollamaModelsError ? (
              <>
                <div className="model-menu-group">
                  <span className="grow">{t("composer.modelOllamaGroup")}</span>
                  {ollamaHiddenCount && ollamaHiddenCount > 0 ? (
                    <span className="model-menu-note">
                      {t("composer.modelOllamaHidden", { count: ollamaHiddenCount })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="mini-btn"
                    title={t("composer.modelOllamaRefresh")}
                    onClick={() => onRefreshOllamaModels?.(true)}
                  >
                    <I.refresh size={10} />
                  </button>
                </div>
                {/* The error only matters when the tab's model IS an Ollama model —
                    a DeepSeek/OpenAI tab with a down local daemon would otherwise
                    show a spurious "Ollama unreachable" line. The Models settings
                    page surfaces it unconditionally. */}
                {ollamaModelsError && !ollamaGroup && modelLabel.startsWith("ollama/") ? (
                  <div className="model-menu-error">
                    {t("composer.modelOllamaError", { error: ollamaModelsError })}
                  </div>
                ) : null}
                {ollamaModels && ollamaModels.length > 0
                  ? ollamaModels.map((id) => {
                      const full = `ollama/${id}`;
                      return (
                        <div
                          key={full}
                          className="popup-item"
                          data-active={full === modelLabel}
                          onClick={() => onPickModel(full)}
                          onKeyDown={activationHandler(() => onPickModel(full))}
                        >
                          <span className="ico">
                            <I.bot size={12} />
                          </span>
                          <div className="nm">
                            <span className="cmd">{full}</span>
                          </div>
                          {modelAcceptsImages(full, ollamaVisionModels) ? (
                            <span className="badge">vision</span>
                          ) : null}
                        </div>
                      );
                    })
                  : null}
              </>
            ) : null}
            <div className="model-menu-custom">
              <input
                className="field mono model-menu-custom-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="custom model id"
              />
              <button
                type="button"
                className="btn model-menu-custom-confirm"
                disabled={!draft.trim() || draft.trim() === modelLabel}
                onClick={() => onPickModel(draft.trim())}
              >
                {t("composer.confirm")}
              </button>
            </div>
          </div>
        </div>
        {/* Reasoning effort column */}
        <div className="model-menu-col">
          <div className="popup-list effort-menu-list">
            {EFFORTS.map((e) => (
              <div
                key={e}
                className="popup-item"
                data-active={e === currentEffort}
                onClick={() => onPickEffort(e)}
                onKeyDown={activationHandler(() => onPickEffort(e))}
              >
                <span className="ico">
                  <I.cpu size={12} />
                </span>
                <div className="nm">
                  <span className="cmd">{e}</span>
                  <div className="desc">{t(`effort.${e}Desc` as TKey)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
