import {createHash} from 'node:crypto';
import {digest} from './contracts.ts';

/**
 * Proof for an exam call that covers several files (modules 1 and 10).
 *
 * The call receipt identifies one native job. The batch receipt binds that job to the exact list of files it covered,
 * each with the SHA-256 of its content and whether the examiner judged it. The digest is a canonical SHA-256 over the
 * whole record, so changing a file, its judgment, the call or the session changes it. It is a content digest, not a
 * secret-key signature: the session id comes from the native supervisor.
 */
export type BatchFileProof = {file: string; sha256: string | null; judged: boolean};
export type BatchCallReceipt = {
  scope: 'seguranca' | 'design';
  callId: string;
  intentId: string;
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
  sessionId: string | null;
  files: BatchFileProof[];
  digest: string;
};

export function sha256Text(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

function receiptDigest(receipt: Omit<BatchCallReceipt, 'digest'>): string {
  return digest({
    scope: receipt.scope, callId: receipt.callId, intentId: receipt.intentId,
    provider: receipt.provider, model: receipt.model, accountId: receipt.accountId, profileId: receipt.profileId,
    grantId: receipt.grantId, sessionId: receipt.sessionId,
    files: receipt.files.map(item => ({file: item.file, sha256: item.sha256, judged: item.judged})),
  });
}

export function batchCallReceipt(input: Omit<BatchCallReceipt, 'digest'>): BatchCallReceipt {
  return {...input, files: input.files.map(item => ({...item})), digest: receiptDigest(input)};
}

/** True when the record still hashes to its own digest. */
export function batchReceiptIntact(receipt: BatchCallReceipt): boolean {
  const {digest: stored, ...rest} = receipt;
  return stored === receiptDigest(rest);
}

/** The receipt covers the file, judged, with this content hash. Used on recheck. */
export function batchReceiptJudges(receipt: BatchCallReceipt, file: string, sha256: string | null): boolean {
  if (!batchReceiptIntact(receipt)) return false;
  return receipt.files.some(item => item.file === file && item.judged && item.sha256 === sha256);
}

function cell(value: string): string {
  return value.replace(/[\r\n|]+/g, ' ').trim();
}

/** Markdown for the report: one line per file, tied to the call that produced its judgment. */
export function batchReceiptsMarkdown(receipts: readonly BatchCallReceipt[]): string {
  if (receipts.length === 0) return '';
  const lines = [
    '## Recibos das chamadas',
    '',
    'Cada chamada cobre uma lista de arquivos. O recibo é um SHA-256 do registro (chamada, sessão, arquivos e hashes). A coluna Julgado diz se o examinador devolveu o arquivo como lido; arquivo sem julgamento fica pendente.',
    '',
    '| Chamada | Recibo | Arquivo | SHA-256 do conteúdo | Julgado |',
    '|---|---|---|---|---|',
  ];
  for (const receipt of receipts) {
    for (const item of receipt.files) {
      lines.push(`| ${cell(receipt.callId)} | ${receipt.digest.slice(0, 16)} | ${cell(item.file)} | ${item.sha256 ? item.sha256.slice(0, 16) : 'indisponível'} | ${item.judged ? 'sim' : 'pendente'} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Sequential grouping by cost and count. An item over the budget stays alone. */
export function groupByBudget<T>(items: readonly T[], cost: (item: T) => number, budget: {tokens: number; files: number}): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const price = cost(item);
    if (price > budget.tokens) {
      if (current.length) groups.push(current);
      groups.push([item]);
      current = [];
      tokens = 0;
      continue;
    }
    if (current.length && (tokens + price > budget.tokens || current.length >= budget.files)) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += price;
  }
  if (current.length) groups.push(current);
  return groups;
}
