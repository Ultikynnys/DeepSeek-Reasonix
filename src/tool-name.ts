/** Provider-safe function names: sanitize MCP names to the OpenAI/Gemini grammar. */

export const WIRE_TOOL_NAME_MAX = 64;

/** Everything outside the OpenAI function-name charset. */
const INVALID_CHARS = /[^a-zA-Z0-9_-]/g;

/** Map an arbitrary string to a provider-safe function name. Deterministic, so
 *  the cache-stable tool-list hash never churns; valid names pass through. */
export function sanitizeWireToolName(raw: string): string {
  let name = raw.replace(INVALID_CHARS, "_");
  if (name.length === 0) return name;
  // Gemini requires the first char to be a letter or underscore; OpenAI also
  // accepts a leading digit/hyphen, but staying stricter is portable.
  if (!/^[a-zA-Z_]/.test(name)) name = `_${name}`;
  if (name.length > WIRE_TOOL_NAME_MAX) name = name.slice(0, WIRE_TOOL_NAME_MAX);
  return name;
}

/** Short deterministic suffix (FNV-1a, base36) that keeps two tools apart when
 *  their sanitized names collide (e.g. `users.get` and `users_get`). */
export function toolNameDisambiguator(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 4);
}
