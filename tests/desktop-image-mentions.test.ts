import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractImageMentions } from "../src/cli/commands/desktop.js";

describe("extractImageMentions — auto-parse @image mentions (OpenAI models)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-img-mentions-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "shot.png"), "png-bytes");
    writeFileSync(join(root, "notes.md"), "# notes");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("converts an existing image mention into a file attachment and strips the token", async () => {
    const r = await extractImageMentions("what does @assets/shot.png show", root);
    expect(r.text).toBe("what does  show");
    expect(r.attachments).toEqual([{ source: "file", path: join(root, "assets", "shot.png") }]);
  });

  it("leaves non-image and missing mentions in the text untouched", async () => {
    const r = await extractImageMentions("see @notes.md and @assets/missing.png", root);
    expect(r.text).toBe("see @notes.md and @assets/missing.png");
    expect(r.attachments).toEqual([]);
  });

  it("does not attach unsupported formats (gif/svg)", async () => {
    writeFileSync(join(root, "anim.gif"), "gif-bytes");
    const r = await extractImageMentions("play @anim.gif", root);
    expect(r.text).toBe("play @anim.gif");
    expect(r.attachments).toEqual([]);
  });

  it("deduplicates repeated mentions of the same image", async () => {
    const r = await extractImageMentions("@assets/shot.png and @assets/shot.png", root);
    expect(r.attachments).toHaveLength(1);
  });

  it("strips a trailing sentence-terminator dot before matching", async () => {
    const r = await extractImageMentions("look at @assets/shot.png.", root);
    expect(r.attachments).toHaveLength(1);
  });
});
