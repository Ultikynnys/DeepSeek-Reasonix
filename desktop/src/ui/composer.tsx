import {
  GPT56_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  isUsableAntigravityModel,
  modelAcceptsImages,
} from "@reasonix/core-utils";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  type ChangeEvent,
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
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

export function Composer({
  draft,
  setDraft,
  onSend,
  onAbort,
  disabled,
  busy,
  busyLabel,
  modelLabel,
  subagentModelLabel = "deepseek-v4-flash",
  reasoningEffort,
  onModelChange,
  onSubagentModelChange = () => {},
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
  antigravityModelsError,
  onRefreshAntigravityModels,
  customModels,
  textareaRef,
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
  /** Per-tab subagent model shown in the menu's subagent column. Defaults to deepseek-v4-flash when the caller omits it. */
  subagentModelLabel?: string;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: string) => void;
  /** Called when the user picks a model in the subagent column. */
  onSubagentModelChange?: (model: string) => void;
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
  /** Why the latest Antigravity auth or model refresh failed. */
  antigravityModelsError?: string;
  /** Re-fetch the signed-in account's Antigravity model ids. */
  onRefreshAntigravityModels?: () => void;
  /** Ids with an explicit `models` provider mapping in config.json — offered
   *  in the general list because the user declared them. */
  customModels?: string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
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
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [subagentMenuOpen, setSubagentMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const modelWrapRef = useRef<HTMLDivElement>(null);
  const subagentWrapRef = useRef<HTMLDivElement>(null);
  const effortWrapRef = useRef<HTMLDivElement>(null);
  // macOS Chinese IME fires compositionend BEFORE the confirm keydown.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const [browseIdx, setBrowseIdx] = useState(-1);
  const savedDraftRef = useRef("");

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    applyComposerTextareaAutosize(textarea);
  });

  useEffect(() => {
    if (!modelMenuOpen && !subagentMenuOpen && !effortMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inside =
        (modelWrapRef.current?.contains(target) ?? false) ||
        (subagentWrapRef.current?.contains(target) ?? false) ||
        (effortWrapRef.current?.contains(target) ?? false);
      if (!inside) {
        setModelMenuOpen(false);
        setSubagentMenuOpen(false);
        setEffortMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen, subagentMenuOpen, effortMenuOpen]);

  const attachFile = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        defaultPath: workspaceDir,
      });
      if (typeof picked !== "string" || !picked) return;
      if (imageCapable && onPickImage && isImagePath(picked)) {
        onPickImage(resolveImagePath(picked, workspaceDir));
        return;
      }
      const rel =
        workspaceDir && picked.startsWith(workspaceDir)
          ? picked.slice(workspaceDir.length).replace(/^[\\/]+/, "")
          : picked;
      setDraft((current) => (current ? `${current.replace(/\s+$/, "")} ${rel} ` : `${rel} `));
      textareaRef.current?.focus();
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
    onImageRejected?.();
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
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
    if (e.key === "Escape") {
      if (modelMenuOpen || subagentMenuOpen || effortMenuOpen) {
        e.preventDefault();
        setModelMenuOpen(false);
        setSubagentMenuOpen(false);
        setEffortMenuOpen(false);
        return;
      }
    }
    if (composingRef.current || Date.now() - compositionEndedAtRef.current < 50) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (busy) {
        const text = draft.trim();
        if (text && onQueueWhileBusy) {
          onQueueWhileBusy(text);
        }
      } else if (!disabled && draft.trim()) {
        recordSendAndReset();
        onSend();
      }
    }
  };

  const modelListProps = {
    ollamaModels,
    ollamaModelsError,
    ollamaHiddenCount,
    ollamaVisionModels,
    antigravityModels,
    antigravityModelsError,
    customModels,
    onRefreshOllamaModels,
    onRefreshAntigravityModels,
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

            <span className="grow" />

            <div ref={modelWrapRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="model-pill"
                onClick={() => {
                  setModelMenuOpen((v) => !v);
                  setSubagentMenuOpen(false);
                  setEffortMenuOpen(false);
                }}
                title={t("composer.switchModel")}
              >
                <I.brain size={12} />
                <span>{modelLabel}</span>
                <I.chev size={10} />
              </button>
              {modelMenuOpen ? (
                <MenuPop width={420}>
                  <div className="ph">
                    <span className="tok">M</span>
                    <span>{t("composer.switchModel")}</span>
                  </div>
                  <ModelList
                    activeModel={modelLabel}
                    onPick={(m) => {
                      onModelChange(m);
                      setModelMenuOpen(false);
                    }}
                    {...modelListProps}
                  />
                </MenuPop>
              ) : null}
            </div>
            <div ref={subagentWrapRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="model-pill subagent-pill"
                onClick={() => {
                  setSubagentMenuOpen((v) => !v);
                  setModelMenuOpen(false);
                  setEffortMenuOpen(false);
                }}
                title={t("composer.switchSubagentModel")}
              >
                <I.bot size={12} />
                <span>{subagentModelLabel}</span>
                <I.chev size={10} />
              </button>
              {subagentMenuOpen ? (
                <MenuPop width={420}>
                  <div className="ph">
                    <span className="tok">S</span>
                    <span>{t("composer.switchSubagentModel")}</span>
                  </div>
                  <ModelList
                    activeModel={subagentModelLabel}
                    onPick={(m) => {
                      onSubagentModelChange(m);
                      setSubagentMenuOpen(false);
                    }}
                    {...modelListProps}
                  />
                </MenuPop>
              ) : null}
            </div>
            <div ref={effortWrapRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="model-pill effort-pill"
                onClick={() => {
                  setEffortMenuOpen((v) => !v);
                  setModelMenuOpen(false);
                  setSubagentMenuOpen(false);
                }}
                title={t("composer.switchEffort")}
              >
                <I.cpu size={12} />
                <span>{reasoningEffort}</span>
                <I.chev size={10} />
              </button>
              {effortMenuOpen ? (
                <MenuPop width={320}>
                  <div className="ph">
                    <span className="tok">E</span>
                    <span>{t("composer.switchEffort")}</span>
                  </div>
                  <div className="popup-list effort-menu-list">
                    {EFFORTS.map((e) => (
                      <div
                        key={e}
                        className="popup-item"
                        data-active={e === reasoningEffort}
                        onClick={() => {
                          onEffortChange(e);
                          setEffortMenuOpen(false);
                        }}
                        onKeyDown={activationHandler(() => {
                          onEffortChange(e);
                          setEffortMenuOpen(false);
                        })}
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
                </MenuPop>
              ) : null}
            </div>
            {busy ? (
              <button
                type="button"
                className="send-btn danger"
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
                  }
                }}
              >
                <I.send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared model picker column. Rendered once per selector (main agent and
 *  subagent) so both expose the exact same model options — KNOWN_MODELS, the
 *  signed-in Antigravity group, the Ollama catalog, and a custom-model input. */
function ModelList({
  activeModel,
  onPick,
  ollamaModels,
  ollamaModelsError,
  ollamaHiddenCount,
  ollamaVisionModels,
  antigravityModels,
  antigravityModelsError,
  customModels,
  onRefreshOllamaModels,
  onRefreshAntigravityModels,
}: {
  activeModel: string;
  onPick: (model: string) => void;
  ollamaModels?: string[];
  ollamaModelsError?: string;
  ollamaHiddenCount?: number;
  ollamaVisionModels?: ReadonlySet<string>;
  antigravityModels?: string[];
  antigravityModelsError?: string;
  /** Ids with an explicit `models` provider mapping — user-declared, so offered. */
  customModels?: string[];
  onRefreshOllamaModels?: (force?: boolean) => void;
  onRefreshAntigravityModels?: () => void;
}) {
  const [draft, setDraft] = useState(activeModel);
  const usableAntigravityModels = antigravityModels
    ? antigravityModels.filter(isUsableAntigravityModel)
    : undefined;
  const antigravityGroup = Boolean(usableAntigravityModels && usableAntigravityModels.length > 0);
  const ollamaGroup = Boolean(ollamaModels && ollamaModels.length > 0);

  type GroupDef = {
    key: string;
    title: string;
    models: readonly string[];
    icon?: (props: { size?: number }) => React.ReactNode;
    refresh?: () => void;
    refreshTitle?: string;
    error?: string;
    note?: string;
  };

  const groups: GroupDef[] = [
    {
      key: "deepseek",
      title: t("composer.modelDeepSeekGroup"),
      models: SUPPORTED_OFFICIAL_MODELS,
    },
    {
      key: "openai",
      title: t("composer.modelOpenAIGroup"),
      models: GPT56_MODELS,
    },
    {
      key: "zai",
      title: t("composer.modelZaiGroup"),
      models: ZAI_MODELS,
    },
    ...(customModels && customModels.length > 0
      ? [
          {
            key: "custom",
            title: t("composer.modelCustomGroup"),
            models: customModels,
          },
        ]
      : []),
    ...(antigravityGroup || antigravityModelsError
      ? [
          {
            key: "antigravity",
            title: t("composer.modelAntigravityGroup"),
            models: usableAntigravityModels ?? [],
            refresh: onRefreshAntigravityModels,
            refreshTitle: t("composer.modelAntigravityRefresh"),
            error: antigravityModelsError
              ? t("composer.modelAntigravityError", { error: antigravityModelsError })
              : undefined,
          },
        ]
      : []),
    ...(ollamaGroup || ollamaModelsError
      ? [
          {
            key: "ollama",
            title: t("composer.modelOllamaGroup"),
            models: (ollamaModels ?? []).map((id) => `ollama/${id}`),
            icon: I.bot,
            refresh: () => onRefreshOllamaModels?.(true),
            refreshTitle: t("composer.modelOllamaRefresh"),
            error:
              ollamaModelsError && !ollamaGroup && activeModel.startsWith("ollama/")
                ? t("composer.modelOllamaError", { error: ollamaModelsError })
                : undefined,
            note:
              ollamaHiddenCount && ollamaHiddenCount > 0
                ? t("composer.modelOllamaHidden", { count: ollamaHiddenCount })
                : undefined,
          },
        ]
      : []),
  ];

  return (
    <div className="popup-list model-menu-list">
      {groups.map((group) => {
        if (group.models.length === 0 && !group.error) return null;
        const Icon = group.icon ?? I.brain;
        return (
          <Fragment key={group.key}>
            <div className="model-menu-group">
              <span className="grow">{group.title}</span>
              {group.note ? <span className="model-menu-note">{group.note}</span> : null}
              {group.refresh ? (
                <button
                  type="button"
                  className="mini-btn"
                  title={group.refreshTitle}
                  onClick={group.refresh}
                >
                  <I.refresh size={10} />
                </button>
              ) : null}
            </div>
            {group.error ? <div className="model-menu-error">{group.error}</div> : null}
            {group.models.map((model) => (
              <div
                key={model}
                className="popup-item"
                data-active={model === activeModel}
                onClick={() => onPick(model)}
                onKeyDown={activationHandler(() => onPick(model))}
              >
                <span className="ico">
                  <Icon size={12} />
                </span>
                <div className="nm">
                  <span className="cmd">{model}</span>
                </div>
                {modelAcceptsImages(model, ollamaVisionModels) ? (
                  <span className="badge">vision</span>
                ) : null}
              </div>
            ))}
          </Fragment>
        );
      })}
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
          disabled={!draft.trim() || draft.trim() === activeModel}
          onClick={() => onPick(draft.trim())}
        >
          {t("composer.confirm")}
        </button>
      </div>
    </div>
  );
}

/** Fixed-position popup anchored to its wrapper (the pill's `position:
 *  relative` container). The picker sits inside the `.main` column, which has
 *  `overflow: hidden` — an absolutely positioned popup would get clipped at
 *  the sidebar boundary and render behind it. Pinning to the viewport escapes
 *  the clip and stacks above the sidebar, anchored to the pill's box and
 *  clamped to the window. */
function MenuPop({ width, children }: { width: number; children: React.ReactNode }) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const position = () => {
      const pop = popRef.current;
      const wrap = pop?.parentElement; // the pill wrapper
      if (!pop || !wrap) return;
      const wr = wrap.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      const w = Math.min(width, vw - 16);
      const left = Math.max(pad, Math.min(wr.right - w, vw - w - pad));
      let top = wr.top - pr.height - 6;
      if (top < pad) top = wr.bottom + 6; // no room above the pill — open below
      top = Math.max(pad, Math.min(top, vh - pr.height - pad));
      setPos({ left, top });
      setVisible(true);
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [width]);

  return (
    <div
      ref={popRef}
      className="popup"
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        bottom: "auto",
        right: "auto",
        width: `min(${width}px, calc(100vw - 16px))`,
        visibility: visible ? undefined : "hidden",
      }}
    >
      {children}
    </div>
  );
}
