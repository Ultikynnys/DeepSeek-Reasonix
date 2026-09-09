import { describe, expect, it } from "vitest";
import { USD_TO_CNY, convertUsd, currencySymbol, formatMoney } from "./money";

describe("money display", () => {
  it("uses one conversion rate and formatter for both currencies", () => {
    expect(convertUsd(2, "CNY")).toBe(2 * USD_TO_CNY);
    expect(convertUsd(2, "USD")).toBe(2);
    expect(currencySymbol("CNY")).toBe("¥");
    expect(formatMoney(2, "CNY")).toBe(`¥ ${(2 * USD_TO_CNY).toFixed(4)}`);
    expect(formatMoney(2, "USD")).toBe("$ 2.0000");
  });
});
