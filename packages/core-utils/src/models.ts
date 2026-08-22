/** Model capability predicates — shared by the daemon (src/) and the desktop
 *  UI so the two sides can't drift on which model ids accept images. */

/** Model ids that accept image attachments in user messages — the GPT-5.6
 *  family plus DeepSeek's vision line. Drives the composer's paste/drop
 *  affordance, the daemon's @-mention conversion, and the images hard gate. */
export function modelAcceptsImages(model: string | undefined | null): boolean {
  if (typeof model !== "string") return false;
  if (model.startsWith("gpt-")) return true;
  return model === "deepseek-v4-flash-vision-exp";
}
