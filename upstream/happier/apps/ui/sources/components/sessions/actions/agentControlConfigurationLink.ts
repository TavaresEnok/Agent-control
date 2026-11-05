export const AGENT_CONTROL_CONFIGURATION_ACTION = 'agent-control.configuration.open';

/** Build-owned control origin only: conversation/model metadata never chooses it. */
export function agentControlConfigurationLink(origin: string | undefined, sessionId: string): string | null {
    if (!origin || !sessionId || sessionId.length > 200 || /[\x00-\x20\x7f]/.test(sessionId)) return null;
    try {
        const target = new URL(origin);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
        if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback))
            || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return null;
        target.pathname = '/settings/agent-control';
        target.searchParams.set('acSession', sessionId);
        return target.href;
    } catch {
        return null;
    }
}
