import type pg from 'pg';
import {digest, Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import type {PanelMessage, PanelPage} from './personal-panel-conversation.ts';

/** How a personal conversation enters and leaves. The endpoint still owns accept, proposals and the tick. */
export type ConversationKind = 'happier' | 'local';
export type ClaimedOwnerMessage = {text: string; localId: string; meta?: unknown};

export interface ConversationTransport {
  readonly kind: ConversationKind;
  start(): Promise<void>;
  connectionState(): 'connected' | 'disconnected';
  /** One owner message, or null. Must not settle and must not call accept. */
  claimOwnerMessage(): Promise<ClaimedOwnerMessage | null>;
  settleOwnerMessage(localId: string, outcome: 'accepted' | 'refused'): Promise<void>;
  /** When `client` is set, write on that transaction and do not authorize again. */
  publishManagerText(localId: string, text: string, record: unknown, client?: pg.PoolClient, priority?: 0 | 50): Promise<{id: string; seq: number}>;
  readPage(after: string | undefined, limit: number): Promise<PanelPage>;
  publishTeamModels(): Promise<void>;
  close(): void;
}

export function personalMessageId(contextId: string, localId: string) {
  return contextId + '|' + localId;
}

/** Owner line already queued by the panel or the terminal. A repeated local id keeps the first text. */
export async function enqueuePersonalOwner(db: pg.Pool | pg.PoolClient, contextId: string, localId: string, text: string) {
  await db.query(`INSERT INTO ac_personal_messages(id,context_id,role,text,local_id,accepted) VALUES($1,$2,'owner',$3,$4,false)
    ON CONFLICT (context_id, local_id) DO NOTHING`, [personalMessageId(contextId, localId), contextId, text, localId]);
}

/** Inside accept's transaction. An existing row must match; it is not marked accepted here. */
export async function bindPersonalOwnerMessage(c: pg.PoolClient, contextId: string, localId: string, text: string) {
  const existing = (await c.query('SELECT text FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2 FOR UPDATE', [contextId, localId])).rows[0];
  if (existing) {
    if (digest(String(existing.text)) !== digest(text)) throw new Refusal('CHAT_MESSAGE_CONFLICT');
    return;
  }
  await c.query(`INSERT INTO ac_personal_messages(id,context_id,role,text,local_id,accepted) VALUES($1,$2,'owner',$3,$4,true)
    ON CONFLICT (context_id, local_id) DO NOTHING`, [personalMessageId(contextId, localId), contextId, text, localId]);
  const stored = (await c.query('SELECT text FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2', [contextId, localId])).rows[0];
  if (!stored || digest(String(stored.text)) !== digest(text)) throw new Refusal('CHAT_MESSAGE_CONFLICT');
}

export async function readPersonalOwnerText(db: pg.Pool | pg.PoolClient, contextId: string, localId: string): Promise<string | null> {
  const row = (await db.query(`SELECT text FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2 AND role='owner'`, [contextId, localId])).rows[0];
  return row ? String(row.text) : null;
}

function panelRow(row: {id: string; role: string; text: string; created_at: Date | string}): PanelMessage {
  return {id: String(row.id), role: row.role === 'owner' ? 'owner' : 'manager', text: String(row.text), createdAt: new Date(row.created_at).toISOString()};
}

/** Postgres transcript. Connected while the endpoint loop is armed, so the 15s watchdog does not restart it. */
export class LocalConversationTransport implements ConversationTransport {
  readonly kind = 'local' as const;
  private running = false;
  constructor(private readonly deps: {ledger: Ledger; contextId: string; principal: string}) {}
  async start() { this.running = true; }
  connectionState(): 'connected' | 'disconnected' { return this.running ? 'connected' : 'disconnected'; }
  close() { this.running = false; }
  async publishTeamModels() {}
  async claimOwnerMessage() {
    const row = (await this.deps.ledger.pool.query(`SELECT local_id, text FROM ac_personal_messages
      WHERE context_id=$1 AND role='owner' AND NOT accepted ORDER BY seq LIMIT 1`, [this.deps.contextId])).rows[0];
    return row ? {text: String(row.text), localId: String(row.local_id)} : null;
  }
  async settleOwnerMessage(localId: string, _outcome: 'accepted' | 'refused') {
    await this.deps.ledger.pool.query(`UPDATE ac_personal_messages SET accepted=true WHERE context_id=$1 AND local_id=$2 AND role='owner'`, [this.deps.contextId, localId]);
  }
  async publishManagerText(localId: string, text: string, _record: unknown, client?: pg.PoolClient, _priority?: 0 | 50) {
    const id = personalMessageId(this.deps.contextId, localId);
    const write = async (c: pg.PoolClient) => {
      await c.query(`INSERT INTO ac_personal_messages(id,context_id,role,text,local_id,accepted) VALUES($1,$2,'manager',$3,$4,true)
        ON CONFLICT (context_id, local_id) DO NOTHING`, [id, this.deps.contextId, text, localId]);
      const stored = (await c.query('SELECT id, text, seq FROM ac_personal_messages WHERE context_id=$1 AND local_id=$2', [this.deps.contextId, localId])).rows[0];
      if (!stored || digest(String(stored.text)) !== digest(text)) throw new Refusal('CHAT_MESSAGE_CONFLICT');
      return {id: String(stored.id), seq: Number(stored.seq)};
    };
    if (client) return write(client);
    return this.deps.ledger.tx(async c => {
      await this.deps.ledger.authorize(c, this.deps.principal, this.deps.contextId, false);
      return write(c);
    });
  }
  async readPage(after: string | undefined, limit: number): Promise<PanelPage> {
    if (after === undefined) {
      const rows = (await this.deps.ledger.pool.query(`SELECT id, role, text, created_at, seq FROM ac_personal_messages
        WHERE context_id=$1 ORDER BY seq DESC LIMIT $2`, [this.deps.contextId, limit])).rows as {id: string; role: string; text: string; created_at: Date; seq: string}[];
      const ordered = [...rows].reverse();
      return {messages: ordered.map(panelRow), next: rows.length ? String(rows[0]!.seq) : null};
    }
    const rows = (await this.deps.ledger.pool.query(`SELECT id, role, text, created_at, seq FROM ac_personal_messages
      WHERE context_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT $3`, [this.deps.contextId, Number(after), limit])).rows as {id: string; role: string; text: string; created_at: Date; seq: string}[];
    const last = rows.at(-1);
    return {messages: rows.map(panelRow), next: last ? String(last.seq) : after};
  }
}
