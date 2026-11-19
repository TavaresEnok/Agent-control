import {calculateInvoice} from './billing.ts';

/**
 * Processa a rota de faturamento do assinante.
 * @param customerId Identificador do assinante
 * @param amountCents Valor base em centavos
 * @see {@link MissingTaxTable}
 * @returns Resumo calculado da fatura
 */
export function handleBillingRoute(customerId: string, amountCents: number): {customerId: string; totalCents: number} {
  return {
    customerId,
    totalCents: calculateInvoice(amountCents, 0.12),
  };
}
