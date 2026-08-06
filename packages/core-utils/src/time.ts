/** Shared time constants — every `days * 24 * 60 * 60 * 1000` site used to
 *  re-derive the millisecond day inline (session pruning, usage compaction,
 *  rolling windows). */

export const DAY_MS = 24 * 60 * 60 * 1000;
