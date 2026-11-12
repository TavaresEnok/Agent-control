import {Refusal} from './contracts.ts';
import {ContextVault} from './context-vault.ts';
import {loadHappier,readImportTranscript,type HappierBoundary} from './happier.ts';
import {loadInstallation,readPrivateFile,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {personalMessageId} from './conversation-transport.ts';

type TransportContext = NonNullable<Installation['managerTransport']>['contexts'][number];

/** Copy each linked Happier transcript into `ac_personal_messages`.
 * Run this while transport is still happier. A later run, including after the switch to local, inserts nothing new.
 * Rows are marked accepted so the local loop does not claim them, and accept() is never called. */
export async function importPersonalConversation(path: string, overrides: {
  fetchPage?: typeof fetch;
  loadKey?: (item: TransportContext) => Uint8Array | Promise<Uint8Array>;
  token?: string;
  boundary?: HappierBoundary;
} = {}) {
  const config = await loadInstallation(path);
  if (config.activation !== 'personal') throw new Error('PERSONAL_ACTIVATION_REQUIRED');
  const transport = config.managerTransport;
  const vaultConfig = config.contextVault;
  if (!transport || !vaultConfig) throw new Error('PERSONAL_CONNECT_REQUIRED');
  const tokenBytes = overrides.token === undefined ? await readPrivateFile(transport.tokenFile, 16384) : undefined;
  const token = (overrides.token ?? tokenBytes!.toString('utf8')).trim();
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Refusal('MANAGER_TOKEN_INVALID', 400);
  const ledger = new Ledger(config.databaseUrl, config.installationAuthority?.token);
  let inserted = 0, existing = 0;
  try {
    const boundary = overrides.boundary ?? await loadHappier();
    const source = overrides.loadKey ? undefined : await vaultSource(config, ledger, vaultConfig);
    for (const item of transport.contexts) {
      let key: Uint8Array | undefined;
      try {
        key = overrides.loadKey
          ? await overrides.loadKey(item)
          : await source!.load({principal: transport.principal, contextId: item.contextId, sessionId: item.sessionId, profileId: item.profileId, keyVersion: item.keyVersion, encryptionVariant: item.encryptionVariant});
        const authorize = async () => {
          const row = (await ledger.pool.query('SELECT session_id,principal_id FROM ac_session_links WHERE context_id=$1', [item.contextId])).rows[0];
          if (row?.session_id !== item.sessionId || row?.principal_id !== transport.principal) throw new Refusal('SESSION_CONTEXT_MISMATCH', 403);
        };
        const messages = await readImportTranscript(config.happier.upstreamOrigin, item.sessionId, token, key, boundary, item.encryptionVariant, authorize, {fetchPage: overrides.fetchPage});
        for (const message of messages) {
          const saved = await ledger.pool.query(
            // Keep the original time; a row imported earlier without it is corrected, nothing else changes.
            `INSERT INTO ac_personal_messages(id,context_id,role,text,local_id,accepted,created_at) VALUES($1,$2,$3,$4,$5,true,$6)
             ON CONFLICT (context_id, local_id) DO UPDATE SET created_at=EXCLUDED.created_at WHERE ac_personal_messages.created_at<>EXCLUDED.created_at
             RETURNING (xmax = 0) AS inserted`,
            [personalMessageId(item.contextId, message.id), item.contextId, message.role, message.text, message.id, message.createdAt]);
          if (saved.rows[0]?.inserted) inserted++; else existing++;
        }
      } finally { key?.fill(0); }
    }
    return {inserted, existing, contexts: transport.contexts.length};
  } finally {
    tokenBytes?.fill(0);
    await ledger.close();
  }
}

async function vaultSource(config: Installation, ledger: Ledger, vaultConfig: NonNullable<Installation['contextVault']>) {
  const identity = (await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
  if (!identity) throw new Refusal('INSTALLATION_IDENTITY_MISSING');
  const repositories = [...new Set([config.project.repo, ...config.projects.map(project => project.repo),
    ...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(row => String(row.repo))])];
  return new ContextVault(ledger, identity.id, vaultConfig.directory, vaultConfig.masterFile, repositories);
}
