/**
 * Calcula o valor final da fatura do assinante em centavos.
 * @param amountCents Valor base da mensalidade em centavos
 * @param taxRate Alíquota de imposto decimal
 * @returns Valor final arredondado em centavos
 */
export function calculateInvoice(amountCents: number, taxRate: number): number {
  return Math.round(amountCents * (1 + taxRate));
}

/**
 * Formata o resumo da cobrança do assinante.
 * @param customerId Identificador do assinante
 * @param cents Valor cobrado em centavos
 * @returns Texto formatado da cobrança
 */
export function formatCharge(customerId: string, cents: number): string {
  return `${customerId}:${cents}`;
}
