import {workflowDefSchema, type WorkflowDef} from '../upstream/cezar/packages/cezar/dist/workflows/types.js';
export type {WorkflowDef};
import type {PoolClient} from 'pg';
import {digest, Refusal} from './contracts.ts';
import {baselineWorkflow, engineeringNativeWorkflow, engineeringWorkflow, semanticProposalWorkflow} from './workflows.ts';

/** This engine does not auto-upgrade a frozen execution onto a newer workflow definition. */
export const WORKFLOW_VERSION_POLICIES = ['pinned'] as const;
export type WorkflowVersionPolicy = typeof WORKFLOW_VERSION_POLICIES[number];
export const WORKFLOW_VERSION_RETIRED = 'WORKFLOW_VERSION_RETIRED';
/** Same identity string already reported by the Cezar app boot. */
export const AGENT_CONTROL_RUNTIME_VERSION = 'agent-control-0.1.0';
/** Build identity recorded with each new pin. It is not a deploy attestation. */
export const AGENT_CONTROL_RUNTIME_BUILD = 'cezar-pinned-058';

export type WorkflowVersionStatus = 'current' | 'retained';
export type WorkflowVersionEntry = {
  readonly name: string;
  readonly version: string;
  readonly status: WorkflowVersionStatus;
  readonly policy: WorkflowVersionPolicy;
  readonly definition: WorkflowDef;
  readonly digest: string;
};
export type WorkflowVersionPin = {
  workflowVersion: string;
  workflowDigest: string;
  managerEpoch: number;
  runtimeVersion: string;
  runtimeBuild: string;
  policy: string;
};
export type FrozenWorkflowResolution =
  | {ok: true; kind: 'catalog' | 'dynamic'; definition: WorkflowDef; version: string; digest: string; policy: 'pinned'; legacy: boolean}
  | {ok: false; cause: typeof WORKFLOW_VERSION_RETIRED; reason: 'unregistered' | 'divergent'};

const RETAINED_DESCRIPTION = 'retained-v0';
const DYNAMIC_NAME = /^(?:managed-synthetic-[0-9a-f-]{36}|engineering-native-plan-[0-9a-f-]{36}|\(planned\)|\(fork branch\))$/;

function retain(definition: WorkflowDef): WorkflowDef {
  return workflowDefSchema.parse({...definition, description: RETAINED_DESCRIPTION});
}
function entry(definition: WorkflowDef, version: string, status: WorkflowVersionStatus): WorkflowVersionEntry {
  const parsed = status === 'retained' ? retain(definition) : definition;
  return Object.freeze({name: parsed.name, version, status, policy: 'pinned', definition: parsed, digest: digest(parsed)});
}

/** Immutable in-code catalog. Retained entries are historical snapshots, not selectable for a new execution. */
export const workflowVersionRegistry: readonly WorkflowVersionEntry[] = Object.freeze([
  entry(baselineWorkflow, 'v1', 'current'), entry(baselineWorkflow, 'v0', 'retained'),
  entry(engineeringWorkflow, 'v1', 'current'), entry(engineeringWorkflow, 'v0', 'retained'),
  entry(engineeringNativeWorkflow, 'v1', 'current'), entry(engineeringNativeWorkflow, 'v0', 'retained'),
  entry(semanticProposalWorkflow, 'v1', 'current'), entry(semanticProposalWorkflow, 'v0', 'retained'),
]);

const byName = new Map<string, WorkflowVersionEntry[]>();
for (const item of workflowVersionRegistry) {
  const list = byName.get(item.name) ?? [];
  list.push(item);
  byName.set(item.name, list);
}
for (const [name, items] of byName) {
  if (items.filter(item => item.status === 'current').length !== 1) throw new Error(`WORKFLOW_VERSION_REGISTRY_INVALID:${name}`);
  if (items.some(item => item.policy !== 'pinned')) throw new Error(`WORKFLOW_VERSION_REGISTRY_INVALID:${name}`);
  if (new Set(items.map(item => item.digest)).size !== items.length) throw new Error(`WORKFLOW_VERSION_REGISTRY_INVALID:${name}`);
  if (new Set(items.map(item => item.version)).size !== items.length) throw new Error(`WORKFLOW_VERSION_REGISTRY_INVALID:${name}`);
}

export function currentWorkflow(name: string): WorkflowVersionEntry | undefined {
  return byName.get(name)?.find(item => item.status === 'current');
}
export function retainedWorkflows(name: string): readonly WorkflowVersionEntry[] {
  return Object.freeze([...(byName.get(name)?.filter(item => item.status === 'retained') ?? [])]);
}
/** A new execution may name only the current version. A retained version is refused and is never substituted. */
export function workflowForAdmission(name: string, version: string): WorkflowDef {
  const current = currentWorkflow(name);
  if (!current) throw new Refusal('WORKFLOW_NOT_ADMITTED');
  if (version !== current.version) throw new Refusal('WORKFLOW_VERSION_NOT_CURRENT');
  return current.definition;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Resolve the definition an in-flight execution must keep.
 * A missing pin is legacy: the frozen digest selects the catalog entry. It is not an upgrade and it is not retirement.
 * An unknown digest, a digest that disagrees with the snapshot, or a pin that disagrees is closed as WORKFLOW_VERSION_RETIRED.
 */
export function resolveFrozenWorkflow(input: {
  commandWorkflow: string;
  snapshot: unknown;
  storedDigest: string;
  pin: WorkflowVersionPin | null;
  intentEpoch: number;
}): FrozenWorkflowResolution {
  const fail = (reason: 'unregistered' | 'divergent'): FrozenWorkflowResolution => ({ok: false, cause: WORKFLOW_VERSION_RETIRED, reason});
  const record = asRecord(input.snapshot);
  const snapshotName = typeof record?.name === 'string' ? record.name : '';
  let snapshotDigest: string;
  try { snapshotDigest = digest(input.snapshot); } catch { return fail('divergent'); }
  if (!/^[a-f0-9]{64}$/.test(input.storedDigest) || snapshotDigest !== input.storedDigest) return fail('divergent');
  const parsed = workflowDefSchema.safeParse(input.snapshot);
  if (!parsed.success || digest(parsed.data) !== snapshotDigest || parsed.data.name !== snapshotName) return fail('divergent');
  const catalog = byName.get(snapshotName);
  const pin = input.pin;
  const pinAgrees = (version: string) => !pin || (
    pin.policy === 'pinned' && pin.workflowDigest === snapshotDigest && pin.workflowVersion === version && pin.managerEpoch === input.intentEpoch &&
    pin.runtimeVersion.length > 0 && pin.runtimeVersion.length <= 80 && pin.runtimeBuild.length > 0 && pin.runtimeBuild.length <= 80);
  if (catalog) {
    if (input.commandWorkflow !== snapshotName) return fail('divergent');
    const match = catalog.find(item => item.digest === snapshotDigest);
    if (!match || !pinAgrees(match.version)) return fail(match ? 'divergent' : 'unregistered');
    return {ok: true, kind: 'catalog', definition: parsed.data, version: match.version, digest: snapshotDigest, policy: 'pinned', legacy: !pin};
  }
  if (!DYNAMIC_NAME.test(snapshotName) || input.commandWorkflow !== 'managed-synthetic-v1') return fail('divergent');
  if (!pinAgrees('snapshot')) return fail('divergent');
  return {ok: true, kind: 'dynamic', definition: parsed.data, version: 'snapshot', digest: snapshotDigest, policy: 'pinned', legacy: !pin};
}

export type WorkflowVersionUse = {
  intentId: string;
  epoch: number;
  workflowName: string;
  workflowVersion: string;
  digest: string;
  policy: 'pinned';
  persistence: 'recorded' | 'derived';
  runtimeVersion: string | null;
  runtimeBuild: string | null;
};
export type WorkflowVersionBlock = {
  intentId: string;
  cause: typeof WORKFLOW_VERSION_RETIRED;
  reason: 'unregistered' | 'divergent';
  workflowName: string;
  digest: string | null;
};
export type WorkflowVersionSnapshot = {
  schemaVersion: 1;
  readOnly: true;
  runtimeVersion: typeof AGENT_CONTROL_RUNTIME_VERSION;
  runtimeBuild: typeof AGENT_CONTROL_RUNTIME_BUILD;
  policy: 'pinned';
  registry: readonly {name: string; version: string; status: WorkflowVersionStatus; policy: 'pinned'; digest: string}[];
  inUse: WorkflowVersionUse[];
  blocked: WorkflowVersionBlock[];
  truncated: boolean;
};

function safeName(value: string): string {
  return /^[A-Za-z0-9._():-]{1,120}$/.test(value) ? value : 'redacted';
}

/** Read-only projection. Callers must already have authorized the context. No workflow body, prompt or message is returned. */
export async function readWorkflowVersionSnapshot(c: PoolClient, contextId: string): Promise<WorkflowVersionSnapshot> {
  const rows = (await c.query(`SELECT i.id, i.manager_epoch, i.command->'payload'->>'workflow' AS command_workflow, f.digest, f.snapshot,
    p.workflow_version, p.workflow_digest, p.manager_epoch AS pin_epoch, p.runtime_version, p.runtime_build, p.policy
    FROM ac_intents i JOIN ac_frozen_plans f ON f.intent_id=i.id
    LEFT JOIN ac_workflow_version_pins p ON p.intent_id=i.id
    WHERE i.context_id=$1 AND i.parent_intent_id IS NULL
      AND i.state NOT IN ('completed','done','review','failed','canceled','cancelled')
    ORDER BY i.created_at, i.id LIMIT 101`, [contextId])).rows as Record<string, unknown>[];
  const inUse: WorkflowVersionUse[] = [];
  const blocked: WorkflowVersionBlock[] = [];
  for (const row of rows.slice(0, 100)) {
    const commandWorkflow = typeof row.command_workflow === 'string' ? row.command_workflow : '';
    const storedDigest = typeof row.digest === 'string' ? row.digest : '';
    const pin = typeof row.workflow_version === 'string' ? {
      workflowVersion: row.workflow_version,
      workflowDigest: String(row.workflow_digest ?? ''),
      managerEpoch: Number(row.pin_epoch),
      runtimeVersion: String(row.runtime_version ?? ''),
      runtimeBuild: String(row.runtime_build ?? ''),
      policy: String(row.policy ?? ''),
    } : null;
    const decision = resolveFrozenWorkflow({commandWorkflow, snapshot: row.snapshot, storedDigest, pin, intentEpoch: Number(row.manager_epoch)});
    const snapshotName = asRecord(row.snapshot)?.name;
    const workflowName = safeName(typeof snapshotName === 'string' && snapshotName ? snapshotName : commandWorkflow || 'unknown');
    if (!decision.ok) {
      blocked.push({intentId: String(row.id), cause: WORKFLOW_VERSION_RETIRED, reason: decision.reason, workflowName, digest: /^[a-f0-9]{64}$/.test(storedDigest) ? storedDigest : null});
      continue;
    }
    inUse.push({
      intentId: String(row.id), epoch: Number(row.manager_epoch), workflowName, workflowVersion: decision.version, digest: decision.digest, policy: 'pinned',
      persistence: decision.legacy ? 'derived' : 'recorded',
      runtimeVersion: decision.legacy ? null : String(row.runtime_version),
      runtimeBuild: decision.legacy ? null : String(row.runtime_build),
    });
  }
  return {
    schemaVersion: 1, readOnly: true, runtimeVersion: AGENT_CONTROL_RUNTIME_VERSION, runtimeBuild: AGENT_CONTROL_RUNTIME_BUILD, policy: 'pinned',
    registry: workflowVersionRegistry.map(item => ({name: item.name, version: item.version, status: item.status, policy: item.policy, digest: item.digest})),
    inUse, blocked, truncated: rows.length > 100,
  };
}
