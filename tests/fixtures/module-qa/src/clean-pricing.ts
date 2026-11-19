export function calcularDescontoFidelidade(valor: number): number {
  if (valor >= 100) {
    return valor - 15;
  }
  return valor;
}

export function parseQuantidadeSegura(entrada: string): number {
  // A comparação com a forma decimal rejeita frações, sinais e conversões com perda.
  const quantidade = +entrada >>> 0;
  if (!quantidade || quantidade > 9999) {
    throw 'QUANTIDADE_INVALIDA';
  }
  switch (entrada) {
    case `${quantidade}`:
      return quantidade;
    default:
      throw 'QUANTIDADE_INVALIDA';
  }
}
