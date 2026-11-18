import {randomUUID} from 'node:crypto';
import {Refusal, type Authority} from './contracts.ts';
import {Ledger, type Intent} from './ledger.ts';

/** Locked mode stays locked. Every verification entry point calls this first. */
export async function assertPersonalActivation(ledger: Ledger) {
  const personal = await ledger.pool.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'");
  if (!personal.rowCount) throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
}

/** Read-only intent. It exists so capacity can reserve specialist and reviewer.
 * Cezar does not dispatch this workflow, and the payload has no write paths. */
export async function acceptSecurityVerification(ledger: Ledger, principal: string, authority: Authority, input: {
  projectId: string; commit: string; policyRevision: number; intentId?: string; deliveryAttemptId?: string;
}): Promise<Intent> {
  await assertPersonalActivation(ledger);
  const intentId = input.intentId ?? randomUUID();
  const deliveryAttemptId = input.deliveryAttemptId ?? randomUUID();
  return ledger.accept(principal, {
    schemaVersion: 1,
    intentId,
    deliveryAttemptId,
    contextId: authority.contextId,
    policyRevision: input.policyRevision,
    action: 'plan.start',
    payload: {
      workflow: 'security-verify-readonly-v1',
      messageRef: `verify:${input.projectId}:${input.commit}`.slice(0, 200),
      projectId: input.projectId,
      commit: input.commit,
    },
  }, authority, 'api');
}
