export function encurtarCaminhos(texto: string, cwd?: string): string;
export function agruparLinhasRepetidas(linhas: string[]): string[];
export function processarSaidaTestes(texto: string): { falhou: boolean; [chave: string]: unknown } | null;
export function compactarSaida(input: string, options?: Record<string, unknown>): string;
