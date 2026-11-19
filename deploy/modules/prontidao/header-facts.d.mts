export function passiveHeaderFacts(headers: Record<string, string | string[] | undefined>): {
  hsts: 'absent' | 'invalid' | 'insufficient' | 'adequate';
  noSniff: boolean;
  antiFrame: boolean;
};
