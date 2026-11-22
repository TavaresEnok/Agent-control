import {lstat} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Pasta `vendor` com assinatura de dependências de terceiros copiadas no repositório:
 * Go (`modules.txt`), Composer (`autoload.php`) ou Bundler (`bundle/`).
 * O exame do modelo não julga código de bibliotecas: as ferramentas do exame
 * (Trivy, govulncheck, Gitleaks, ScanCode) continuam lendo o repositório inteiro.
 * Sem a assinatura, uma pasta chamada vendor é examinada como qualquer outra.
 */
export async function isVendoredDependencyDir(dir: string, name: string): Promise<boolean> {
  if (name !== 'vendor') return false;
  for (const [marker, kind] of [['modules.txt', 'file'], ['autoload.php', 'file'], ['bundle', 'dir']] as const) {
    const info = await lstat(join(dir, marker)).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    if (kind === 'file' ? info.isFile() : info.isDirectory()) return true;
  }
  return false;
}

export const VENDORED_REASON = 'dependências de terceiros copiadas no repositório (vendor): fora do exame do modelo, cobertas pelas ferramentas';
