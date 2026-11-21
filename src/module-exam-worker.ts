import type {UsageCountersValue} from './native-usage.ts';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdtemp, open} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
import {redactSecrets} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {Refusal} from './contracts.ts';
import {runnerEffort, type Effort} from './effort.ts';
import {providerFailureCode} from './exam-login.ts';
import {requestModuleExamCodex} from './module-exam-codex.ts';
import {moduleExamSocket, monitorModuleExamEgress, startModuleExamLoopback, type ModuleExamProvider} from './module-exam-egress.ts';
import {assertCodexSubscriptionIdentity} from './native-worker-security.ts';
import {claudeLimitFromText} from './quota-exhaustion.ts';

type Input = {
  jobId: string; sessionId: string; providerSubjectDigest: string; model: string; effort: Effort;
  provider: ModuleExamProvider; task: string; timeoutMs: number; oauthAccessToken?: string;
};
const maxOutput = 200_000;
const singleMarkdownJsonFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*```$/i;

type JsonContainerFrame = {kind: 'array'} | {kind: 'object'; expectKey: boolean; keys: Set<string>};

function hasDuplicateJsonKeys(jsonText: string): boolean {
  const stack: JsonContainerFrame[] = [];
  for (let i = 0; i < jsonText.length;) {
    const code = jsonText.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      i++;
      continue;
    }
    if (code === 0x7b /* { */) {
      stack.push({kind: 'object', expectKey: true, keys: new Set()});
      i++;
      continue;
    }
    if (code === 0x7d /* } */) {
      stack.pop();
      const parent = stack.at(-1);
      if (parent?.kind === 'object') parent.expectKey = false;
      i++;
      continue;
    }
    if (code === 0x5b /* [ */) {
      stack.push({kind: 'array'});
      i++;
      continue;
    }
    if (code === 0x5d /* ] */) {
      stack.pop();
      const parent = stack.at(-1);
      if (parent?.kind === 'object') parent.expectKey = false;
      i++;
      continue;
    }
    if (code === 0x2c /* , */) {
      const top = stack.at(-1);
      if (top?.kind === 'object') top.expectKey = true;
      i++;
      continue;
    }
    if (code === 0x3a /* : */) {
      const top = stack.at(-1);
      if (top?.kind === 'object') top.expectKey = false;
      i++;
      continue;
    }
    if (code === 0x22 /* " */) {
      const start = i;
      i++;
      while (i < jsonText.length) {
        const c = jsonText.charCodeAt(i);
        if (c === 0x5c /* \ */) {
          i += 2;
        } else if (c === 0x22 /* " */) {
          i++;
          break;
        } else {
          i++;
        }
      }
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.expectKey) {
        const key = JSON.parse(jsonText.slice(start, i)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      continue;
    }
    const top = stack.at(-1);
    if (top?.kind === 'object') top.expectKey = false;
    i++;
  }
  return false;
}

/** Extracts one JSON object from bare text or a single Markdown fence on its own lines, rejecting duplicate keys. */
export function parseModuleExamJsonObject(raw: string): {text: string; value: unknown} | null {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  if (candidate.startsWith('```')) {
    const match = singleMarkdownJsonFence.exec(candidate);
    if (!match?.[1]) return null;
    candidate = match[1].trim();
  }
  if (!candidate.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(candidate);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (hasDuplicateJsonKeys(candidate)) return null;
    return {text: candidate, value};
  } catch {
    return null;
  }
}

export function moduleExamClaudeArgs(input: Pick<Input, 'model' | 'effort'>): string[] {
  return [
    '--print', '--output-format', 'stream-json', '--verbose', '--model', input.model, '--effort', runnerEffort('claude', input.effort),
    '--tools', '', '--disallowedTools', '*', '--disable-slash-commands', '--setting-sources', 'user',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableClaudeAiConnectors":true,"disableAllHooks":true}',
    '--permission-mode', 'dontAsk', '--no-session-persistence',
  ];
}

const ClaudeEvent = z.object({
  type: z.string(), subtype: z.string().optional(), model: z.string().optional(),
  tools: z.array(z.unknown()).optional(), mcp_servers: z.array(z.unknown()).optional(),
  message: z.object({model: z.string().optional(), content: z.array(z.object({type: z.string()})).optional()}).optional(),
  result: z.string().optional(), is_error: z.boolean().optional(), errors: z.array(z.string()).optional(),
});

export function readModuleExamClaudeOutput(stdout: string, model: string) {
  let safe = true, initialized = false, output: string | undefined;
  const diagnostics: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { safe = false; continue; }
    const parsed = ClaudeEvent.safeParse(value);
    if (!parsed.success) { safe = false; continue; }
    const event = parsed.data;
    if (event.type === 'system' && event.subtype === 'init') {
      if (initialized || event.model !== model || event.tools?.length !== 0 || event.mcp_servers?.length !== 0) safe = false;
      initialized = true;
    }
    if (event.type === 'assistant') {
      if ((event.message?.model && event.message.model !== model)
        || event.message?.content?.some(block => block.type === 'tool_use' || block.type === 'server_tool_use')) safe = false;
    }
    if (event.type === 'result') {
      if (event.subtype === 'success' && event.is_error === false) output = event.result;
      else diagnostics.push(event.result ?? '', ...(event.errors ?? []));
    }
  }
  return {output: safe && initialized ? output ?? '' : '', diagnostics,
    succeeded: safe && initialized && output !== undefined};
}

/** Only result.usage is cumulative across Claude's calls. Missing fields stay unknown. */
export function readModuleExamClaudeUsage(stdout:string):UsageCountersValue|null {
 let result:UsageCountersValue|null=null;
 const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
 for(const line of stdout.split('\n')){
  try{
   const event=JSON.parse(line);if(event?.type!=='result'||!event.usage||typeof event.usage!=='object')continue;
   const u=event.usage,read=count(u.cache_read_input_tokens),write=count(u.cache_creation_input_tokens);
   result={input:count(u.input_tokens),output:count(u.output_tokens),cache:read!==null&&write!==null&&Number.isSafeInteger(read+write)?read+write:null,reasoning:null};
  }catch{/* malformed output is rejected by the normal protocol validation */}
 }
 return result;
}

async function claudeText(input: Input, signal: AbortSignal, cwd: string) {
  const child = spawn('/usr/local/bin/claude', moduleExamClaudeArgs(input), {
    cwd, signal, env: {
      ...process.env, CLAUDE_CODE_OAUTH_TOKEN: input.oauthAccessToken,
      DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const receive = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > maxOutput) child.kill('SIGKILL');
  };
  child.stdout.setEncoding('utf8').on('data', chunk => receive(chunk, 'stdout'));
  child.stderr.setEncoding('utf8').on('data', chunk => receive(chunk, 'stderr'));
  child.stdin.on('error', () => undefined);
  child.stdin.end(input.task);
  const status = await new Promise<number | null>(resolve => {
    child.once('close', resolve);
    child.once('error', () => resolve(null));
  });
  const result = readModuleExamClaudeOutput(stdout, input.model);
  return {...result, counters:readModuleExamClaudeUsage(stdout), diagnostics: [...result.diagnostics, stderr],
    succeeded: result.succeeded && status === 0 && stdout.length + stderr.length <= maxOutput};
}

/** Some CLI versions return a standalone terminal notice through their success channel. */
export function isModuleExamTerminalNotice(text: string): boolean {
  return /^(?:you(?:['’]ve)? hit your usage limit(?:[.!]? (?:try again|resets?) at [0-9:apm -]+(?:UTC|GMT)?)?|(?:claude(?: ai)? )?usage limit reached(?:\s*\|\s*\d{9,16})?|usage_limit_reached|failed to authenticate(?:: (?:access |refresh |oauth )?token (?:has )?expired)?|oauth session expired|PROVIDER_AUTH_FAILED)[.!]?$/i.test(text.trim());
}

export function resolveModuleExamClaudeResult(
  response: {succeeded: boolean; output: string; diagnostics: string[]},
  secrets: string[],
): {output: string; failureCode: string | null; usageWindows: UsageWindowsObservation | null} {
  const redactedOutput = redactSecrets(response.output.trim(), secrets);
  const parsed = response.succeeded ? parseModuleExamJsonObject(redactedOutput) : null;
  const diagnostics = response.succeeded && isModuleExamTerminalNotice(response.output)
    ? [...response.diagnostics, response.output] : response.diagnostics;
  const limit = claudeLimitFromText(diagnostics);
  if (response.succeeded && !limit && !diagnostics.some(providerFailureCode)) {
    return {output: parsed?.text ?? redactedOutput, failureCode: null, usageWindows: null};
  }
  return {
    output: '',
    failureCode: limit?.failureCode ?? diagnostics.map(providerFailureCode).find(Boolean) ?? 'MODULE_EXAM_PROVIDER_FAILED',
    usageWindows: limit?.usageWindows ?? null,
  };
}

export async function runModuleExamWorker(input: Input) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const timeout = setTimeout(stop, input.timeoutMs);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let output = '', failureCode: string | null = null, usageWindows: UsageWindowsObservation | null = null;
  let usageCounters:UsageCountersValue|null=null;
  let closeProxy: (() => void) | undefined;
  let closeMonitor: (() => void) | undefined;
  try {
    closeMonitor = await monitorModuleExamEgress(moduleExamSocket, stop);
    if (abort.signal.aborted) throw new Refusal('MODULE_EXAM_INTERRUPTED');
    if (input.provider === 'codex') {
      const account = await assertCodexSubscriptionIdentity(input.providerSubjectDigest);
      const response = await requestModuleExamCodex({...input, accountId: account.accountId,
        accessToken: account.accessToken, signal: abort.signal, onUsage: counters => { usageCounters = counters; }});
      if (Buffer.byteLength(response) > maxOutput) throw new Refusal('MODULE_EXAM_RESPONSE_INVALID');
      output = redactSecrets(response.trim(), account.secrets);
    } else {
      if (!input.oauthAccessToken) throw new Refusal('EXAM_LOGIN_STALE');
      const home = await mkdtemp('/tmp/ac-module-exam-');
      process.env.HOME = home;
      process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
      const proxy = await startModuleExamLoopback();
      closeProxy = proxy.close;
      Object.assign(process.env, {HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url});
      if (abort.signal.aborted) throw new Refusal('MODULE_EXAM_INTERRUPTED');
      const response = await claudeText(input, abort.signal, '/planning');
      ({output, failureCode, usageWindows} = resolveModuleExamClaudeResult(response, [input.oauthAccessToken]));
      usageCounters=response.counters;
    }
  } catch (error) {
    failureCode = abort.signal.aborted ? 'MODULE_EXAM_INTERRUPTED'
      : error instanceof Refusal ? error.code : 'MODULE_EXAM_WORKER_FAILED';
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    closeProxy?.();
    closeMonitor?.();
  }
  const exitCode = failureCode ? 1 : 0;
  const result = await open('/output/execution-result.json', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await result.writeFile(JSON.stringify({schemaVersion: 1, jobId: input.jobId, output, normalizedTokensUsed: null,
      usageCounters, usageWindows, nativeSessionId: null, failureCode, exitCode}));
    await result.sync();
  } finally { await result.close(); }
  process.exit(exitCode);
}
