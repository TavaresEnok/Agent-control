import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ChecklistItem} from './verify-types.ts';

const checklistPath = fileURLToPath(new URL('./verify/lista-seguranca.json', import.meta.url));

function rejectDuplicateIds(items: readonly ChecklistItem[]): readonly ChecklistItem[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`CHECKLIST_ID_DUPLICADO:${item.id}`);
    seen.add(item.id);
  }
  return items;
}

export function loadSecurityChecklist(): readonly ChecklistItem[] {
  const body: unknown = JSON.parse(readFileSync(checklistPath, 'utf8'));
  return rejectDuplicateIds(ChecklistItem.array().parse(body));
}

export function parseSecurityChecklist(body: unknown): readonly ChecklistItem[] {
  return rejectDuplicateIds(ChecklistItem.array().parse(body));
}
