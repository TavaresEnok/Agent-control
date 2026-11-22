import {lstat, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

const MAX_MODULES_TXT = 4 * 1024 * 1024;
const MAX_GO_MOD = 2 * 1024 * 1024;

/**
 * Pacotes de uma pasta vendor do Go conferida contra o manifesto:
 * - a pasta se chama vendor e está ao lado de um go.mod, na raiz do módulo;
 * - vendor/modules.txt existe, e cada módulo listado nele aparece no go.mod com a mesma versão.
 * Devolve os caminhos de pacote e de raiz de módulo listados. Sem isso tudo, undefined:
 * a pasta é examinada como código do projeto.
 */
export async function goVendorPackages(dir: string, name: string): Promise<Set<string> | undefined> {
  if (name !== 'vendor') return undefined;
  const goMod = await readRegular(join(dirname(dir), 'go.mod'), MAX_GO_MOD);
  const modulesTxt = await readRegular(join(dir, 'modules.txt'), MAX_MODULES_TXT);
  if (goMod === undefined || modulesTxt === undefined) return undefined;
  const declared = goModRequirements(goMod);
  const listed = new Set<string>();
  let modules = 0;
  for (const raw of modulesTxt.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('## ')) continue;
    if (line.startsWith('# ')) {
      // "# caminho versão" ou "# caminho versão => substituto". Substituição local não é dependência de terceiros.
      const [path, version, arrow, target] = line.slice(2).split(/\s+/u);
      if (!path || !version) return undefined;
      if (arrow === '=>' && (target === undefined || target.startsWith('.') || target.startsWith('/'))) return undefined;
      if (declared.get(path) !== version) return undefined;
      listed.add(path);
      modules += 1;
      continue;
    }
    if (line.startsWith('#') || /\s/u.test(line) || line.includes('..')) return undefined;
    listed.add(line);
  }
  return modules > 0 ? listed : undefined;
}

/** O arquivo, relativo à pasta vendor, está num pacote ou raiz de módulo listado. */
export function isListedVendorFile(relative: string, packages: ReadonlySet<string>): boolean {
  if (relative === 'modules.txt') return true;
  const slash = relative.lastIndexOf('/');
  return slash > 0 && packages.has(relative.slice(0, slash));
}

function goModRequirements(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/u, '').trim();
    if (line === '') continue;
    if (inBlock) {
      if (line === ')') { inBlock = false; continue; }
      const [path, version] = line.split(/\s+/u);
      if (path && version) out.set(path, version);
      continue;
    }
    if (/^require\s*\($/u.test(line)) { inBlock = true; continue; }
    const single = /^require\s+(\S+)\s+(\S+)$/u.exec(line);
    if (single?.[1] && single[2]) out.set(single[1], single[2]);
  }
  return out;
}

async function readRegular(path: string, max: number): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > max) return undefined;
  return readFile(path, 'utf8').catch(() => undefined);
}

export const VENDORED_REASON = 'pacotes Go de terceiros copiados em vendor e conferidos com o go.mod: fora do exame do modelo';

/** Nota honesta para o relatório: o que saiu e o que isso não cobre. */
export function vendoredNote(entries: readonly {dir: string; files: number}[]): string {
  const list = entries.slice(0, 10).map(entry => `${entry.dir} (${entry.files} arquivos)`).join(', ');
  return `Pacotes Go de terceiros em vendor, conferidos com o go.mod, ficaram fora do exame do modelo: ${list}. `
    + 'As ferramentas leem o repositório inteiro e apontam vulnerabilidades conhecidas e segredos, mas não detectam uma alteração local no código copiado. '
    + 'Arquivos em vendor fora dos pacotes listados no modules.txt foram examinados.';
}
