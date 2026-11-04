/** Explicit QA waiver versus missing, failed, canceled or stale evidence.
 * A passed QA receipt satisfies the QA condition by itself. Not_required is
 * only the complete owner binding. This module does not launch a verifier. */
export const QA_WAIVER_RISK_RULE = 'explicit-low' as const;

export type QaWaiverBindingRecord = {
  policyRevision: number;
  policyDigest: string;
  templateId: string;
  templateRevision: number;
  templateDigest: string;
  riskRule: string;
  taskId: string;
  artifactDigest: string;
};

export type QaWaiverGate =
  | { ok: true; basis: 'passed' | 'not_required' }
  | { ok: false; code: 'VERIFICATION_NOT_PASSED' | 'QA_MISSING' | 'QA_WAIVER_STALE' };

export function evaluateQaWaiverGate(input: {
  allowLowRiskQaWaiver: boolean;
  risk: string;
  evidence: readonly { kind: string; status: string }[];
  policyRevision: number;
  policyDigest: string;
  artifactDigest: string;
  waiver: QaWaiverBindingRecord | null;
  templateDigest: string | null;
}): QaWaiverGate {
  if (input.evidence.some(item => item.status !== 'passed')) return { ok: false, code: 'VERIFICATION_NOT_PASSED' };
  if (input.evidence.some(item => item.kind === 'qa' && item.status === 'passed')) return { ok: true, basis: 'passed' };
  const waiver = input.waiver;
  if (!waiver || !input.allowLowRiskQaWaiver || input.risk !== 'low') return { ok: false, code: 'QA_MISSING' };
  const bound = waiver.policyRevision === input.policyRevision
    && waiver.policyDigest === input.policyDigest
    && waiver.artifactDigest === input.artifactDigest
    && waiver.riskRule === QA_WAIVER_RISK_RULE
    && waiver.templateDigest === input.templateDigest
    && input.templateDigest !== null
    && waiver.taskId.length > 0;
  if (!bound) return { ok: false, code: 'QA_WAIVER_STALE' };
  return { ok: true, basis: 'not_required' };
}
