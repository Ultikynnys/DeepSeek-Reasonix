export const DEFAULT_COMPOSER_ROWS = 2;

export type ComposerTextareaSizing = {
  heightPx: number;
  overflowY: "hidden" | "auto";
};

/**
 * The composer textarea keeps a fixed height and never resizes — input taller
 * than {@link DEFAULT_COMPOSER_ROWS} scrolls inside the box instead of growing
 * it. It used to expand past a row threshold, so the box jumped as the user
 * typed across that boundary.
 */
export function getComposerTextareaSizing({
  contentRows,
  lineHeightPx,
  verticalPaddingPx,
}: {
  contentRows: number;
  lineHeightPx: number;
  verticalPaddingPx: number;
}): ComposerTextareaSizing {
  const safeRows = Math.max(1, Math.ceil(contentRows));

  return {
    heightPx: DEFAULT_COMPOSER_ROWS * lineHeightPx + verticalPaddingPx,
    overflowY: safeRows > DEFAULT_COMPOSER_ROWS ? "auto" : "hidden",
  };
}

/** Applies the composer textarea's fixed height and overflow in place. */
export function applyComposerTextareaSize(textarea: HTMLTextAreaElement) {
  const style = window.getComputedStyle(textarea);
  const lineHeightPx = Number.parseFloat(style.lineHeight);
  const paddingTopPx = Number.parseFloat(style.paddingTop);
  const paddingBottomPx = Number.parseFloat(style.paddingBottom);
  const verticalPaddingPx = paddingTopPx + paddingBottomPx;
  const measuredLineHeight = Number.isFinite(lineHeightPx) ? lineHeightPx : 20;

  textarea.style.height = "auto";
  const contentRows = Math.ceil(
    Math.max(textarea.scrollHeight - verticalPaddingPx, measuredLineHeight) / measuredLineHeight,
  );
  const sizing = getComposerTextareaSizing({
    contentRows,
    lineHeightPx: measuredLineHeight,
    verticalPaddingPx,
  });
  textarea.style.height = `${sizing.heightPx}px`;
  textarea.style.overflowY = sizing.overflowY;
}
