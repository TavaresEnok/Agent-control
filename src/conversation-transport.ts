import type pg from 'pg';
import type {PanelPage} from './personal-panel-conversation.ts';

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
