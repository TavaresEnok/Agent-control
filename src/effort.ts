import {z} from 'zod';

/** Profile and policy effort. Adapters map this before a provider CLI sees it. */
export const Effort=z.enum(['low','medium','high','xhigh','max']);
export type Effort=z.infer<typeof Effort>;

/**
 * Value the provider CLI accepts.
 * Claude keeps xhigh and max (`claude --effort`).
 * Grok and Codex accept only low, medium, and high, so xhigh and max become high.
 */
export function cliEffort(provider:string,effort:Effort):Effort{
 if(provider==='claude')return effort;
 if(effort==='xhigh'||effort==='max')return 'high';
 return effort;
}

/** AgentRunSpec.reasoningEffort is typed low|medium|high. Claude may still carry xhigh or max at runtime. */
export function runnerEffort(provider:string,effort:Effort):'low'|'medium'|'high'{
 return cliEffort(provider,effort) as 'low'|'medium'|'high';
}
