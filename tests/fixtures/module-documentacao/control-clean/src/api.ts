import {calculateInvoice, formatCharge} from './billing.ts';

/**
 * Processa a rota de faturamento do assinante.
 * @param customerId Identificador do assinante
 * @param amountCents Valor base em centavos
 * @see {@link calculateInvoice}
 * @returns Resumo calculado da fatura
 */
export function handleBillingRoute(
  customerId: string,
  amountCents: number,
): {customerId: string; totalCents: number; summary: string} {
  const totalCents = calculateInvoice(amountCents, 0.12);
  return {
    customerId,
    totalCents,
    summary: formatCharge(customerId, totalCents),
  };
}
