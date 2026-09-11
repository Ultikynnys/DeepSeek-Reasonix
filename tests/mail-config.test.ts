import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailProvider } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearGmailOAuth, readConfig, saveGmailOAuth, saveMailProvider } from "../src/config.js";

describe("managed mail provider config", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-mail-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the selected provider enum value", () => {
    saveMailProvider(MailProvider.Gmail, path);
    expect(readConfig(path).mailProvider).toBe("gmail");
    saveMailProvider(MailProvider.Outlook, path);
    expect(readConfig(path).mailProvider).toBe("outlook");
  });

  it("drops an unrecognized provider id during sanitization", () => {
    writeFileSync(path, JSON.stringify({ mailProvider: "hotmail" }));
    expect(readConfig(path).mailProvider).toBeUndefined();
  });

  it("round-trips Gmail OAuth credentials and clears them independently", () => {
    saveGmailOAuth(
      {
        clientId: "id.apps.googleusercontent.com",
        clientSecret: "shh",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
        account: "ada@gmail.com",
      },
      path,
    );
    expect(readConfig(path).gmailOAuth?.account).toBe("ada@gmail.com");
    clearGmailOAuth(path);
    expect(readConfig(path).gmailOAuth).toBeUndefined();
  });
});
