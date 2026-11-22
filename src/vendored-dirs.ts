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
  let current: string | undefined;
  for (const raw of modulesTxt.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('## ')) continue;
    if (line.startsWith('# ')) {
      // "# caminho versão" ou "# caminho versão => substituto". Substituição local não é dependência de terceiros.
      const [path, version, arrow, target] = line.slice(2).split(/\s+/u);
      if (!path || !version) return undefined;
      if (arrow === '=>' && (target === undefined || target.startsWith('.') || target.startsWith('/'))) return undefined;
      if (declared.get(path) !== version) return undefined;
      current = path;
      listed.add(path);
      modules += 1;
      continue;
    }
    // Cada pacote pertence ao módulo do cabeçalho logo acima: o próprio módulo ou um subcaminho dele.
    if (current === undefined || line.startsWith('#') || /\s/u.test(line) || line.includes('..')) return undefined;
    if (line !== current && !line.startsWith(`${current}/`)) return undefined;
    listed.add(line);
  }
  return modules > 0 ? listed : undefined;
}

/** O que o `go mod vendor` copia: fontes Go, assembly e C, e os avisos de licença. */
const VENDOR_SOURCE = /\.(?:go|s|c|h)$/u;
const VENDOR_NOTICE = /^(?:LICEN[CS]E|COPYING|NOTICE|PATENTS|AUTHORS|CONTRIBUTORS)(?:[-_][A-Za-z0-9]+)?(?:\.(?:txt|md|rst))?$/u;

/** O arquivo, relativo à pasta vendor, é fonte ou aviso de um pacote ou raiz de módulo listado. */
export function isListedVendorFile(relative: string, packages: ReadonlySet<string>): boolean {
  if (relative === 'modules.txt') return true;
  const slash = relative.lastIndexOf('/');
  if (slash <= 0 || !packages.has(relative.slice(0, slash))) return false;
  const name = relative.slice(slash + 1);
  return VENDOR_SOURCE.test(name) || VENDOR_NOTICE.test(name);
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
  const info = await lstat(path).catch(() => undefined /* missing manifest: the folder stays in the exam */);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > max) return undefined;
  return readFile(path, 'utf8').catch(() => undefined /* unreadable manifest: the folder stays in the exam */);
}

export const VENDORED_REASON = 'pacotes Go de terceiros copiados em vendor e conferidos com o go.mod: fora do exame do modelo';

/** Nota honesta para o relatório: o que saiu, a impressão digital e o que isso não cobre. */
export function vendoredNote(entries: readonly {dir: string; files: number; digest?: string}[]): string {
  const shown = entries.slice(0, 10).map(entry => `${entry.dir} (${entry.files} arquivos${entry.digest ? `, sha256 ${entry.digest}` : ''})`).join(', ');
  const more = entries.length > 10 ? ` e mais ${entries.length - 10} pastas` : '';
  return `Fontes de pacotes Go de terceiros em vendor, declarados no go.mod e no modules.txt, ficaram fora do exame do modelo: ${shown}${more}. `
    + 'Isso não prova que o código seja de terceiros: uma alteração local no código copiado não é detectada pelo modelo. '
    + 'As ferramentas do módulo que leem o repositório continuam lendo a pasta. A impressão digital mostra num reexame se esses arquivos mudaram. '
    + 'Os demais arquivos em vendor seguem as regras normais do exame.';
}

/**
 * Impressão digital estável dos arquivos que saíram: caminho relativo à pasta vendor e conteúdo, em ordem.
 * Um arquivo ilegível entra marcado como ilegível, nunca como vazio.
 */
export async function vendoredDigest(vendorDir: string, relativeFiles: readonly string[]): Promise<string> {
  const {createHash} = await import('node:crypto');
  const hash = createHash('sha256');
  for (const file of [...relativeFiles].sort()) {
    const body = await readFile(join(vendorDir, file)).catch(() => undefined /* recorded as unreadable in the digest below */);
    hash.update(file).update('\0');
    if (body === undefined) hash.update('ilegivel\0');
    else hash.update(String(body.length)).update('\0').update(body);
  }
  return hash.digest('hex');
}
