import { describe, expect, it } from "vitest";
import {
  GMAIL_MCP_URL,
  GMAIL_OAUTH_REDIRECT_URI,
  GMAIL_SCOPES,
  buildGmailAuthorizeUrl,
  isGmailMailSpec,
} from "../src/mcp/gmail-mail.js";
import { parseMcpSpec } from "../src/mcp/spec.js";

describe("managed Gmail MCP", () => {
  it("recognizes only the managed named official Streamable HTTP endpoint", () => {
    expect(isGmailMailSpec(parseMcpSpec(`gmail_mail=streamable+${GMAIL_MCP_URL}`))).toBe(true);
    expect(isGmailMailSpec(parseMcpSpec(`other=streamable+${GMAIL_MCP_URL}`))).toBe(false);
    expect(isGmailMailSpec(parseMcpSpec("gmail_mail=streamable+https://example.com/mcp"))).toBe(
      false,
    );
  });

  it("builds a PKCE Google authorization request with the documented Gmail scopes", () => {
    const url = new URL(
      buildGmailAuthorizeUrl({
        clientId: "client.apps.googleusercontent.com",
        redirectUri: GMAIL_OAUTH_REDIRECT_URI,
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(GMAIL_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GMAIL_SCOPES]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});
