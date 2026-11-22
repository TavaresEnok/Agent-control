import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DESIGN_EXAM_CONTAINER, DESIGN_RUNTIME_BIN} from './design-image.ts';

/**
 * Contêineres de design deste processo (exame e login) que ainda podem estar de pé.
 * Matar o cliente `docker run` não para o contêiner: ele é removido pelo nome.
 */
const active = new Set<string>();
let closed = false;

/** Reserva um nome para um contêiner novo. Depois do fechamento da sessão, recusa: nada sobe depois da limpeza. */
export function claimDesignContainer(): string {
  if (closed) throw new Error('DESIGN_SESSION_CLOSED');
  const name = `ac-design-exam-${randomUUID()}`;
  active.add(name);
  return name;
}

let remover: (name: string) => Promise<void> = name => removeByDocker(name);

/** Só para testes: troca o docker rm -f por um registro. */
export function setDesignContainerRemoverForTest(fn: (name: string) => Promise<void>): void {
  remover = fn;
}

function remove(name: string): Promise<void> {
  return remover(name);
}

function removeByDocker(name: string): Promise<void> {
  if (!DESIGN_EXAM_CONTAINER.test(name)) return Promise.resolve();
  return new Promise(resolve => {
    const child = spawn(DESIGN_RUNTIME_BIN, ['rm', '-f', name], {stdio: 'ignore'});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

/** O contêiner terminou (ou o prazo venceu): remove pelo nome. Com --rm e saída normal, não acha nada. */
export async function releaseDesignContainer(name: string): Promise<void> {
  // Depois do fechamento, remove sempre: o contêiner pode ter sido criado depois do rm -f da limpeza.
  if (active.delete(name) || closed) await remove(name);
}

/** Fim da sessão, também na interrupção: remove o que está de pé e impede novos contêineres. */
export async function closeDesignContainers(): Promise<void> {
  closed = true;
  const names = [...active];
  active.clear();
  await Promise.all(names.map(remove));
}

/** Só para testes: reabre o registro. */
export function resetDesignContainersForTest(): void {
  closed = false;
  active.clear();
  remover = name => removeByDocker(name);
}
