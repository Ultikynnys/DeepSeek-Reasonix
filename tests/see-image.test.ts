import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { registerSeeImageTool } from "../src/tools/see-image.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("see_image", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "see-image-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function registry(): ToolRegistry {
    const tools = new ToolRegistry();
    registerSeeImageTool(tools);
    return tools;
  }

  it("confirms the images attached to the current turn (via dispatch ctx)", async () => {
    const out = await registry().dispatch("see_image", "{}", { images: [DATA_URL] });
    expect(out).toContain("1 image(s) attached to the current turn");
    expect(out).toContain("visible to you directly");
  });

  it("counts multiple attached images", async () => {
    const out = await registry().dispatch("see_image", "{}", {
      images: [DATA_URL, DATA_URL],
    });
    expect(out).toContain("2 image(s) attached");
  });

  it("confirms a data: URL passed as path (returns image_url content parts)", async () => {
    const out = await registry().dispatch("see_image", JSON.stringify({ path: DATA_URL }));
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const text = parts.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("Image loaded at data URL");
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe(DATA_URL);
  });

  it("loads an existing image file into an image_url part (actual pixels)", async () => {
    const bytes = "not-real-png-bytes";
    writeFileSync(join(root, "shot.png"), bytes, "utf8");
    const out = await registry().dispatch("see_image", JSON.stringify({ path: "shot.png" }), {
      rootDir: root,
    });
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const text = parts.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain(`Image loaded at ${join(root, "shot.png")}`);
    const image = parts.find((p) => p.type === "image_url");
    // The data URL must carry the file bytes so the vision model actually sees them.
    const prefix = "data:image/png;base64,";
    expect(image?.image_url?.url?.startsWith(prefix)).toBe(true);
    const b64 = image?.image_url?.url?.slice(prefix.length) ?? "";
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(bytes);
  });

  it("resolves a relative path against the tool root", async () => {
    const sub = join(root, "shots");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "a.jpeg"), "jpeg-bytes", "utf8");
    const out = await registry().dispatch("see_image", JSON.stringify({ path: "shots/a.jpeg" }), {
      rootDir: root,
    });
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const text = parts.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("Image loaded at");
    expect(text).toContain(join("shots", "a.jpeg"));
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });

  it("rejects unsupported file types", async () => {
    const out = await registry().dispatch("see_image", JSON.stringify({ path: "readme.md" }));
    expect(out).toContain("unsupported image path");
    expect(out).toContain("PNG, JPEG or WebP");
  });

  it("rejects missing files", async () => {
    const out = await registry().dispatch("see_image", JSON.stringify({ path: "missing.png" }), {
      rootDir: root,
    });
    expect(out).toContain("no such image file");
  });

  it("tells the model when nothing is available", async () => {
    const out = await registry().dispatch("see_image", "{}");
    expect(out).toContain("no image available");
    expect(out).toContain("no `path` was given");
  });

  it("is safe in plan mode (readOnly)", async () => {
    const tools = registry();
    tools.setPlanMode(true);
    const out = await tools.dispatch("see_image", "{}", { images: [DATA_URL] });
    expect(out).toContain("1 image(s) attached");
  });
});
