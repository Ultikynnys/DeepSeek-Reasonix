import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";
import { DEFAULT_IMAGE_MODEL, generateImageViaCodex } from "../src/codex-backend.js";
import { saveOpenAIOAuth } from "../src/config.js";
import { hasOpenAIOAuthSession } from "../src/oauth.js";
import { ToolRegistry } from "../src/tools.js";
import { registerImageGenTool } from "../src/tools/image-gen.js";
import { resetTypesafeValidationCache } from "../src/tools/jev.js";

/** Minimal JWT (header.payload.signature) with the given claims payload. */
function jwt(payload: object): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

/** A real, non-trivial PNG as base64 — a header-only constant would be rejected. */
async function realPngBase64(): Promise<string> {
  const img = new Jimp({ width: 4, height: 4, color: 0x3366ffff });
  const buf = await img.getBuffer("image/png");
  return buf.toString("base64");
}

/** One Responses SSE frame carrying an image_generation_call result. */
function sseWithImage(pngBase64: string): string {
  const done = {
    type: "response.output_item.done",
    item: { type: "image_generation_call", status: "completed", result: pngBase64 },
  };
  return `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_item.done\ndata: ${JSON.stringify(done)}\n\n`;
}

const CREDS = { accessToken: "", refreshToken: "rt-1", expiresAt: 0 };

describe("hasOpenAIOAuthSession", () => {
  let dir: string;
  let cfgPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-image-gate-"));
    cfgPath = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is false without stored creds", () => {
    expect(hasOpenAIOAuthSession(cfgPath)).toBe(false);
  });

  it("is true once an access token is stored", () => {
    saveOpenAIOAuth(
      { ...CREDS, accessToken: jwt({ chatgpt_account_id: "acct-1" }), expiresAt: Date.now() + 6e5 },
      cfgPath,
    );
    expect(hasOpenAIOAuthSession(cfgPath)).toBe(true);
  });
});

describe("generateImageViaCodex", () => {
  let dir: string;
  let cfgPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let png: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-image-backend-"));
    cfgPath = join(dir, "config.json");
    png = await realPngBase64();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCreds(): void {
    saveOpenAIOAuth(
      { ...CREDS, accessToken: jwt({ chatgpt_account_id: "acct-1" }), expiresAt: Date.now() + 6e5 },
      cfgPath,
    );
  }

  it("posts the hosted image_generation tool and returns the SSE image", async () => {
    seedCreds();
    fetchMock.mockResolvedValueOnce(
      new Response(sseWithImage(png), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const result = await generateImageViaCodex({ prompt: "a red mug", configPath: cfgPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pngBase64).toBe(png);
    expect(result.model).toBe(DEFAULT_IMAGE_MODEL);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${jwt({ chatgpt_account_id: "acct-1" })}`);
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(body.stream).toBe(true);
    expect(body.tools[0].type).toBe("image_generation");
    expect(body.tools[0].output_format).toBe("png");
    expect(body.tool_choice).toEqual({ type: "image_generation" });
    expect(body.input[0].content[0].text).toBe("a red mug");
  });

  it("honors size / quality / background overrides", async () => {
    seedCreds();
    fetchMock.mockResolvedValueOnce(
      new Response(sseWithImage(png), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await generateImageViaCodex({
      prompt: "p",
      size: "1536x1024",
      quality: "high",
      background: "transparent",
      configPath: cfgPath,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools[0]).toMatchObject({
      size: "1536x1024",
      quality: "high",
      background: "transparent",
    });
  });

  it("reports a missing OAuth session without calling the backend", async () => {
    const result = await generateImageViaCodex({ prompt: "p", configPath: cfgPath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no OpenAI OAuth session");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an HTTP error body as the reason", async () => {
    seedCreds();
    fetchMock.mockResolvedValueOnce(new Response("insufficient_quota", { status: 429 }));
    const result = await generateImageViaCodex({ prompt: "p", configPath: cfgPath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("429");
    expect(result.reason).toContain("insufficient_quota");
  });

  it("reports no-image when the stream carries no image_generation_call", async () => {
    seedCreds();
    fetchMock.mockResolvedValueOnce(
      new Response('event: response.created\ndata: {"type":"response.created"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const result = await generateImageViaCodex({ prompt: "p", configPath: cfgPath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no image");
  });
});

describe("generate_image tool", () => {
  let dir: string;
  let png: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-image-tool-"));
    png = await realPngBase64();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function registry(): ToolRegistry {
    const tools = new ToolRegistry();
    registerImageGenTool(tools, {
      rootDir: dir,
      generate: async () => ({ ok: true, pngBase64: png, model: "gpt-5.5" }),
    });
    return tools;
  }

  it("saves the PNG and returns the pixels as an image_url part", async () => {
    const out = await registry().dispatch("generate_image", JSON.stringify({ prompt: "a robot" }), {
      rootDir: dir,
    });
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const text = parts.find((p) => p.type === "text")?.text ?? "";
    expect(text).toContain("Generated image saved at");
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${png}`);

    // Default location: <root>/.reasonix/generated-images/<slug>-<ts>.png
    const saved = text.slice("Generated image saved at ".length).split(" (")[0];
    expect(saved).toContain(join(".reasonix", "generated-images"));
    expect(readFileSync(saved).toString("base64")).toBe(png);
  });

  it("writes to an explicit workspace-relative out_path", async () => {
    const out = await registry().dispatch(
      "generate_image",
      JSON.stringify({ prompt: "icon", out_path: "icons/robot" }),
      { rootDir: dir },
    );
    const parts = out as Array<{ type: string; text?: string }>;
    const text = parts.find((p) => p.type === "text")?.text ?? "";
    const saved = text.slice("Generated image saved at ".length).split(" (")[0];
    expect(saved).toBe(join(dir, "icons", "robot.png"));
    expect(readFileSync(saved).toString("base64")).toBe(png);
  });

  it("requires a non-empty prompt", async () => {
    // Whitespace-only prompt reaches the handler (param present but empty).
    const blank = await registry().dispatch("generate_image", JSON.stringify({ prompt: "   " }), {
      rootDir: dir,
    });
    expect(blank).toContain("`prompt` is required");
    // Omitted prompt is caught earlier by the registry's required-param check.
    const missing = await registry().dispatch("generate_image", "{}", { rootDir: dir });
    expect(missing).toContain("missing required parameter");
  });

  it("surfaces a backend failure as a string result", async () => {
    const tools = new ToolRegistry();
    registerImageGenTool(tools, {
      rootDir: dir,
      generate: async () => ({ ok: false, reason: "insufficient_quota" }),
    });
    const out = await tools.dispatch("generate_image", JSON.stringify({ prompt: "x" }), {
      rootDir: dir,
    });
    expect(out).toContain("generate_image: insufficient_quota");
  });

  it("rejects non-PNG bytes from the backend", async () => {
    const tools = new ToolRegistry();
    registerImageGenTool(tools, {
      rootDir: dir,
      generate: async () => ({
        ok: true,
        pngBase64: Buffer.from("not a png").toString("base64"),
        model: "m",
      }),
    });
    const out = await tools.dispatch("generate_image", JSON.stringify({ prompt: "x" }), {
      rootDir: dir,
    });
    expect(out).toContain("non-PNG bytes");
  });
});

describe("buildCodeToolset — conditional generate_image", () => {
  let tmpRoot: string;
  let cfgPath: string;
  let savedKey: string | undefined;
  let savedTypesafe: string | undefined;

  beforeEach(() => {
    resetTypesafeValidationCache();
    savedKey = process.env.DEEPSEEK_API_KEY;
    savedTypesafe = process.env.TYPESAFE_API_KEY;
    // biome-ignore lint/performance/noDelete: must be truly unset, not the string "undefined"
    delete process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: must be truly unset, not the string "undefined"
    delete process.env.TYPESAFE_API_KEY;
    tmpRoot = mkdtempSync(join(tmpdir(), "reasonix-image-setup-"));
    cfgPath = join(tmpRoot, "config.json");
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    if (savedTypesafe !== undefined) process.env.TYPESAFE_API_KEY = savedTypesafe;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("omits generate_image without an OAuth session", async () => {
    writeFileSync(cfgPath, JSON.stringify({ model: "deepseek-chat" }), "utf8");
    const toolset = await buildCodeToolset({ rootDir: tmpRoot, configPath: cfgPath });
    expect(toolset.tools.has("generate_image")).toBe(false);
    await toolset.jobs.shutdown();
  });

  it("registers generate_image when an OAuth session exists", async () => {
    saveOpenAIOAuth(
      { ...CREDS, accessToken: jwt({ chatgpt_account_id: "acct-1" }), expiresAt: Date.now() + 6e5 },
      cfgPath,
    );
    const toolset = await buildCodeToolset({ rootDir: tmpRoot, configPath: cfgPath });
    expect(toolset.tools.has("generate_image")).toBe(true);
    await toolset.jobs.shutdown();
  });
});
