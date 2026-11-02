// Version-pinned boundary around existing Happier implementations; see upstream/PROVENANCE.json.
export { encrypt, decrypt, encodeBase64, decodeBase64 } from '../upstream/happier/apps/cli/src/api/encryption.ts';
export { createSessionSocketTransport } from '../upstream/happier/apps/cli/src/api/session/connection/createSessionSocketTransport.ts';
export { RpcHandlerManager } from '../upstream/happier/apps/cli/src/api/rpc/RpcHandlerManager.ts';
export { registerSessionUserMessageSendHandler } from '../upstream/happier/apps/cli/src/rpc/handlers/sessionUserMessageSend.ts';
export { materializeNextPendingQueueV2Message, resolveAcceptedPendingQueueV2Delivery, markPendingQueueV2DeliveryHandled } from '../upstream/happier/apps/cli/src/api/session/pendingQueueV2Transport.ts';
export { SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, SessionRuntimeActivitySnapshotRequestSchema, SessionRuntimeActivitySnapshotAckSchema } from '../upstream/happier/packages/protocol/src/sessionRuntimeActivity/transport.ts';
