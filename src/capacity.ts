import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { Authority, digest, Id, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';

export const Role = z.enum(['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge']);
export type Role = z.infer<typeof Role>;
export const AccountInput = z.object({ id: Id, provider: z.string().min(1).max(80), label: z.string().min(1).max(100),
  resourceIdentity: z.string().min(1).max(200), mode: z.literal('synthetic'),
  eligibility: z.enum(['documented_supported','requires_clarification','unsupported_for_mode','not_assessed']),
  eligibilitySource: z.string().min(1).max(500), maxConcurrent: z.number().int().min(1).max(128) }).strict();
export const ProfileInput = z.object({ id: Id, accountId: Id, model: z.string().min(1).max(100),
  effort: z.enum(['low','medium','high']), role: Role }).strict();
const Chain = z.object({ regular: z.array(Id).min(1).max(20), emergency: z.array(Id).max(20).default([]) }).strict();
export const CapacityPolicy = z.object({ schemaVersion: z.literal(1),
  maxProgrammersPerContext: z.number().int().min(1).max(10),
  maxEvaluatorsPerContext: z.number().int().min(1).max(10),
  roles: z.object({ manager: Chain.optional(), programmer: Chain.optional(), reviewer: Chain.optional(),
    qa: Chain.optional(), specialist: Chain.optional(), judge: Chain.optional() }).strict(),
}).strict().superRefine((p, ctx) => {
  for (const [role, chain] of Object.entries(p.roles)) if (chain) {
    const ids = [...chain.regular,...chain.emergency];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['roles',role], message: 'DUPLICATE_PROFILE' });
  }
});
export type CapacityPolicy = z.infer<typeof CapacityPolicy>;
export const QuotaInput = z.object({ status: z.enum(['available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error']),
  source: z.string().min(1).max(200), ttlSeconds: z.number().int().min(1).max(3600) }).strict();
export const GrantRequest = z.object({ attemptId: Id, intentId: Id, contextId: Id, role: Role }).strict();
export type Grant = { id: string; attempt_id: string; context_id: string; account_id: string; profile_id: string;
  state: string; manager_epoch: string; request_digest: string; emergency: boolean };

type Candidate = { id: string; account_id: string; eligibility: string; quota: string; enabled: boolean; max_concurrent: number };
const evaluations: Role[] = ['reviewer','qa','specialist','judge'];

/** Only the PG ledger admits capacity. This service never advances a Cezar DAG. */
export class Capacity {
  constructor(readonly ledger: Ledger, private readonly client?: pg.PoolClient) {}
  private tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> { return this.client ? fn(this.client) : this.ledger.tx(fn); }
  private async owner(c: pg.PoolClient, principal: string, projectId: string) {
    const result = await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'", [projectId, principal]);
    if (!result.rowCount) throw new Refusal('PROJECT_OWNER_REQUIRED', 403);
  }
  private async admin(c: pg.PoolClient, principal: string) {
    if (!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1', [principal])).rowCount)
      throw new Refusal('CONTROL_ADMIN_REQUIRED', 403);
  }
  async configure(principal: string, value: { programmingLimit: number; evaluationLimit: number; expectedRevision?: number; originalFallback?: {accountId:string;programmingLimit:number;evaluationLimit:number}|null }) {
    const input = z.object({ programmingLimit: z.number().int().min(1).max(128), evaluationLimit: z.number().int().min(1).max(128),
      expectedRevision:z.number().int().nonnegative().optional(),
      originalFallback:z.object({accountId:Id,programmingLimit:z.number().int().min(1).max(128),evaluationLimit:z.number().int().min(1).max(128)}).strict().nullable().optional() }).strict().parse(value);
    await this.tx(async c => {
      await this.admin(c, principal);
      await c.query('SELECT pg_advisory_xact_lock(189234,4)');
      const current=(await c.query('SELECT * FROM ac_capacity_config WHERE id=1 FOR UPDATE')).rows[0];
      if(input.expectedRevision!==undefined&&input.expectedRevision!==(current?.revision??0))throw new Refusal('CAPACITY_CONFIG_CONFLICT');
      const original=input.originalFallback===undefined?(current?.original_account_id?{accountId:current.original_account_id,programmingLimit:current.original_programming_limit,evaluationLimit:current.original_evaluation_limit}:null):input.originalFallback;
      await c.query(`INSERT INTO ac_capacity_config(id,revision,programming_limit,evaluation_limit,original_account_id,original_programming_limit,original_evaluation_limit)
        VALUES(1,1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET revision=ac_capacity_config.revision+1,
        programming_limit=$1,evaluation_limit=$2,original_account_id=$3,original_programming_limit=$4,original_evaluation_limit=$5`,
        [input.programmingLimit,input.evaluationLimit,original?.accountId??null,original?.programmingLimit??null,original?.evaluationLimit??null]);
    });
  }
  async registerModel(principal: string, raw: {provider: string; model: string; efforts: string[]; roles: Role[]; source: string}) {
    const input=z.object({provider:z.string().min(1).max(80),model:z.string().min(1).max(100),
      efforts:z.array(z.enum(['low','medium','high'])).min(1).max(3),roles:z.array(Role).min(1).max(6),source:z.string().min(1).max(500)}).strict().parse(raw);
    await this.tx(async c=>{await this.admin(c,principal);
      await c.query('INSERT INTO ac_model_catalog VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [input.provider,input.model,input.efforts,input.roles,input.source]);
      const saved=(await c.query('SELECT efforts,roles,source FROM ac_model_catalog WHERE provider=$1 AND model=$2',[input.provider,input.model])).rows[0];
      if(digest(saved)!==digest({efforts:input.efforts,roles:input.roles,source:input.source}))throw new Refusal('CATALOG_ENTRY_CONFLICT');
    });
  }
  async addAccount(principal: string, projectId: string, raw: z.input<typeof AccountInput>) {
    const a = AccountInput.parse(raw);
    await this.tx(async c => {
      await this.owner(c, principal, projectId);
      await c.query('INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [a.id, principal, a.provider, a.label, a.resourceIdentity, a.mode, a.eligibility, a.eligibilitySource, a.maxConcurrent]);
      await c.query('INSERT INTO ac_account_access VALUES($1,$2)', [a.id, projectId]);
    });
  }
  async shareAccount(principal: string, accountId: string, projectId: string) {
    await this.tx(async c => {
      await this.owner(c, principal, projectId);
      if (!(await c.query('SELECT 1 FROM ac_accounts WHERE id=$1 AND owner_id=$2', [Id.parse(accountId), principal])).rowCount)
        throw new Refusal('ACCOUNT_FORBIDDEN', 403);
      await c.query('INSERT INTO ac_account_access VALUES($1,$2) ON CONFLICT DO NOTHING', [accountId, projectId]);
    });
  }
  async setEnabled(principal:string,projectId:string,kind:'account'|'profile',raw:{id:string;enabled:boolean;expectedRevision:number}){
    const input=z.object({id:Id,enabled:z.boolean(),expectedRevision:z.number().int().positive()}).strict().parse(raw);
    await this.tx(async c=>{
      await this.owner(c,principal,projectId);
      await c.query('SELECT id FROM ac_capacity_config WHERE id=1 FOR UPDATE');
      const row=(await c.query(kind==='account'
        ?`SELECT a.revision FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
          WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3 FOR UPDATE OF a`
        :`SELECT p.revision FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id JOIN ac_account_access x ON x.account_id=a.id
          WHERE p.id=$1 AND a.owner_id=$2 AND x.project_id=$3 FOR UPDATE OF p`,[input.id,principal,projectId])).rows[0];
      if(!row)throw new Refusal('ACCOUNT_PROFILE_FORBIDDEN',403);
      if(row.revision!==input.expectedRevision)throw new Refusal('ACCOUNT_PROFILE_REVISION_CONFLICT');
      await c.query(kind==='account'?'UPDATE ac_accounts SET enabled=$2,revision=revision+1 WHERE id=$1':
        'UPDATE ac_profiles SET enabled=$2,revision=revision+1 WHERE id=$1',[input.id,input.enabled]);
    });
  }
  async addProfile(principal: string, projectId: string, raw: z.input<typeof ProfileInput>) {
    const p = ProfileInput.parse(raw);
    await this.tx(async c => {
      await this.owner(c, principal, projectId);
      if (!(await c.query('SELECT 1 FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3', [p.accountId, principal, projectId])).rowCount)
        throw new Refusal('ACCOUNT_FORBIDDEN', 403);
      if(!(await c.query(`SELECT 1 FROM ac_model_catalog m JOIN ac_accounts a ON a.provider=m.provider
        WHERE a.id=$1 AND m.model=$2 AND $3=ANY(m.efforts) AND $4=ANY(m.roles)`,[p.accountId,p.model,p.effort,p.role])).rowCount)
        throw new Refusal('MODEL_EFFORT_NOT_IN_CATALOG');
      await c.query('INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,$3,$4,$5)', [p.id,p.accountId,p.model,p.effort,p.role]);
    });
  }
  async observeQuota(principal: string, accountId: string, raw: z.input<typeof QuotaInput>) {
    const q = QuotaInput.parse(raw);
    await this.tx(async c => {
      if (!(await c.query('SELECT 1 FROM ac_accounts WHERE id=$1 AND owner_id=$2', [Id.parse(accountId), principal])).rowCount)
        throw new Refusal('ACCOUNT_FORBIDDEN', 403);
      // No process is made eligible merely because an observation expired.
      await c.query(`INSERT INTO ac_quota_observations VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+$4*interval '1 second')
        ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,source=excluded.source,observed_at=excluded.observed_at,expires_at=excluded.expires_at`,
        [accountId, q.status, q.source, q.ttlSeconds]);
    });
  }
  async publish(principal: string, projectId: string, expectedRevision: number, raw: CapacityPolicy) {
    const policy = CapacityPolicy.parse(raw);
    return this.tx(async c => {
      await this.owner(c, principal, projectId);
      await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE', [projectId]);
      const revision = Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_policy_revisions WHERE project_id=$1', [projectId])).rows[0].revision);
      if (revision !== expectedRevision) throw new Refusal('POLICY_CONFLICT');
      for (const [role, chain] of Object.entries(policy.roles)) if (chain) for (const id of [...chain.regular,...chain.emergency]) {
        const found = await c.query(`SELECT 1 FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id
          WHERE p.id=$1 AND p.role=$2 AND x.project_id=$3`, [id,role,projectId]);
        if (!found.rowCount) throw new Refusal('POLICY_PROFILE_FORBIDDEN', 403);
      }
      await c.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,$2,$3,$4,$5)',
        [projectId,revision+1,digest(policy),policy,principal]);
      return revision+1;
    });
  }
  async assignPolicy(principal: string, contextId: string, revision: number) {
    await this.tx(async c => {
      const context = await this.ledger.authorize(c, principal, Id.parse(contextId));
      await this.owner(c, principal, context.project_id);
      if (!(await c.query('SELECT 1 FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2', [context.project_id, revision])).rowCount)
        throw new Refusal('POLICY_MISSING');
      await c.query('UPDATE ac_contexts SET capacity_policy_revision=$2 WHERE id=$1', [contextId,revision]);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'capacity.policy.assigned',$2)", [contextId,{revision}]);
    });
  }
  async reserve(principal: string, raw: z.input<typeof GrantRequest>, authority: Authority): Promise<Grant> {
    const request = GrantRequest.parse(raw);
    const result = await this.tx<Grant|{blockedCode:string}>(async c => {
      const context = await this.ledger.authorize(c, principal, request.contextId);
      if (request.contextId !== authority.contextId) throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
      await this.ledger.fence(c, authority);
      // One lock coordinates all accounts/contexts/processes; no local semaphore is an authority.
      const config = (await c.query('SELECT * FROM ac_capacity_config WHERE id=1 FOR UPDATE')).rows[0];
      if (!config) throw new Refusal('CAPACITY_NOT_CONFIGURED');
      const hash = digest(request);
      const old = (await c.query<Grant>('SELECT * FROM ac_capacity_grants WHERE attempt_id=$1', [request.attemptId])).rows[0];
      if (old) {
        if (old.request_digest !== hash) throw new Refusal('ATTEMPT_PAYLOAD_CONFLICT');
        return old;
      }
      if (!(await c.query('SELECT 1 FROM ac_intents WHERE id=$1 AND context_id=$2', [request.intentId,request.contextId])).rowCount)
        throw new Refusal('INTENT_SCOPE_MISMATCH',403);
      const stored = (await c.query('SELECT snapshot,digest FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2', [context.project_id,context.capacity_policy_revision])).rows[0];
      if (!stored) throw new Refusal('CAPACITY_POLICY_REQUIRED');
      const policy = CapacityPolicy.parse(stored.snapshot);
      if (digest(policy)!==stored.digest) throw new Refusal('POLICY_DIGEST_MISMATCH');
      const chain = policy.roles[request.role];
      if (!chain) throw new Refusal('ROLE_NOT_CONFIGURED');
      const priority=request.role==='manager'?100:evaluations.includes(request.role)?50:0;
      const wait=await c.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,priority)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(attempt_id) DO UPDATE SET manager_epoch=excluded.manager_epoch
        WHERE ac_capacity_waits.request_digest=excluded.request_digest RETURNING attempt_id`,
        [request.attemptId,request.contextId,request.intentId,request.role,hash,authority.epoch,priority]);
      if(!wait.rowCount)throw new Refusal('ATTEMPT_PAYLOAD_CONFLICT');
      const preferred = (await c.query('SELECT profile_id FROM ac_regular_selections WHERE context_id=$1 AND role=$2 AND policy_revision=$3',
        [request.contextId,request.role,context.capacity_policy_revision])).rows[0]?.profile_id;
      const regular = preferred && chain.regular.includes(preferred) ? [preferred,...chain.regular.filter(p=>p!==preferred)] : chain.regular;
      const ids = [...regular,...chain.emergency];
      const candidates = await c.query<Candidate>(`SELECT p.id,a.id account_id,a.eligibility,a.max_concurrent,
        (a.enabled AND p.enabled) enabled,CASE WHEN q.expires_at>clock_timestamp() THEN q.status ELSE 'unknown' END quota
        FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id JOIN ac_account_access x ON x.account_id=a.id
        LEFT JOIN ac_quota_observations q ON q.account_id=a.id WHERE p.id=ANY($1::uuid[]) AND x.project_id=$2`, [ids,context.project_id]);
      const available = (id: string) => candidates.rows.find(p=>p.id===id && p.enabled && p.eligibility==='documented_supported' && p.quota==='available');
      // Saturation does not imply exhausted quota: wait rather than spilling into another subscription.
      const selectedId = ids.find(id=>available(id));
      if (!selectedId) {
        await c.query("UPDATE ac_capacity_waits SET desired_profile=NULL,reason='NO_ELIGIBLE_CAPACITY' WHERE attempt_id=$1",[request.attemptId]);
        return {blockedCode:'NO_ELIGIBLE_CAPACITY'};
      }
      const selected = available(selectedId)!;
      await c.query('UPDATE ac_capacity_waits SET desired_profile=$2 WHERE attempt_id=$1',[request.attemptId,selected.id]);
      const first=(await c.query(`SELECT w.attempt_id FROM ac_capacity_waits w JOIN ac_profiles p ON p.id=w.desired_profile
        JOIN ac_contexts x ON x.id=w.context_id JOIN ac_managers m ON m.context_id=x.id
        JOIN ac_intents i ON i.id=w.intent_id
        JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision
        WHERE p.account_id=$1 AND p.enabled AND i.state NOT IN ('done','review','failed','canceled') AND NOT x.paused
        AND ((COALESCE(r.snapshot->'roles'->w.role->'regular','[]'::jsonb)||COALESCE(r.snapshot->'roles'->w.role->'emergency','[]'::jsonb)) ? p.id::text) AND m.epoch=w.manager_epoch AND m.lease_until>clock_timestamp()
        ORDER BY w.priority DESC,w.sequence LIMIT 1`,[selected.account_id])).rows[0];
      if(first?.attempt_id!==request.attemptId){await c.query("UPDATE ac_capacity_waits SET reason='CAPACITY_QUEUED' WHERE attempt_id=$1",[request.attemptId]);return {blockedCode:'CAPACITY_QUEUED'};}
      const isEvaluation = evaluations.includes(request.role);
      const group = isEvaluation ? evaluations : request.role==='programmer' ? ['programmer'] : ['manager'];
      const counts = (await c.query(`SELECT
        count(*) FILTER(WHERE account_id=$1) account,
        count(*) FILTER(WHERE account_id=$1 AND role=ANY($3::text[])) account_role,
        count(*) FILTER(WHERE context_id=$2 AND role=ANY($3::text[])) context,
        count(*) FILTER(WHERE role=ANY($3::text[])) global
        FROM ac_capacity_grants WHERE state<>'released'`, [selected.account_id,request.contextId,group])).rows[0];
      const localLimit = isEvaluation ? policy.maxEvaluatorsPerContext : request.role==='programmer' ? policy.maxProgrammersPerContext : 1;
      const globalLimit = isEvaluation ? config.evaluation_limit : request.role==='programmer' ? config.programming_limit : Infinity;
      let originalLimit=Infinity;
      if(config.original_account_id===selected.account_id&&(request.role==='programmer'||isEvaluation)){
        const other=(await c.query(`SELECT 1 FROM ac_contexts x JOIN ac_managers m ON m.context_id=x.id
          JOIN ac_policy_revisions r ON r.project_id=x.project_id AND r.revision=x.capacity_policy_revision
          CROSS JOIN LATERAL jsonb_each(r.snapshot->'roles') chain
          CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(chain.value->'regular','[]'::jsonb)||COALESCE(chain.value->'emergency','[]'::jsonb)) member
          JOIN ac_profiles p ON p.id=member.value::uuid JOIN ac_accounts a ON a.id=p.account_id
          JOIN ac_account_access access ON access.account_id=a.id AND access.project_id=x.project_id
          JOIN ac_quota_observations q ON q.account_id=a.id
          WHERE NOT x.paused AND m.lease_until>clock_timestamp() AND a.id<>$1 AND a.enabled AND p.enabled
          AND (($2='programmer' AND p.role='programmer') OR ($2<>'programmer' AND p.role IN ('reviewer','qa','specialist','judge')))
          AND a.eligibility='documented_supported'
          AND q.status='available' AND q.expires_at>clock_timestamp() LIMIT 1`,[selected.account_id,request.role])).rowCount;
        if(other&&request.role==='programmer'){
          await c.query("UPDATE ac_capacity_waits SET desired_profile=NULL,reason='ORIGINAL_RESERVE_NOT_NEEDED' WHERE attempt_id=$1",[request.attemptId]);
          return {blockedCode:'ORIGINAL_RESERVE_NOT_NEEDED'};
        }
        if(!other)originalLimit=isEvaluation?config.original_evaluation_limit:config.original_programming_limit;
      }
      if (Number(counts.account)>=selected.max_concurrent || Number(counts.context)>=localLimit || Number(counts.global)>=globalLimit || Number(counts.account_role)>=originalLimit)
        {await c.query("UPDATE ac_capacity_waits SET reason='CAPACITY_BUSY' WHERE attempt_id=$1",[request.attemptId]);return {blockedCode:'CAPACITY_BUSY'};}
      const emergency = chain.emergency.includes(selected.id);
      const grant = (await c.query<Grant>(`INSERT INTO ac_capacity_grants
        (id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved') RETURNING *`,
        [randomUUID(),request.attemptId,request.intentId,request.contextId,authority.epoch,selected.account_id,selected.id,request.role,
          context.project_id,context.capacity_policy_revision,config.revision,hash,emergency])).rows[0];
      if (!emergency) await c.query(`INSERT INTO ac_regular_selections VALUES($1,$2,$3,$4)
        ON CONFLICT(context_id,role) DO UPDATE SET profile_id=excluded.profile_id,policy_revision=excluded.policy_revision`,
        [request.contextId,request.role,selected.id,context.capacity_policy_revision]);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'capacity.reserved',$2)", [request.contextId,{grantId:grant.id,attemptId:request.attemptId,profileId:selected.id,emergency}]);
      await c.query('DELETE FROM ac_capacity_waits WHERE attempt_id=$1',[request.attemptId]);
      return grant;
    });
    if('blockedCode' in result)throw new Refusal(result.blockedCode);
    return result;
  }
  async cancelWait(principal:string,attemptId:string,authority:Authority){
    await this.tx(async c=>{await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
      await c.query('DELETE FROM ac_capacity_waits WHERE attempt_id=$1 AND context_id=$2',[Id.parse(attemptId),authority.contextId]);});
  }
  async transition(principal: string, grantId: string, authority: Authority, next: 'running'|'uncertain'|'released', receipt?: { processId: string; state: 'exited'|'not_started' }) {
    const parsedReceipt = receipt === undefined ? undefined : z.object({ processId: z.string().min(1).max(200), state: z.enum(['exited','not_started']) }).strict().parse(receipt);
    await this.tx(async c => {
      await this.ledger.authorize(c, principal, authority.contextId);
      await this.ledger.fence(c, authority, true);
      await c.query('SELECT id FROM ac_capacity_config WHERE id=1 FOR UPDATE');
      const grant = (await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 AND context_id=$2 FOR UPDATE', [Id.parse(grantId),authority.contextId])).rows[0];
      if (!grant) throw new Refusal('GRANT_FORBIDDEN',403);
      if (Number(grant.manager_epoch)!==authority.epoch) throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
      if (grant.state==='released') { if (next==='released') return; throw new Refusal('GRANT_ALREADY_RELEASED'); }
      if (next==='running' && grant.state!=='reserved') throw new Refusal('INVALID_GRANT_TRANSITION');
      if (next==='released' && !parsedReceipt) throw new Refusal('PHYSICAL_RECEIPT_REQUIRED');
      if (next==='released' && parsedReceipt?.state==='not_started' && grant.state!=='reserved') throw new Refusal('PROCESS_MUST_EXIT');
      await c.query('UPDATE ac_capacity_grants SET state=$2,physical_receipt=$3 WHERE id=$1', [grantId,next,parsedReceipt??null]);
    });
  }
}
