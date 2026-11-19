export interface VerifyDependenciasLockResult {
  ok: true;
  packageLockSha256: string;
  offlineRegistrySha256: string;
  toolCount: number;
  totalLockedPackages: number;
}

export function verifyDependenciasLock(root?: string): VerifyDependenciasLockResult;
