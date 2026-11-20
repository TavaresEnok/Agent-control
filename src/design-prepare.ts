import {randomUUID} from 'node:crypto';
import {Capacity, CapacityPolicy, type CapacityPolicy as CapacityPolicyValue} from './capacity.ts';
import {Id, Refusal} from './contracts.ts';
import type {Effort} from './effort.ts';
import type {Ledger} from './ledger.ts';
import type pg from 'pg';

const CREATE_MODEL = 'claude-opus-5-5';
const CREATE_EFFORT = 'high' as const;
const FUNCTIONAL_HIGH_REVIEW_EFFORT = 'medium' as const;
const EXAMINER_MODEL = 'claude-sonnet-5-5';
const EXAMINER_EFFORTS = ['medium', 'high'] as const;
const REVIEWER_EFFORT = 'medium' as const;
const CATALOG_SOURCE = 'personal://account-add';
const CATALOG_EFFORTS = ['medium', 'high'] as const;
const CATALOG_ROLES = ['specialist'] as const;
/** Esforços que cada modelo precisa ter no catálogo para os perfis specialist. */
const REQUIRED_EFFORTS: Record<string, readonly string[]> = {
  [CREATE_MODEL]: [CREATE_EFFORT, FUNCTIONAL_HIGH_REVIEW_EFFORT],
  [EXAMINER_MODEL]: EXAMINER_EFFORTS,
};
const MAX_CHAIN_PROFILES = 20;

type ProfileRow = {
  id: string;
  accountId: string;
  model: string;
  effort: string;
  enabled: boolean;
  revision: number;
};

type CatalogRow = {model: string; efforts: string[]; roles: string[]};

export type DesignPreparePurpose =
  | 'criar'
  | 'examinador-high'
  | 'examinador'
  | 'examinador-secundario-high'
  | 'examinador-secundario-medium'
  | 'revisor-alto'
  | 'revisor';

export type DesignPrepareProfile = {
  purpose: DesignPreparePurpose;
  accountId: string;
  model: string;
  effort: string;
  profileId: string | null;
  action: 'reusar' | 'criar' | 'habilitar' | 'mover';
  seat: 'conta' | 'outra conta' | 'outra sessão';
};

export type DesignCatalogAction = 'presente' | 'registrar' | 'atualizar' | 'bloqueado';

/** O que acontece (ou aconteceria) com o registro de um modelo no catálogo global. */
export type DesignCatalogModel = {
  model: string;
  action: DesignCatalogAction;
  /** Esforços do registro depois da ação; em `bloqueado`, os atuais. */
  efforts: string[];
  /** Esforços acrescentados (`registrar`/`atualizar`) ou que faltam (`bloqueado`). */
  missing: string[];
  /** Outros papéis que compartilham o registro. Só em `bloqueado`. */
  sharedRoles: string[];
};

export type DesignPrepareReport = {
  apply: boolean;
  unchanged: boolean;
  catalogAction: DesignCatalogAction;
  catalog: DesignCatalogModel[];
  primaryAccountId: string;
  profiles: DesignPrepareProfile[];
  chain: {regular: string[]; emergency: string[]};
  contexts: string[];
  revisionFrom: number;
  revisionTo: number | null;
};

type ContextPolicyRow = {
  id: string;
  capacityPolicyRevision: number | null;
};

type PrepareFacts = {
  accounts: {id: string}[];
  profiles: ProfileRow[];
  catalog: CatalogRow[];
  previous: CapacityPolicyValue | null;
  revision: number;
  contexts: ContextPolicyRow[];
  opus: CatalogRow | null;
  sonnet: CatalogRow | null;
};


type PlannedItem = {
  profile: DesignPrepareProfile;
  inTargetChain: boolean;
  targetChain: 'regular' | 'emergency';
  accountRole: 'primary' | 'secondary';
};

type SeatPlan = {
  primaryAccountId: string;
  items: PlannedItem[];
  migratedOpusMediumId: string | null;
  chain: {regular: string[]; emergency: string[]};
  reusePolicy: boolean;
};

/**
 * Mostra ou publica a cadeia `roles.specialist` sem mexer nos outros papéis.
 * Sem `apply`, só lê. Com `apply`, registra ou migra o catálogo de Opus e Sonnet,
 * garante os perfis `specialist` e atribui a revisão a todos os contextos não
 * arquivados do projeto, na mesma transação.
 *
 * Como um consumidor distingue as variantes e a conta primária via cadeia (`roles.specialist` + `ac_profiles`):
 * - **Conta primária (Max vs outras contas):** em `roles.specialist.regular`, todos os perfis Claude
 *   da conta primária (`--conta-prioritaria <UUID>`) precedem os perfis de qualquer outra conta Claude.
 *   O consumidor obtém o `account_id` primário pelo perfil `claude-opus-5-5` com `effort === 'high'`
 *   em `regular` (ou pelo primeiro perfil Claude em `regular`).
 * - **Duas variantes de Opus 5.5 (`claude-opus-5-5`):**
 *   - `effort === 'high'` em `regular` (conta primária): exclusivo para criação, exame e crítica visual do módulo 10 (design).
 *   - `effort === 'medium'` em `emergency` (conta primária, perfil distinto): exclusivo para segunda opinião de achados altos em módulos funcionais.
 * - **Duas variantes de Sonnet 5.5 (`claude-sonnet-5-5`):**
 *   - `effort === 'high'` em `regular` (conta primária primeiro, depois outra conta disponível): exames passivos de esforço alto (módulos 1, 5 e 9).
 *   - `effort === 'medium'` em `regular` (conta primária primeiro, depois outra conta disponível): exames passivos de esforço médio (módulos 2, 3, 4, 6, 7 e 8).
 * - **Revisor em conta/sessão distinta (`revisor`):** em `emergency` na conta secundária (ou em perfil/sessão distinta na conta primária quando só há uma conta Claude).
 */
export async function prepareDesignSpecialist(input: {
  ledger: Ledger;
  owner: string;
  projectId: string;
  apply: boolean;
  primaryAccountId?: string;
}): Promise<DesignPrepareReport> {
  if (input.primaryAccountId !== undefined && !Id.safeParse(input.primaryAccountId).success) {
    throw new Refusal('DESIGN_USAGE', 400);
  }
  return input.ledger.tx(async client => {
    const facts = await loadFacts(client, input.owner, input.projectId, input.apply);
    const catalog = planCatalog(facts);
    const plan = seatPlan(facts, input.primaryAccountId);
    const contexts = (plan.reusePolicy
      ? facts.contexts.filter(item => item.capacityPolicyRevision !== facts.revision)
      : facts.contexts
    ).map(item => item.id);
    const unchanged = plan.reusePolicy && catalog.action === 'presente' && contexts.length === 0
      && plan.items.every(item => item.profile.action === 'reusar');
    if (input.apply && catalog.action === 'bloqueado') {
      // O registro é global e compartilhado com outros papéis: acrescentar o esforço
      // ampliaria esses papéis sem decisão explícita. Nada é gravado.
      throw new Refusal('DESIGN_CATALOG_SHARED_EFFORT', 409);
    }
    if (!input.apply || unchanged) {
      return {
        apply: input.apply,
        unchanged,
        catalogAction: catalog.action,
        catalog: catalog.steps,
        primaryAccountId: plan.primaryAccountId,
        profiles: plan.items.map(item => item.profile),
        chain: plan.chain,
        contexts,
        revisionFrom: facts.revision,
        revisionTo: unchanged || plan.reusePolicy ? facts.revision : null,
      };
    }

    const capacity = new Capacity(input.ledger, client);
    await applyCatalog(capacity, client, input.owner, catalog.steps);

    const existingRegular = facts.previous?.roles.specialist?.regular ?? [];
    const existingEmergency = facts.previous?.roles.specialist?.emergency ?? [];
    const lockedIds = new Set([...existingRegular, ...existingEmergency]);
    const assignedIds = new Set<string>();
    const ensured: {item: PlannedItem; id: string; action: DesignPrepareProfile['action']}[] = [];

    for (const item of plan.items) {
      const avoid = [...new Set([...lockedIds, ...assignedIds])].filter(id => id !== item.profile.profileId);
      const {id, action} = await ensureProfile(capacity, client, input.owner, input.projectId, item.profile, avoid);
      assignedIds.add(id);
      ensured.push({item, id, action: item.profile.action === 'mover' && action === 'reusar' ? 'mover' : action});
    }
    if (assignedIds.size !== plan.items.length) {
      throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
    }

    const profileMap = new Map(facts.profiles.map(row => [row.id, row]));
    const chain = buildChain({
      existingRegular,
      existingEmergency,
      migratedOpusMediumId: plan.migratedOpusMediumId,
      primaryAccountId: plan.primaryAccountId,
      profileMap,
      resolved: ensured.map(({item, id}) => ({
        purpose: item.profile.purpose,
        inTargetChain: item.inTargetChain,
        targetChain: item.targetChain,
        accountRole: item.accountRole,
        id,
      })),
    });

    const policy = CapacityPolicy.parse({
      ...(facts.previous ?? {schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2, roles: {}}),
      roles: {...(facts.previous?.roles ?? {}), specialist: chain},
    });
    let revision = facts.revision;
    if (!sameChain(facts.previous?.roles.specialist, chain)) {
      revision = await capacity.publish(input.owner, input.projectId, facts.revision, policy);
    }
    for (const contextId of contexts) await capacity.assignPolicy(input.owner, contextId, revision);
    return {
      apply: true,
      unchanged: false,
      catalogAction: catalog.action,
      catalog: catalog.steps,
      primaryAccountId: plan.primaryAccountId,
      profiles: ensured.map(({item, id, action}) => ({...item.profile, profileId: id, action})),
      chain,
      contexts,
      revisionFrom: facts.revision,
      revisionTo: revision,
    };
  });
}

export function formatDesignPrepare(
  report: Omit<DesignPrepareReport, 'primaryAccountId'> & {primaryAccountId?: string},
): string {
  if (report.unchanged) return 'Nada a mudar.';
  const lines = [
    report.apply ? 'Preparação aplicada.' : 'Preparação, sem gravar.',
    'Catálogo:',
    ...report.catalog.map(item => `- ${catalogLine(item, report.apply)}`),
    ...catalogBlockedLines(report.catalog),
    ...(report.primaryAccountId ? [`Conta prioritária: ${report.primaryAccountId}`] : []),
    'Perfis specialist:',
  ];
  for (const profile of report.profiles) {
    const id = profile.profileId ?? 'novo';
    lines.push(`- ${profile.purpose}: ${profile.model} ${profile.effort} conta ${profile.accountId} perfil ${id} (${profile.action}, ${profile.seat})`);
  }
  lines.push('Cadeia specialist:');
  lines.push(`- regular: ${report.chain.regular.join(', ') || 'vazia'}`);
  lines.push(`- emergência: ${report.chain.emergency.join(', ') || 'vazia'}`);
  lines.push(`Contextos a atualizar: ${report.contexts.join(', ') || 'nenhum'}`);
  if (report.revisionTo !== null && report.revisionTo !== report.revisionFrom) {
    lines.push(`Revisão: ${report.revisionFrom} -> ${report.revisionTo}`);
  } else if (!report.apply && !report.unchanged) {
    lines.push(`Revisão atual: ${report.revisionFrom}`);
  }
  return lines.join('\n');
}

function catalogLine(item: DesignCatalogModel, apply: boolean): string {
  const missing = item.missing.join(', ');
  switch (item.action) {
    case 'presente':
      return `${item.model}: já tem ${item.efforts.join(', ')}; nada muda.`;
    case 'registrar':
      return `${item.model}: ${apply ? 'entrou' : 'entraria'} por ${CATALOG_SOURCE} com ${missing} para specialist.`;
    case 'atualizar':
      return `${item.model}: ${apply ? 'recebeu' : 'receberia'} ${missing} (registro só de specialist).`;
    case 'bloqueado':
      return `${item.model}: bloqueado; falta ${missing} e o registro também serve ${item.sharedRoles.join(', ')}.`;
  }
}

function catalogBlockedLines(catalog: readonly DesignCatalogModel[]): string[] {
  const blocked = catalog.filter(item => item.action === 'bloqueado');
  if (blocked.length === 0) return [];
  return [
    'Restrição: o catálogo é global e compartilhado; acrescentar o esforço liberaria esse esforço também para os outros papéis. --aplicar não grava nada.',
    'Para seguir, um administrador de controle decide e acrescenta, ciente de que os papéis listados também passam a usar:',
    ...blocked.map(item => `- ${item.model}: ${item.missing.join(', ')} (papéis afetados: ${item.sharedRoles.join(', ')})`),
    'Depois, repita a prévia.',
  ];
}

async function loadFacts(client: pg.PoolClient, owner: string, projectId: string, apply: boolean): Promise<PrepareFacts> {
  const mode = (await client.query<{mode: string}>('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0]?.mode;
  if (mode !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const member = await client.query(
    "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",
    [projectId, owner],
  );
  if (!member.rowCount) throw new Refusal('PROJECT_OWNER_REQUIRED', 403);
  if (apply) await client.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE', [projectId]);
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
  const contexts = (await client.query<{id: string; capacity_policy_revision: number | null}>(
    `SELECT id::text AS id, capacity_policy_revision FROM ac_contexts
     WHERE project_id=$1 AND NOT archived
     ORDER BY id`,
    [projectId],
  )).rows.map(row => ({
    id: row.id,
    capacityPolicyRevision: row.capacity_policy_revision === null ? null : Number(row.capacity_policy_revision),
  }));
  const catalog = (await client.query<CatalogRow>(
    "SELECT model, efforts, roles FROM ac_model_catalog WHERE provider='claude' ORDER BY model",
  )).rows;
  const opus = catalog.find(row => row.model === CREATE_MODEL) ?? null;
  const sonnet = catalog.find(row => row.model === EXAMINER_MODEL) ?? null;
  return {
    accounts,
    profiles,
    catalog,
    previous: stored ? CapacityPolicy.parse(stored.snapshot) : null,
    revision: stored ? Number(stored.revision) : 0,
    contexts,
    opus,
    sonnet,
  };
}

function planCatalog(facts: PrepareFacts): {
  action: DesignCatalogAction;
  steps: DesignCatalogModel[];
} {
  const steps = [planCatalogModel(CREATE_MODEL, facts.opus), planCatalogModel(EXAMINER_MODEL, facts.sonnet)];
  const action = (['bloqueado', 'registrar', 'atualizar'] as const).find(candidate => steps.some(step => step.action === candidate))
    ?? 'presente';
  return {action, steps};
}

/**
 * Um registro só de specialist pode ganhar os esforços que faltam. Um registro
 * compartilhado com outros papéis só serve se já tiver todos: acrescentar ali
 * ampliaria os outros papéis, então fica `bloqueado` e nada é gravado.
 */
function planCatalogModel(model: string, row: CatalogRow | null): DesignCatalogModel {
  const required = REQUIRED_EFFORTS[model]!;
  if (!row) {
    return {model, action: 'registrar', efforts: [...CATALOG_EFFORTS], missing: [...CATALOG_EFFORTS], sharedRoles: []};
  }
  if (!row.roles.includes('specialist')) throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
  const missing = required.filter(effort => !row.efforts.includes(effort));
  if (missing.length === 0) return {model, action: 'presente', efforts: [...row.efforts], missing: [], sharedRoles: []};
  const sharedRoles = row.roles.filter(role => role !== 'specialist');
  if (sharedRoles.length > 0) {
    return {model, action: 'bloqueado', efforts: [...row.efforts], missing, sharedRoles};
  }
  return {model, action: 'atualizar', efforts: [...row.efforts, ...missing], missing, sharedRoles: []};
}

async function applyCatalog(
  capacity: Capacity,
  client: pg.PoolClient,
  owner: string,
  steps: readonly DesignCatalogModel[],
): Promise<void> {
  for (const step of steps) {
    if (step.action === 'registrar') {
      try {
        await capacity.registerModel(owner, {
          provider: 'claude',
          model: step.model,
          efforts: [...step.efforts],
          roles: [...CATALOG_ROLES],
          source: CATALOG_SOURCE,
        });
      } catch (error) {
        if (error instanceof Refusal && (error.code === 'CATALOG_ENTRY_CONFLICT' || error.code === 'ModelDisabledByPolicy')) {
          throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE', 409);
        }
        throw error;
      }
      continue;
    }
    if (step.action === 'atualizar') {
      const admin = await client.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1', [owner]);
      if (!admin.rowCount) throw new Refusal('CONTROL_ADMIN_REQUIRED', 403);
      // Só grava se o registro continuar exclusivo de specialist.
      const updated = await client.query(
        "UPDATE ac_model_catalog SET efforts=$2 WHERE provider='claude' AND model=$1 AND roles <@ ARRAY['specialist']::text[]",
        [step.model, step.efforts],
      );
      if (updated.rowCount !== 1) throw new Refusal('DESIGN_CATALOG_SHARED_EFFORT', 409);
    }
  }
}

function selectPrimaryAccount(
  facts: PrepareFacts,
  chainRegularRows: readonly ProfileRow[],
  requestedPrimaryAccountId?: string,
): {id: string} {
  if (requestedPrimaryAccountId !== undefined) {
    const chosen = facts.accounts.find(account => account.id === requestedPrimaryAccountId);
    if (!chosen) throw new Refusal('DESIGN_PREPARE_ACCOUNT_UNAVAILABLE', 409);
    return chosen;
  }
  const enabledIds = new Set(facts.accounts.map(account => account.id));
  const fromOpusHigh = chainRegularRows.find(
    row => row.model === CREATE_MODEL && row.effort === CREATE_EFFORT && enabledIds.has(row.accountId),
  );
  if (fromOpusHigh) {
    return facts.accounts.find(account => account.id === fromOpusHigh.accountId)!;
  }
  // Política antiga: o Opus medium em `regular` era o criador e marca a primária anterior.
  const fromLegacyOpusMedium = chainRegularRows.find(
    row => row.model === CREATE_MODEL && row.effort === FUNCTIONAL_HIGH_REVIEW_EFFORT && enabledIds.has(row.accountId),
  );
  if (fromLegacyOpusMedium) {
    return facts.accounts.find(account => account.id === fromLegacyOpusMedium.accountId)!;
  }
  const fromFirstClaude = chainRegularRows.find(row => enabledIds.has(row.accountId));
  if (fromFirstClaude) {
    return facts.accounts.find(account => account.id === fromFirstClaude.accountId)!;
  }
  return facts.accounts[0]!;
}

function seatPlan(facts: PrepareFacts, requestedPrimaryAccountId?: string): SeatPlan {
  const existing = facts.previous?.roles.specialist;
  const existingRegular = existing?.regular ?? [];
  const existingEmergency = existing?.emergency ?? [];
  const byId = new Map(facts.profiles.map(row => [row.id, row]));
  const chainRegularRows = existingRegular.map(id => byId.get(id)).filter((row): row is ProfileRow => row !== undefined);
  const chainEmergencyRows = existingEmergency.map(id => byId.get(id)).filter((row): row is ProfileRow => row !== undefined);

  const primary = selectPrimaryAccount(facts, chainRegularRows, requestedPrimaryAccountId);
  const otherAccounts = facts.accounts.filter(account => account.id !== primary.id);
  const secondary = otherAccounts[0] ?? primary;

  const used = new Set<string>([...existingRegular, ...existingEmergency]);
  const matchedRegular = new Set<string>();
  const matchedEmergency = new Set<string>();

  const chainCriar = chainRegularRows.find(
    row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === CREATE_EFFORT,
  );
  if (chainCriar) matchedRegular.add(chainCriar.id);

  const chainExaminerHigh = chainRegularRows.find(
    row => row.accountId === primary.id && row.model === EXAMINER_MODEL && row.effort === 'high' && !matchedRegular.has(row.id),
  );
  if (chainExaminerHigh) matchedRegular.add(chainExaminerHigh.id);

  const chainExaminerMedium = chainRegularRows.find(
    row => row.accountId === primary.id && row.model === EXAMINER_MODEL && row.effort === 'medium' && !matchedRegular.has(row.id),
  );
  if (chainExaminerMedium) matchedRegular.add(chainExaminerMedium.id);

  let chainReviewerOpus = chainEmergencyRows.find(
    row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === FUNCTIONAL_HIGH_REVIEW_EFFORT,
  );
  let migratedOpusMediumId: string | null = null;
  if (chainReviewerOpus) {
    matchedEmergency.add(chainReviewerOpus.id);
  } else {
    const legacyRegularOpusMedium = chainRegularRows.find(
      row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === FUNCTIONAL_HIGH_REVIEW_EFFORT && !matchedRegular.has(row.id),
    );
    if (legacyRegularOpusMedium) {
      chainReviewerOpus = legacyRegularOpusMedium;
      migratedOpusMediumId = legacyRegularOpusMedium.id;
    }
  }

  const chainReviewer =
    chainEmergencyRows.find(
      row => row.accountId === secondary.id && row.model !== CREATE_MODEL && row.effort === REVIEWER_EFFORT && !matchedEmergency.has(row.id),
    )
    ?? chainEmergencyRows.find(
      row => row.accountId === secondary.id && row.model !== CREATE_MODEL && !matchedEmergency.has(row.id),
    );
  if (chainReviewer) matchedEmergency.add(chainReviewer.id);

  const primaryMissingCount = [chainCriar, chainExaminerHigh, chainExaminerMedium].filter(item => item === undefined).length;
  const baseRegularCount = existingRegular.filter(id => id !== migratedOpusMediumId).length + primaryMissingCount;

  const secondaryChains: {
    accountId: string;
    highChain: ProfileRow | undefined;
    mediumChain: ProfileRow | undefined;
  }[] = [];
  let projectedRegularCount = baseRegularCount;
  for (const other of otherAccounts) {
    const highChain = chainRegularRows.find(
      row => row.accountId === other.id && row.model === EXAMINER_MODEL && row.effort === 'high' && !matchedRegular.has(row.id),
    );
    const mediumChain = chainRegularRows.find(
      row => row.accountId === other.id && row.model === EXAMINER_MODEL && row.effort === 'medium' && !matchedRegular.has(row.id),
    );
    const needed = (highChain ? 0 : 1) + (mediumChain ? 0 : 1);
    if (projectedRegularCount + needed > MAX_CHAIN_PROFILES) break;
    if (highChain) matchedRegular.add(highChain.id);
    if (mediumChain) matchedRegular.add(mediumChain.id);
    projectedRegularCount += needed;
    secondaryChains.push({accountId: other.id, highChain, mediumChain});
  }

  const criarRow = chainCriar ?? take(
    facts.profiles,
    row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === CREATE_EFFORT,
    used,
  );
  const examinerHighRow = chainExaminerHigh ?? take(
    facts.profiles,
    row => row.accountId === primary.id && row.model === EXAMINER_MODEL && row.effort === 'high',
    used,
  );
  const examinerMediumRow = chainExaminerMedium ?? take(
    facts.profiles,
    row => row.accountId === primary.id && row.model === EXAMINER_MODEL && row.effort === 'medium',
    used,
  );

  const secondaryPlanned = secondaryChains.map(entry => {
    const highRow = entry.highChain ?? take(
      facts.profiles,
      row => row.accountId === entry.accountId && row.model === EXAMINER_MODEL && row.effort === 'high',
      used,
    );
    const mediumRow = entry.mediumChain ?? take(
      facts.profiles,
      row => row.accountId === entry.accountId && row.model === EXAMINER_MODEL && row.effort === 'medium',
      used,
    );
    return {
      accountId: entry.accountId,
      highInChain: entry.highChain !== undefined,
      mediumInChain: entry.mediumChain !== undefined,
      medium: entry.mediumChain
        ? profileReport('examinador-secundario-medium', entry.mediumChain, 'outra conta')
        : planned('examinador-secundario-medium', entry.accountId, EXAMINER_MODEL, 'medium', mediumRow, 'outra conta'),
      high: entry.highChain
        ? profileReport('examinador-secundario-high', entry.highChain, 'outra conta')
        : planned('examinador-secundario-high', entry.accountId, EXAMINER_MODEL, 'high', highRow, 'outra conta'),
    };
  });

  const reviewerOpusRow = chainReviewerOpus ?? take(
    facts.profiles,
    row => row.accountId === primary.id && row.model === CREATE_MODEL && row.effort === FUNCTIONAL_HIGH_REVIEW_EFFORT,
    used,
  );
  const reviewerRow = chainReviewer ?? take(
    facts.profiles,
    row => row.accountId === secondary.id && row.model === EXAMINER_MODEL && row.effort === REVIEWER_EFFORT,
    used,
  );

  const items: PlannedItem[] = [
    {
      profile: chainCriar
        ? profileReport('criar', chainCriar, 'conta')
        : planned('criar', primary.id, CREATE_MODEL, CREATE_EFFORT, criarRow, 'conta'),
      inTargetChain: chainCriar !== undefined,
      targetChain: 'regular',
      accountRole: 'primary',
    },
    {
      profile: chainExaminerMedium
        ? profileReport('examinador', chainExaminerMedium, 'conta')
        : planned('examinador', primary.id, EXAMINER_MODEL, EXAMINER_EFFORTS[0], examinerMediumRow, 'conta'),
      inTargetChain: chainExaminerMedium !== undefined,
      targetChain: 'regular',
      accountRole: 'primary',
    },
    {
      profile: chainExaminerHigh
        ? profileReport('examinador-high', chainExaminerHigh, 'conta')
        : planned('examinador-high', primary.id, EXAMINER_MODEL, EXAMINER_EFFORTS[1], examinerHighRow, 'conta'),
      inTargetChain: chainExaminerHigh !== undefined,
      targetChain: 'regular',
      accountRole: 'primary',
    },
    ...secondaryPlanned.flatMap<PlannedItem>(entry => [
      {
        profile: entry.medium,
        inTargetChain: entry.mediumInChain,
        targetChain: 'regular',
        accountRole: 'secondary',
      },
      {
        profile: entry.high,
        inTargetChain: entry.highInChain,
        targetChain: 'regular',
        accountRole: 'secondary',
      },
    ]),
    {
      profile: chainReviewer
        ? profileReport('revisor', chainReviewer, chainReviewer.accountId === primary.id ? 'outra sessão' : 'outra conta')
        : planned(
            'revisor',
            secondary.id,
            EXAMINER_MODEL,
            REVIEWER_EFFORT,
            reviewerRow,
            secondary.id === primary.id ? 'outra sessão' : 'outra conta',
          ),
      inTargetChain: chainReviewer !== undefined,
      targetChain: 'emergency',
      accountRole: 'secondary',
    },
    {
      profile: chainReviewerOpus
        ? {
            ...profileReport('revisor-alto', chainReviewerOpus, 'outra sessão'),
            ...(migratedOpusMediumId !== null && chainReviewerOpus.enabled ? {action: 'mover' as const} : {}),
          }
        : planned('revisor-alto', primary.id, CREATE_MODEL, FUNCTIONAL_HIGH_REVIEW_EFFORT, reviewerOpusRow, 'outra sessão'),
      inTargetChain: chainReviewerOpus !== undefined && migratedOpusMediumId === null,
      targetChain: 'emergency',
      accountRole: 'primary',
    },
  ];

  const chain = buildChain({
    existingRegular,
    existingEmergency,
    migratedOpusMediumId,
    primaryAccountId: primary.id,
    profileMap: byId,
    resolved: items.map(item => ({
      purpose: item.profile.purpose,
      inTargetChain: item.inTargetChain,
      targetChain: item.targetChain,
      accountRole: item.accountRole,
      id: item.profile.profileId ?? `novo:${item.profile.purpose}:${item.profile.accountId}`,
    })),
  });

  return {
    primaryAccountId: primary.id,
    items,
    migratedOpusMediumId,
    chain,
    reusePolicy: existing !== undefined && sameChain(existing, chain),
  };
}

function buildChain(input: {
  existingRegular: readonly string[];
  existingEmergency: readonly string[];
  migratedOpusMediumId: string | null;
  primaryAccountId: string;
  profileMap: ReadonlyMap<string, ProfileRow>;
  resolved: readonly {
    purpose: DesignPreparePurpose;
    inTargetChain: boolean;
    targetChain: 'regular' | 'emergency';
    accountRole: 'primary' | 'secondary';
    id: string;
  }[];
}): {regular: string[]; emergency: string[]} {
  const regularPool = input.existingRegular.filter(id => id !== input.migratedOpusMediumId);
  const existingPrimaryRegular = regularPool.filter(id => input.profileMap.get(id)?.accountId === input.primaryAccountId);
  const existingOtherRegular = regularPool.filter(id => {
    const row = input.profileMap.get(id);
    return row !== undefined && row.accountId !== input.primaryAccountId;
  });

  const addedPrimaryCreate: string[] = [];
  const addedPrimaryOther: string[] = [];
  const addedSecondaryRegular: string[] = [];
  const addedEmergency: string[] = [];

  for (const item of input.resolved) {
    if (item.inTargetChain) continue;
    if (item.targetChain === 'emergency') {
      addedEmergency.push(item.id);
      continue;
    }
    if (item.accountRole === 'primary') {
      if (item.purpose === 'criar') addedPrimaryCreate.push(item.id);
      else addedPrimaryOther.push(item.id);
    } else {
      addedSecondaryRegular.push(item.id);
    }
  }

  const hasExistingOpusInPrimary = existingPrimaryRegular.some(
    id => input.profileMap.get(id)?.model === CREATE_MODEL,
  );
  const primaryRegular = hasExistingOpusInPrimary
    ? [...addedPrimaryCreate, ...existingPrimaryRegular, ...addedPrimaryOther]
    : [...existingPrimaryRegular, ...addedPrimaryCreate, ...addedPrimaryOther];
  const otherRegular = [...existingOtherRegular, ...addedSecondaryRegular];

  return {
    regular: fillClaudeSlots(input.existingRegular, input.profileMap, [...primaryRegular, ...otherRegular]),
    emergency: [...input.existingEmergency, ...addedEmergency],
  };
}

/**
 * Põe os perfis Claude, já na ordem nova, nos lugares que eram de perfis Claude
 * (incluindo o do Opus medium que saiu para `emergency`). Os outros provedores
 * conservam sua precedência. Novos perfis que excedem os lugares disponíveis entram no fim.
 */
function fillClaudeSlots(
  existing: readonly string[],
  profileMap: ReadonlyMap<string, ProfileRow>,
  claudeOrdered: readonly string[],
): string[] {
  const result: string[] = [];
  let next = 0;
  for (const id of existing) {
    if (!profileMap.has(id)) {
      result.push(id);
    } else if (next < claudeOrdered.length) {
      result.push(claudeOrdered[next]!);
      next += 1;
    }
  }
  result.push(...claudeOrdered.slice(next));
  return result;
}

function profileReport(
  purpose: DesignPreparePurpose,
  row: ProfileRow,
  seat: DesignPrepareProfile['seat'],
): DesignPrepareProfile {
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
  purpose: DesignPreparePurpose,
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
): Promise<{id: string; action: 'reusar' | 'criar' | 'habilitar'}> {
  if (profile.profileId && profile.action !== 'criar' && !avoid.includes(profile.profileId)) {
    if (profile.action === 'habilitar') {
      const revision = Number((await client.query('SELECT revision FROM ac_profiles WHERE id=$1', [profile.profileId])).rows[0]?.revision);
      await capacity.setEnabled(owner, projectId, 'profile', {id: profile.profileId, enabled: true, expectedRevision: revision});
      return {id: profile.profileId, action: 'habilitar'};
    }
    return {id: profile.profileId, action: 'reusar'};
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
      return {id: existing.id, action: 'habilitar'};
    }
    return {id: existing.id, action: 'reusar'};
  }
  const id = randomUUID();
  await capacity.addProfile(owner, projectId, {
    id,
    accountId: profile.accountId,
    model: profile.model,
    effort: profile.effort as Effort,
    role: 'specialist',
  });
  return {id, action: 'criar'};
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
