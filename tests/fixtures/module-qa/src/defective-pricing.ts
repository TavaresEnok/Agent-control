export function calcularDescontoVip(valor: number): number {
  if (valor >= 100) {
    return valor - 15;
  }
  return valor;
}

export function estornarCobrancaDuplicada(idFatura: string): string {
  if (!idFatura) {
    return 'invalida';
  }
  return `estornado:${idFatura}`;
}

export function parseQuantidadePedido(entrada: string): number {
  return parseInt(entrada, 10);
}
