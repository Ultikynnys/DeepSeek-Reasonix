/** Base for tool-thrown errors that halt the loop for the TUI (choice picker, plan approval, shell gate) — shared "STOP calling tools" message contract + toToolResult() serialization. */
export abstract class ToolControlFlowError extends Error {
  protected constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }

  /** Model-facing error line — the dispatch pipeline JSON-encodes this. */
  toToolResult(): { error: string } {
    return { error: `${this.name}: ${this.message}` };
  }
}
