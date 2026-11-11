import {z} from 'zod';

/** Text the panel shows. Internal events (no owner or manager text) stay out. */
export type PanelMessage = {id: string; role: 'owner' | 'manager'; text: string; createdAt: string};
export type PanelPage = {messages: PanelMessage[]; next: string | null};

const conversationQuery = z.object({
  after: z.string().regex(/^[0-9]{1,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/** `limit` defaults to 50 and never exceeds 200. `after` is an exclusive sequence cursor. */
export function parseConversationQuery(raw: {after?: string; limit?: string}): {after?: string; limit: number} {
  return conversationQuery.parse({
    after: raw.after ? raw.after : undefined,
    limit: raw.limit === undefined || raw.limit === '' ? undefined : raw.limit,
  });
}

export const personalMessageInput = z.object({
  text: z.string().min(1).max(8000),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
}).strict();

/** Stable Happier local id for one panel send. A repeated clientId keeps this id. */
export function personalPanelLocalId(clientId: string) {
  return 'panel-' + clientId;
}

/** Records the first send for a clientId. A second call is the same entry and must not send again. */
export function claimPersonalSend(seen: Map<string, string>, projectId: string, clientId: string): {id: string; fresh: boolean} {
  const key = projectId + '\0' + clientId;
  const id = personalPanelLocalId(clientId);
  const previous = seen.get(key);
  if (previous) return {id: previous, fresh: false};
  seen.set(key, id);
  return {id, fresh: true};
}

export function releasePersonalSend(seen: Map<string, string>, projectId: string, clientId: string, id: string) {
  const key = projectId + '\0' + clientId;
  if (seen.get(key) === id) seen.delete(key);
}

/** One visible row, or null when the decrypted record is not owner/manager text. */
export function panelMessageFromRecord(id: string, createdAtMs: number, record: unknown): PanelMessage | null {
  if (!Number.isFinite(createdAtMs) || !record || typeof record !== 'object') return null;
  const createdAt = new Date(createdAtMs).toISOString();
  const body = record as {role?: unknown; content?: {type?: unknown; text?: unknown; data?: {message?: {content?: unknown}}}};
  if (body.role === 'user' && body.content?.type === 'text' && typeof body.content.text === 'string' && body.content.text.length > 0)
    return {id, role: 'owner', text: body.content.text, createdAt};
  const parts = body.role === 'agent' && body.content?.type === 'output' ? body.content.data?.message?.content : undefined;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((part): part is {text: string} => !!part && typeof part === 'object' && (part as {type?: unknown}).type === 'text' && typeof (part as {text?: unknown}).text === 'string').map(part => part.text).join('\n');
  return text.length > 0 ? {id, role: 'manager', text, createdAt} : null;
}
