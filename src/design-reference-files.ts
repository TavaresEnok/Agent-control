import {chmod, mkdir, open, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {Refusal} from './contracts.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpe?g)$/i;
const MAX_REFERENCES = 10;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Copia até 10 imagens para o diretório privado da rodada.
 * Nunca grava no repositório do projeto.
 */
export async function stageDesignReferences(input: {
  dataDirectory: string;
  runId: string;
  files: readonly {name: string; bytes: Buffer}[];
  repository?: string;
}): Promise<{directory: string; note: string}> {
  if (input.files.length > MAX_REFERENCES) throw new Refusal('DESIGN_REFERENCE_LIMIT', 400);
  const directory = join(input.dataDirectory, 'design-referencias', input.runId);
  if (input.repository && directory.startsWith(input.repository)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const names: string[] = [];
  const seen = new Set((await readdir(directory)).map(entry => entry.toLowerCase()));
  for (const file of input.files) {
    if (!NAME.test(file.name) || file.bytes.length < 8 || file.bytes.length > MAX_BYTES) throw new Refusal('DESIGN_REFERENCE_INVALID', 400);
    const png = file.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = file.bytes[0] === 0xff && file.bytes[1] === 0xd8;
    if (!png && !jpg) throw new Refusal('DESIGN_REFERENCE_INVALID', 400);
    const lower = file.name.toLowerCase();
    if (seen.has(lower)) throw new Refusal('DESIGN_REFERENCE_INVALID', 400);
    seen.add(lower);
    const path = join(directory, lower);
    let handle;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (isEexist(error)) throw new Refusal('DESIGN_REFERENCE_INVALID', 400);
      throw error;
    }
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    names.push(lower);
  }
  await chmod(directory, 0o700);
  const note = names.length === 0 ? '' : `Referências visuais (${names.length}): ${names.join(', ')}. Compare cada eixo: a referência usa uma solução e a tela usa outra.`;
  return {directory, note};
}

export async function readReferenceFiles(paths: readonly string[]): Promise<{name: string; bytes: Buffer}[]> {
  const {readFile, stat} = await import('node:fs/promises');
  const {basename} = await import('node:path');
  const files: {name: string; bytes: Buffer}[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) throw new Refusal('DESIGN_REFERENCE_INVALID', 400);
    const name = basename(path);
    files.push({name, bytes: await readFile(path)});
  }
  return files;
}

function isEexist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}