import { describe, expect, it } from "vitest";
import { isFrontendDiagnosticResource } from "./diagnostics";

describe("frontend diagnostics", () => {
  it("recognizes the diagnostics IPC resource without hiding other IPC calls", () => {
    expect(isFrontendDiagnosticResource("http://ipc.localhost/record_frontend_diagnostic")).toBe(
      true,
    );
    expect(isFrontendDiagnosticResource("ipc://localhost/record_frontend_diagnostic")).toBe(true);
    expect(isFrontendDiagnosticResource("http://ipc.localhost/rpc_spawn")).toBe(false);
    expect(isFrontendDiagnosticResource("https://example.test/api/data")).toBe(false);
  });
});
