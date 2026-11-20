#!/usr/bin/env node
/**
 * scripts/compactar-saida.mjs
 *
 * Filtro determinístico e simples para compressão de saída de comandos para LLMs/agentes:
 * 1. Em testes que passaram: guarda só o resumo.
 * 2. Em testes que falharam: preserva a falha inteira (mensagem de erro, stack trace e arquivo:linha).
 * 3. Corta linhas consecutivas repetidas (agrupando com "(repetida Nx)").
 * 4. Encurta caminhos absolutos longos preservando nomes de arquivo e arquivo:linha.
 * 5. Limita em N linhas com marcador "... X linhas omitidas".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Encurta caminhos longos no texto, preservando nomes de arquivo, linha e coluna.
 */
export function encurtarCaminhos(texto, cwd = process.cwd()) {
  const normalCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  let res = texto;

  // Substitui o CWD exato por ./
  if (normalCwd) {
    res = res.replaceAll(normalCwd + '/', './');
    res = res.replaceAll(normalCwd, '.');
  }

  // Substitui caminhos comuns de worktree do projeto: /home/app/projects/ac-wt/[^/]+/
  res = res.replace(/\/home\/app\/projects\/ac-wt\/[^/\s"':)]+\//g, './');

  // Substitui a raiz do projeto principal /home/app/projects/agent-control/
  res = res.replace(/\/home\/app\/projects\/agent-control\//g, './');

  // Substitui /home/app/projects/ por ~/projects/
  res = res.replace(/\/home\/app\/projects\//g, '~/projects/');

  // Substitui /home/app/ por ~/
  res = res.replace(/\/home\/app\//g, '~/');

  // Encurta file://./ ou file:///home/app/...
  res = res.replace(/file:\/\/\.\//g, 'file://./');

  return res;
}

/**
 * Agrupa linhas consecutivas idênticas.
 */
export function agruparLinhasRepetidas(linhas) {
  if (linhas.length === 0) return [];
  const out = [];
  let atual = linhas[0];
  let cont = 1;

  for (let i = 1; i < linhas.length; i++) {
    if (linhas[i] === atual && atual.trim().length > 0) {
      cont++;
    } else {
      if (cont > 1) {
        out.push(`${atual} [repetida ${cont}x]`);
      } else {
        out.push(atual);
      }
      atual = linhas[i];
      cont = 1;
    }
  }

  if (cont > 1) {
    out.push(`${atual} [repetida ${cont}x]`);
  } else {
    out.push(atual);
  }

  return out;
}

/**
 * Detecta e processa saídas de suites de teste (Node --test, Vitest, Jest, etc.).
 * Retorna null se não for reconhecido como saída de teste.
 */
export function processarSaidaTestes(texto) {
  const linhas = texto.split(/\r?\n/);
  const temIndicadorNodeTest = linhas.some(l => /ℹ\s+(tests|pass|fail)\s+\d+/.test(l) || /✔|✖/.test(l));
  const temIndicadorVitest = linhas.some(l => /Tests\s+\d+\s+passed/i.test(l) || /Test Files/i.test(l));

  if (!temIndicadorNodeTest && !temIndicadorVitest) {
    return null;
  }

  // Verifica se houve falha
  const temFalhaNode = linhas.some(l => /ℹ\s+fail\s+[1-9]\d*/.test(l) || /✖ failing tests:/.test(l) || /Error\s*(\[[^\]]+\])?:/.test(l));
  const temFalhaVitest = linhas.some(l => /FAIL\s+/.test(l) || /failed\s+\([1-9]\d*\)/i.test(l));
  const falhou = temFalhaNode || temFalhaVitest;

  if (falhou) {
    // Em testes que falharam: MOSTRA A FALHA INTEIRA
    // Mantemos todo o bloco de erro, removendo apenas prefixos de caminho longos
    return {
      falhou: true,
      linhas: linhas.map(l => encurtarCaminhos(l))
    };
  }

  // Em testes que passaram: GUARDA SÓ O RESUMO
  const linhasResumo = [];
  for (const l of linhas) {
    // Mantém linhas de resumo (ℹ pass, ℹ tests, duration, ou último status)
    if (/ℹ\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+/.test(l)) {
      linhasResumo.push(l.trim());
    } else if (/✔/.test(l) && linhasResumo.length < 5) {
      // Guarda até 5 itens de teste com check
      linhasResumo.push(encurtarCaminhos(l.trim()));
    } else if (/Tests\s+\d+\s+passed/i.test(l) || /Test Files/i.test(l) || /Duration\s+/i.test(l)) {
      linhasResumo.push(l.trim());
    }
  }

  if (linhasResumo.length === 0) {
    linhasResumo.push('✔ Todos os testes passaram com sucesso.');
  }

  return {
    falhou: false,
    linhas: linhasResumo
  };
}

/**
 * Função principal de compactação.
 */
export function compactarSaida(input, options = {}) {
  const maxLinhas = Number(options.maxLinhas ?? process.env.COMPACTAR_MAX_LINES ?? 50);
  const cwd = options.cwd ?? process.cwd();

  // 1. Tenta tratar como teste primeiro
  const resultadoTeste = processarSaidaTestes(input);
  let linhas;

  if (resultadoTeste) {
    if (!resultadoTeste.falhou) {
      // Testes passaram: resumo direto
      return resultadoTeste.linhas.join('\n');
    }
    // Testes falharam: falha inteira preservada
    linhas = resultadoTeste.linhas;
  } else {
    // Saída genérica: encurtar caminhos e dividir em linhas
    linhas = encurtarCaminhos(input, cwd).split(/\r?\n/);
  }

  // 2. Remove linhas vazias excessivas no final
  while (linhas.length > 0 && linhas[linhas.length - 1].trim() === '') {
    linhas.pop();
  }

  // 3. Corta linhas repetidas
  linhas = agruparLinhasRepetidas(linhas);

  // 4. Limita em N linhas com aviso se exceder
  if (linhas.length <= maxLinhas) {
    return linhas.join('\n');
  }

  // Se exceder maxLinhas:
  // Se for teste com falha, preservamos até onde for possível sem cortar o cabeçalho do erro
  // Dividimos entre início (65%) e final (35%)
  const cabecalhoCount = Math.floor(maxLinhas * 0.65);
  const rodapeCount = maxLinhas - cabecalhoCount - 1; // 1 linha para o marcador de omissão
  const omitidas = linhas.length - cabecalhoCount - rodapeCount;

  const resultado = [
    ...linhas.slice(0, cabecalhoCount),
    `… ${omitidas} linhas omitidas`,
    ...linhas.slice(linhas.length - rodapeCount)
  ];

  return resultado.join('\n');
}

/**
 * Execução via CLI
 */
async function main() {
  const args = process.argv.slice(2);
  let maxLinhas = 50;
  let arquivo = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`Uso: compactar-saida.mjs [opções] [arquivo]
Opções:
  --max-lines, -n <N>  Número máximo de linhas na saída (padrão: 50)
  --help, -h          Mostra esta mensagem de ajuda
Exemplos:
  node scripts/compactar-saida.mjs < saida.txt
  node scripts/compactar-saida.mjs --max-lines 40 build.log
  npx tsc | node scripts/compactar-saida.mjs`);
      process.exit(0);
    } else if (arg === '--max-lines' || arg === '-n') {
      maxLinhas = parseInt(args[++i], 10);
    } else if (!arg.startsWith('-')) {
      arquivo = arg;
    }
  }

  let entrada = '';
  if (arquivo) {
    entrada = readFileSync(arquivo, 'utf8');
  } else {
    // Lê de stdin
    entrada = readFileSync(0, 'utf8');
  }

  const saida = compactarSaida(entrada, { maxLinhas });
  process.stdout.write(saida + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('Erro ao compactar saída:', err);
    process.exit(1);
  });
}
