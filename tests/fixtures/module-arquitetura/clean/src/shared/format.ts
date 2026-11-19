export function formatCurrencyCents(cents: number): string {
  const units = (cents / 100).toFixed(2);
  return `R$ ${units}`;
}
