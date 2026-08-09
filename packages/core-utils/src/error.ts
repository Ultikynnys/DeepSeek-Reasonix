/** Convert unknown thrown values to a stable display message. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}
