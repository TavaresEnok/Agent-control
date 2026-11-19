# Serviço de Faturamento — Documentação

Módulo de cálculo de faturas do assinante.

## Funções públicas

- `calculateInvoice(amountCents, taxRate, obsoleteDiscount)` — calcula a fatura aplicando o desconto legado `obsoleteDiscount`.
- `handleBillingRoute(customerId, amountCents)` — rota principal de faturamento.

## Diagrama de dependências

```mermaid
flowchart LR
  A["src/api.ts"] --> B["src/billing.ts"]
  B["src/billing.ts"] --> A["src/api.ts"]; A --> C["src/legacy-tax.ts"]
```

## Fluxo com erro de sintaxe Mermaid

```mermaid
flowchart TD
  Inicio["Receber pedido"] --->|fatura quebrada
```
