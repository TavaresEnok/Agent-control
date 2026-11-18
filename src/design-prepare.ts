import {randomUUID} from 'node:crypto';
import {Capacity, CapacityPolicy, type CapacityPolicy as CapacityPolicyValue} from './capacity.ts';
import {Refusal} from './contracts.ts';
import type {Effort} from './effort.ts';
import type {Ledger} from './ledger.ts';
import type pg from 'pg';

const CREATE_MODEL = 'claude-opus-5-5';
const CREATE_EFFORT = 'medium' as const;
const EXAMINER_MODEL = 'claude-sonnet-5-5';
const CATALOG_SOURCE = 'personal://account-add';
const CATALOG_EFFORTS = ['low', 'medium', 'high'] as const;
const CATALOG_ROLES = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;

type ProfileRow = {
  id: string;
  accountId: string;
  model: string;
  effort: string;
  enabled: boolean;
  revision: number;
};

type CatalogRow = {model: string; efforts: string[]};

export type DesignPrepareProfile = {
  purpose: 'criar' | 'examinador' | 'revisor';
  accountId: string;
  model: string;
  effort: string;
  profileId: string | null;
  action: 'reusar' | 'criar' | 'habilitar';
  seat: 'conta' | 'outra conta' | 'outra sessão';
};

export type DesignPrepareReport = {
  apply: boolean;
  unchanged: boolean;
  catalogAction: 'presente' | 'registrar';
  profiles: DesignPrepareProfile[];
  chain: {regular: string[]; emergency: string[]};
  contexts: string[];
  revisionFrom: number;
  revisionTo: number | null;
};

type PrepareFacts = {
  accounts: {id: string}[];
  profiles: ProfileRow[];
  catalog: CatalogRow[];
  previous: CapacityPolicyValue | null;
  revision: number;
  contexts: string[];
  opusEfforts: string[] | null;
};

type SeatPlan = {
  criar: DesignPrepareProfile;
  examinador: DesignPrepareProfile;
  revisor: DesignPrepareProfile;
  chain: {regular: string[]; emergency: string[]};
  reusePolicy: boolean;
};

/**
 * Mostra ou publica a cadeia `roles.specialist` sem mexer nos outros papéis.
 * Sem `apply`, só lê. Com `apply`, cria perfis, registra o Opus se faltar e
 * atribui a revisão só aos contextos sem política.
 */
export async function prepareDesignSpecialist(input: {
  ledger: Ledger;
  owner: string;
  projectId: string;
  apply: boolean;
}): Promise<DesignPrepareReport> {
  const facts = await input.ledger.tx(client => loadFacts(client, input.owner, input.projectId));
  if (facts.opusEfforts && !facts.opusEfforts.includes(CREATE_EFFORT)) {
    throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  }
  const plan = seatPlan(facts);
  const catalogAction = facts.opusEfforts?.includes(CREATE_EFFORT) ? 'presente' as const : 'registrar' as const;
  const contexts = facts.contexts;
  const unchanged = plan.reusePolicy && catalogAction === 'presente' && contexts.length === 0
    && plan.criar.action === 'reusar' && plan.examinador.action === 'reusar' && plan.revisor.action === 'reusar';
  if (!input.apply || unchanged) {
    return {
      apply: input.apply,
      unchanged,
      catalogAction,
      profiles: [plan.criar, plan.examinador, plan.revisor],
      chain: plan.chain,
      contexts,
      revisionFrom: facts.revision,
      revisionTo: unchanged || plan.reusePolicy ? facts.revision : null,
    };
  }
  const written = await input.ledger.tx(async client => {
    const capacity = new Capacity(input.ledger, client);
    if (catalogAction === 'registrar') {
      try {
        await capacity.registerModel(input.owner, {
          provider: 'claude',
          model: CREATE_MODEL,
          efforts: [...CATALOG_EFFORTS],
          roles: [...CATALOG_ROLES],
          source: CATALOG_SOURCE,
        });
      } catch (error) {
        if (error instanceof Refusal && (error.code === 'CATALOG_ENTRY_CONFLICT' || error.code === 'ModelDisabledByPolicy')) {
          throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
        }
        throw error;
      }
    }
    const criar = await ensureProfile(capacity, client, input.owner, input.projectId, plan.criar);
    const examinador = await ensureProfile(capacity, client, input.owner, input.projectId, plan.examinador, [criar]);
    const revisor = await ensureProfile(capacity, client, input.owner, input.projectId, plan.revisor, [criar, examinador]);
    if (new Set([criar, examinador, revisor]).size !== 3) {
      throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
    }
    const chain = {regular: [criar, examinador], emergency: [revisor]};
    const stored = (await client.query<{snapshot: unknown; revision: number}>(
      'SELECT snapshot, revision FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',
      [input.projectId],
    )).rows[0];
    const previous = stored ? CapacityPolicy.parse(stored.snapshot) : facts.previous;
    const revisionNow = stored ? Number(stored.revision) : 0;
    const policy = CapacityPolicy.parse({
      ...(previous ?? {schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2, roles: {}}),
      roles: {...(previous?.roles ?? {}), specialist: chain},
    });
    let revision = revisionNow;
    if (!sameChain(previous?.roles.specialist, chain)) {
      revision = await capacity.publish(input.owner, input.projectId, revisionNow, policy);
    }
    const pending = (await client.query<{id: string}>(
      `SELECT id::text AS id FROM ac_contexts
       WHERE project_id=$1 AND NOT archived AND capacity_policy_revision IS NULL
       ORDER BY id`,
      [input.projectId],
    )).rows.map(row => row.id);
    for (const contextId of pending) await capacity.assignPolicy(input.owner, contextId, revision);
    return {criar, examinador, revisor, chain, revision, contexts: pending};
  });
  return {
    apply: true,
    unchanged: false,
    catalogAction,
    profiles: [
      {...plan.criar, profileId: written.criar},
      {...plan.examinador, profileId: written.examinador},
      {...plan.revisor, profileId: written.revisor},
    ],
    chain: written.chain,
    contexts: written.contexts,
    revisionFrom: facts.revision,
    revisionTo: written.revision,
  };
}

export function formatDesignPrepare(report: DesignPrepareReport): string {
  if (report.unchanged) return 'Nada a mudar.';
  const lines = [
    report.apply ? 'Preparação aplicada.' : 'Preparação, sem gravar.',
    `Catálogo: ${report.catalogAction === 'presente' ? `${CREATE_MODEL} já está no catálogo.` : report.apply ? `${CREATE_MODEL} entrou por ${CATALOG_SOURCE}.` : `${CREATE_MODEL} entraria por ${CATALOG_SOURCE}.`}`,
    'Perfis specialist:',
  ];
  for (const profile of report.profiles) {
    const id = profile.profileId ?? 'novo';
    lines.push(`- ${profile.purpose}: ${profile.model} ${profile.effort} conta ${profile.accountId} perfil ${id} (${profile.action}, ${profile.seat})`);
  }
  lines.push('Cadeia specialist:');
  lines.push(`- regular: ${report.chain.regular.join(', ') || 'vazia'}`);
  lines.push(`- emergência: ${report.chain.emergency.join(', ') || 'vazia'}`);
  lines.push(`Contextos sem política: ${report.contexts.join(', ') || 'nenhum'}`);
  if (report.revisionTo !== null && report.revisionTo !== report.revisionFrom) {
    lines.push(`Revisão: ${report.revisionFrom} -> ${report.revisionTo}`);
  } else if (!report.apply && !report.unchanged) {
    lines.push(`Revisão atual: ${report.revisionFrom}`);
  }
  return lines.join('\n');
}

async function loadFacts(client: pg.PoolClient, owner: string, projectId: string): Promise<PrepareFacts> {
  const mode = (await client.query<{mode: string}>('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0]?.mode;
  if (mode !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const member = await client.query(
    "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",
    [projectId, owner],
  );
  if (!member.rowCount) throw new Refusal('PROJECT_OWNER_REQUIRED', 403);
  const accounts = (await client.query<{id: string}>(
    `SELECT a.id::text AS id FROM ac_accounts a
     JOIN ac_account_access x ON x.account_id=a.id
     WHERE x.project_id=$1 AND a.owner_id=$2 AND a.provider='claude' AND a.enabled
     ORDER BY a.id`,
    [projectId, owner],
  )).rows;
  if (accounts.length === 0) throw new Refusal('DESIGN_PREPARE_NO_CLAUDE', 409);
  const profiles = (await client.query<{id: string; account_id: string; model: string; effort: string; enabled: boolean; revision: number}>(
    `SELECT p.id::text AS id, p.account_id::text AS account_id, p.model, p.effort, p.enabled, p.revision
     FROM ac_profiles p
     JOIN ac_accounts a ON a.id=p.account_id
     JOIN ac_account_access x ON x.account_id=a.id
     WHERE x.project_id=$1 AND a.owner_id=$2 AND a.provider='claude' AND p.role='specialist'
     ORDER BY p.id`,
    [projectId, owner],
  )).rows.map(row => ({
    id: row.id,
    accountId: row.account_id,
    model: row.model,
    effort: row.effort,
    enabled: row.enabled,
    revision: Number(row.revision),
  }));
  const stored = (await client.query<{snapshot: unknown; revision: number}>(
    'SELECT snapshot, revision FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',
    [projectId],
  )).rows[0];
  const opus = (await client.query<{efforts: string[]}>(
    "SELECT efforts FROM ac_model_catalog WHERE provider='claude' AND model=$1",
    [CREATE_MODEL],
  )).rows[0];
  const contexts = (await client.query<{id: string}>(
    `SELECT id::text AS id FROM ac_contexts
     WHERE project_id=$1 AND NOT archived AND capacity_policy_revision IS NULL
     ORDER BY id`,
    [projectId],
  )).rows.map(row => row.id);
  const catalog = (await client.query<{model: string; efforts: string[]}>(
    "SELECT model, efforts FROM ac_model_catalog WHERE provider='claude' ORDER BY model",
  )).rows;
  return {
    accounts,
    profiles,
    catalog,
    previous: stored ? CapacityPolicy.parse(stored.snapshot) : null,
    revision: stored ? Number(stored.revision) : 0,
    contexts,
    opusEfforts: opus ? opus.efforts : null,
  };
}

function seatPlan(facts: PrepareFacts): SeatPlan {
  const primary = facts.accounts[0];
  const secondary = facts.accounts[1] ?? primary;
  if (!primary || !secondary) throw new Refusal('DESIGN_PREPARE_NO_CLAUDE', 409);
  const reused = facts.previous?.roles.specialist
    ? reuseChain(facts.previous.roles.specialist, facts.profiles, primary.id, secondary.id)
    : null;
  if (reused) {
    return {
      criar: profileReport('criar', reused.criar, 'conta'),
      examinador: profileReport('examinador', reused.examinador, 'conta'),
      revisor: profileReport('revisor', reused.revisor, reused.revisor.accountId === primary.id ? 'outra sessão' : 'outra conta'),
      chain: {
        regular: [reused.criar.id, reused.examinador.id],
        emergency: [reused.revisor.id],
      },
      reusePolicy: true,
    };
  }
  const examiner = examinerChoice(facts);
  const used = new Set<string>();
  const criarRow = take(facts.profiles, row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === CREATE_EFFORT, used);
  const examinerRow = take(facts.profiles, row => row.accountId === primary.id && row.model === examiner.model && row.effort === examiner.effort, used);
  const reviewerRow = take(
    facts.profiles,
    row => row.accountId === secondary.id && row.model === examiner.model && row.effort === examiner.effort,
    used,
  );
  const criar = planned('criar', primary.id, CREATE_MODEL, CREATE_EFFORT, criarRow, 'conta');
  const examinador = planned('examinador', primary.id, examiner.model, examiner.effort, examinerRow, 'conta');
  const revisor = planned(
    'revisor',
    secondary.id,
    examiner.model,
    examiner.effort,
    reviewerRow,
    secondary.id === primary.id ? 'outra sessão' : 'outra conta',
  );
  return {
    criar,
    examinador,
    revisor,
    chain: {
      regular: [criar.profileId ?? `novo:${criar.purpose}`, examinador.profileId ?? `novo:${examinador.purpose}`],
      emergency: [revisor.profileId ?? `novo:${revisor.purpose}`],
    },
    reusePolicy: false,
  };
}

function examinerChoice(facts: PrepareFacts): {model: string; effort: Effort} {
  const offers = (model: string, effort: string) => facts.catalog.some(row => row.model === model && row.efforts.includes(effort));
  if (offers(EXAMINER_MODEL, 'medium')) return {model: EXAMINER_MODEL, effort: 'medium'};
  const other = facts.catalog.find(row => row.model !== CREATE_MODEL && row.efforts.includes('medium'));
  if (other) return {model: other.model, effort: 'medium'};
  const opusReady = facts.opusEfforts === null || facts.opusEfforts.includes(CREATE_EFFORT);
  if (opusReady) return {model: CREATE_MODEL, effort: 'medium'};
  const any = facts.catalog.find(row => row.efforts.some(effort => effort === 'medium' || effort === 'high' || effort === 'low'));
  const effort = any ? (['medium', 'high', 'low'] as const).find(item => any.efforts.includes(item)) : undefined;
  if (!any || !effort) throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  return {model: any.model, effort};
}

function reuseChain(
  chain: {regular: string[]; emergency: string[]},
  rows: ProfileRow[],
  primaryId: string,
  secondaryId: string,
): {criar: ProfileRow; examinador: ProfileRow; revisor: ProfileRow} | null {
  const byId = new Map(rows.map(row => [row.id, row]));
  const regular = chain.regular.map(id => byId.get(id)).filter((row): row is ProfileRow => row !== undefined);
  const emergency = chain.emergency.map(id => byId.get(id)).filter((row): row is ProfileRow => row !== undefined);
  const criar = regular.find(row => row.accountId === primaryId && row.model === CREATE_MODEL && row.effort === CREATE_EFFORT);
  const examinador = regular.find(row => row.accountId === primaryId && row.id !== criar?.id);
  const revisor = emergency.find(row => row.accountId === secondaryId && row.id !== criar?.id && row.id !== examinador?.id);
  if (!criar || !examinador || !revisor) return null;
  if (new Set([criar.id, examinador.id, revisor.id]).size !== 3) return null;
  return {criar, examinador, revisor};
}

function profileReport(purpose: DesignPrepareProfile['purpose'], row: ProfileRow, seat: DesignPrepareProfile['seat']): DesignPrepareProfile {
  return {
    purpose,
    accountId: row.accountId,
    model: row.model,
    effort: row.effort,
    profileId: row.id,
    action: row.enabled ? 'reusar' : 'habilitar',
    seat,
  };
}

function planned(
  purpose: DesignPrepareProfile['purpose'],
  accountId: string,
  model: string,
  effort: string,
  row: ProfileRow | undefined,
  seat: DesignPrepareProfile['seat'],
): DesignPrepareProfile {
  return {
    purpose,
    accountId,
    model,
    effort,
    profileId: row?.id ?? null,
    action: row === undefined ? 'criar' : row.enabled ? 'reusar' : 'habilitar',
    seat,
  };
}

function take(rows: ProfileRow[], pred: (row: ProfileRow) => boolean, used: Set<string>): ProfileRow | undefined {
  const found = rows.filter(row => !used.has(row.id) && pred(row)).sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const row = found[0];
  if (row) used.add(row.id);
  return row;
}

async function ensureProfile(
  capacity: Capacity,
  client: pg.PoolClient,
  owner: string,
  projectId: string,
  profile: DesignPrepareProfile,
  avoid: readonly string[] = [],
): Promise<string> {
  if (profile.profileId && profile.action !== 'criar' && !avoid.includes(profile.profileId)) {
    if (profile.action === 'habilitar') {
      const revision = Number((await client.query('SELECT revision FROM ac_profiles WHERE id=$1', [profile.profileId])).rows[0]?.revision);
      await capacity.setEnabled(owner, projectId, 'profile', {id: profile.profileId, enabled: true, expectedRevision: revision});
    }
    return profile.profileId;
  }
  const existing = (await client.query<{id: string; enabled: boolean; revision: number}>(
    `SELECT id::text AS id, enabled, revision FROM ac_profiles
     WHERE account_id=$1 AND model=$2 AND effort=$3 AND role='specialist' AND NOT (id=ANY($4::uuid[]))
     ORDER BY enabled DESC, id`,
    [profile.accountId, profile.model, profile.effort, avoid],
  )).rows[0];
  if (existing) {
    if (!existing.enabled) {
      await capacity.setEnabled(owner, projectId, 'profile', {id: existing.id, enabled: true, expectedRevision: Number(existing.revision)});
    }
    return existing.id;
  }
  const id = randomUUID();
  await capacity.addProfile(owner, projectId, {
    id,
    accountId: profile.accountId,
    model: profile.model,
    effort: profile.effort as Effort,
    role: 'specialist',
  });
  return id;
}

function sameChain(
  stored: {regular: string[]; emergency: string[]} | undefined,
  chain: {regular: string[]; emergency: string[]},
): boolean {
  if (!stored) return false;
  return sameIds(stored.regular, chain.regular) && sameIds(stored.emergency, chain.emergency);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
