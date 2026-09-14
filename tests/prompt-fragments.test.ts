/** escalationContract: model-aware identity without model-authored routing controls. */

import { describe, expect, it } from "vitest";
import { ESCALATION_CONTRACT, escalationContract } from "../src/prompt-fragments.js";

describe("escalationContract", () => {
  it("identifies the active model and requires a direct answer", () => {
    const out = escalationContract("deepseek-v4-flash");
    expect(out).toContain("`deepseek-v4-flash`");
    expect(out).toContain("Deliver the strongest answer you can directly");
    expect(out).toContain("If asked which model you are, answer `deepseek-v4-flash`");
  });

  it("never teaches any model to emit a self-escalation marker", () => {
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-terra", "future-model"]) {
      const out = escalationContract(id);
      expect(out).not.toContain("NEEDS_PRO");
      expect(out).not.toContain("retries this turn");
      expect(out).not.toContain("requested escalation");
    }
  });

  it("keeps the compatibility export aligned with the default model note", () => {
    expect(ESCALATION_CONTRACT).toBe(escalationContract("deepseek-v4-flash"));
  });
});
