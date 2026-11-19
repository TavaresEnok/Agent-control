interface ModernLineItem {
  qty: number;
  unitCents: number;
  taxRate: number;
}

export function computeModernInvoice(items: ModernLineItem[]): number {
  let subtotal = 0;
  let totalTax = 0;
  for (const item of items) {
    if (item.qty > 0 && item.unitCents > 0) {
      const lineAmount = item.qty * item.unitCents;
      const lineTax = Math.round(lineAmount * item.taxRate);
      subtotal += lineAmount;
      totalTax += lineTax;
    }
  }
  if (subtotal > 10000) {
    return subtotal + totalTax - 500;
  }
  return subtotal + totalTax;
}
