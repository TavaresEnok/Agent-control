export interface OrderRecord {
  id: string;
  totalCents: number;
}

export function calculateOrderTotal(baseCents: number, discountPercent: number): number {
  if (baseCents <= 0) return 0;
  const boundedDiscount = Math.min(Math.max(discountPercent, 0), 50);
  return Math.round(baseCents * (1 - boundedDiscount / 100));
}
