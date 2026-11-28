import {execFile} from 'node:child_process';
import {Refusal} from './contracts.ts';
import {EXAM_DEPENDENCY_DOWN} from './exam-breaker.ts';
import {EGRESS_CONTAINER, personalEgressEnabled, PROVIDER_NETWORK, type EgressConfig} from './personal-egress.ts';

export type ExamDependency = 'proxy de saída' | 'banco' | 'imagem fixada';

/** EXAM_DEPENDENCY_DOWN with the dependency that is down, said to the operator before any model call. */
export class ExamDependencyDown extends Refusal {
  constructor(public readonly dependency: ExamDependency, public readonly detail: string) { super(EXAM_DEPENDENCY_DOWN, 503); }
}

export function examDependencyText(error: unknown): string | undefined {
  if (!(error instanceof ExamDependencyDown)) return undefined;
  return `Dependência do exame fora do ar: ${error.dependency} (${error.detail}). Nada foi enviado ao modelo. Suba a dependência e rode de novo (${EXAM_DEPENDENCY_DOWN}).`;
}

type Docker = (args: readonly string[]) => Promise<string>;
const defaultDocker: Docker = args => new Promise((resolve, reject) => {
  execFile('docker', [...args], {encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024}, (error, stdout) => {
    if (error) reject(error); else resolve(stdout);
  });
});

export type ExamPreflightInput = {
  /** Installation egress; the proxy is checked only when the personal egress is on. */
  egress?: Pick<EgressConfig, 'mode'>;
  /** `SELECT 1` on the installation database. */
  database?: () => Promise<unknown>;
  /** Image IDs or pinned references that must be present in the local Docker. */
  images?: readonly string[];
  docker?: Docker;
};

/**
 * Checks what every exam call needs before the exam and before each batch: the provider egress proxy running on the
 * provider network, the database answering and the pinned images present. Read only: it never starts or removes anything.
 */
export async function examPreflight(input: ExamPreflightInput): Promise<void> {
  const docker = input.docker ?? defaultDocker;
  if (personalEgressEnabled({egress: input.egress})) {
    let state = '';
    try {
      state = (await docker(['inspect', '--format', '{{.State.Running}} {{json .NetworkSettings.Networks}}', EGRESS_CONTAINER])).trim();
    } catch { throw new ExamDependencyDown('proxy de saída', `${EGRESS_CONTAINER} ausente`); }
    const [running, ...networks] = state.split(' ');
    if (running !== 'true') throw new ExamDependencyDown('proxy de saída', `${EGRESS_CONTAINER} parado`);
    let attached: Record<string, unknown> = {};
    try { attached = JSON.parse(networks.join(' ')) as Record<string, unknown>; } catch { attached = {}; }
    if (!attached || typeof attached !== 'object' || !Object.hasOwn(attached, PROVIDER_NETWORK)) {
      throw new ExamDependencyDown('proxy de saída', `${EGRESS_CONTAINER} fora da rede ${PROVIDER_NETWORK}`);
    }
  }
  if (input.database) {
    try { await input.database(); } catch { throw new ExamDependencyDown('banco', 'sem resposta'); }
  }
  for (const image of input.images ?? []) {
    try { await docker(['image', 'inspect', '--format', '{{.Id}}', image]); }
    catch { throw new ExamDependencyDown('imagem fixada', `${image.slice(0, 80)} ausente`); }
  }
}

/** The preflight of one installation: egress, its database and the native worker image when the runtime is active. */
export function installationExamPreflight(config: {egress?: Pick<EgressConfig, 'mode'>;
  nativeBootstrap?: {state: string; execution?: {workerImage: string}}},
ledger: {pool: {query: (sql: string) => Promise<unknown>}}, extraImages: readonly string[] = [], docker?: Docker): () => Promise<void> {
  const worker = config.nativeBootstrap?.state === 'active' ? config.nativeBootstrap.execution?.workerImage : undefined;
  const images = [...(worker ? [worker] : []), ...extraImages];
  return () => examPreflight({egress: config.egress, database: () => ledger.pool.query('SELECT 1'), images, ...(docker ? {docker} : {})});
}
