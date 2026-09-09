export const USD_TO_CNY = 7.2;

export type DisplayCurrency = "CNY" | "USD";

export function currencySymbol(currency: DisplayCurrency): "¥" | "$" {
  return currency === "CNY" ? "¥" : "$";
}

export function convertUsd(amountUsd: number, currency: DisplayCurrency): number {
  return currency === "CNY" ? amountUsd * USD_TO_CNY : amountUsd;
}

export function formatMoney(amountUsd: number, currency: DisplayCurrency): string {
  return `${currencySymbol(currency)} ${convertUsd(amountUsd, currency).toFixed(4)}`;
}
