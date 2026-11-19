import type {EventEmitter} from 'node:events';

interface RegistryRequest extends Pick<EventEmitter, 'on'> {
  destroy(): unknown;
}

interface RegistryResponse extends RegistryRequest {
  statusCode?: number;
  resume(): unknown;
}

export interface RegistryRequestOptions {
  get?: (url: string, respond: (response: RegistryResponse) => void) => RegistryRequest;
  timeoutMs?: number;
  maxBytes?: number;
}

export const NPM_REGISTRY: string;
export function fetchLatestVersion(pkg: string, options?: RegistryRequestOptions): Promise<string>;
export function fetchRegistryVersion(pkg: string, version: string, options?: RegistryRequestOptions): Promise<string | null>;
