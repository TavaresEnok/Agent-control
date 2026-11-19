/**
 * Calcula o valor final da fatura do assinante em centavos.
 * @param amountCents Valor base da mensalidade em centavos
 * @param taxRate Alíquota de imposto decimal
 * @param obsoleteDiscount Parâmetro legado removido da assinatura real
 * @returns Valor final arredondado em centavos
 */
export function calculateInvoice(amountCents: number, taxRate: number): number {
  return Math.round(amountCents * (1 + taxRate));
}

export function undocumentedCharge(customerId: string, cents: number): string {
  return `${customerId}:${cents}`;
}
