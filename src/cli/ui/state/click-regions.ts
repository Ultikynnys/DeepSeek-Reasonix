// Hit-test regions for mouse-clickable elements in the card stream.
// Ink is a text renderer — there are no real buttons and no screen
// coordinates. Every render, the CardStream layout publishes the on-screen
// row of each running shell card's Stop button; a `mouseClick` event (SGR
// mode 1000, 1-based row/col) is matched against those rows in App's
// keystroke handler.

export interface ClickRegion {
  /** Card id (== tool callId) the region belongs to. */
  cardId: string;
  /** 1-based terminal row the button occupies. */
  row: number;
}

let regions: readonly ClickRegion[] = [];

/** Publish the current render's clickable regions (called by CardStream). */
export function setClickRegions(next: readonly ClickRegion[]): void {
  regions = next;
}

/** Return the card whose Stop-button row contains `row`, or null. */
export function hitTestClickRegion(row: number): string | null {
  for (const r of regions) {
    if (r.row === row) return r.cardId;
  }
  return null;
}

/** Drop all regions (TUI teardown / tests). */
export function clearClickRegions(): void {
  regions = [];
}
