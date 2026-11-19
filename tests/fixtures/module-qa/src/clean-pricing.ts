export function calcularDescontoFidelidade(valor: number): number {
  if (valor >= 100) {
    return valor - 15;
  }
  return valor;
}

export function parseQuantidadeSegura(entrada: string): number {
  if (!/^[1-9]\d{0,3}$/.test(entrada)) {
    throw new Error('QUANTIDADE_INVALIDA');
  }
  const parsed = Number.parseInt(entrada, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('QUANTIDADE_FORA_DE_FAIXA');
  }
  return parsed;
}
