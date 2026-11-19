export function formatCurrencyCents(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`;
}

export function unusedFormatter(raw: string): string {
  return raw.trim().toUpperCase();
}
