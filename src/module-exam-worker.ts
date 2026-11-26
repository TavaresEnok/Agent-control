import type {UsageCountersValue} from './native-usage.ts';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir, mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
import {redactSecrets} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {Refusal} from './contracts.ts';
import {runnerEffort, type Effort} from './effort.ts';
import {examLoginNeedsRefresh, providerFailureCode} from './exam-login.ts';
import {requestModuleExamCodex} from './module-exam-codex.ts';
import {moduleExamSocket, monitorModuleExamEgress, startModuleExamLoopback, type ModuleExamProvider} from './module-exam-egress.ts';
import {assertCodexSubscriptionIdentity, readGrokLogin} from './native-worker-security.ts';
import {claudeLimitFromText} from './quota-exhaustion.ts';

type Input = {
  jobId: string; sessionId: string; providerSubjectDigest: string; model: string; effort: Effort;
  provider: ModuleExamProvider; task: string; timeoutMs: number; oauthAccessToken?: string; moduleExamLoginDigest?: string;
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

/** Grok answers from the request alone: no tools, subagents or web search, plan mode, one turn, structured JSON. */
export function moduleExamGrokArgs(input: Pick<Input, 'model' | 'effort'>, promptFile: string, cwd: string): string[] {
  return [
    '--model', input.model, '--reasoning-effort', runnerEffort('grok', input.effort), '--cwd', cwd,
    '--tools', '', '--permission-mode', 'plan', '--disable-web-search', '--no-subagents', '--max-turns', '1',
    '--output-format', 'json', '--json-schema', '{"type":"object"}', '--prompt-file', promptFile,
  ];
}

/** Said first to the Grok reviewer: the evidence is in the request, and a plan-mode reach for the network cancels the turn. */
export const MODULE_EXAM_GROK_PREAMBLE = 'Decida só pelo código e pelas evidências deste pedido. Não há ferramentas, arquivos nem internet: '
  + 'não tente abrir, buscar ou executar nada. Responda uma única vez com o objeto JSON pedido.\n\n';

const GrokResult = z.object({
  text: z.string().optional(), stopReason: z.string(), num_turns: z.number().int().optional(),
  structuredOutput: z.unknown().optional(),
  usage: z.object({input_tokens: z.unknown(), output_tokens: z.unknown(), cache_read_input_tokens: z.unknown(),
    cache_creation_input_tokens: z.unknown(), reasoning_tokens: z.unknown()}).partial().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** `modelUsage` names the reserved model or its `-build` serving name, as Grok 1.0.70 reported `grok-4.7-build` for grok-4.7 (the reserved model is now `grok-4.6`). */
export function isModuleExamGrokModel(name: string, model: string): boolean {
  return name === model || name === model + '-build';
}

export type ModuleExamGrokResponse = {succeeded: boolean; output: string;
  /** Messages of the CLI's own `{"type":"error"}` document: the only text a failure code is read from. */
  errors: string[];
  /** Stop reason and stderr tail, for the log only. */
  diagnostics: string[]; counters: UsageCountersValue | null};

/** One JSON document from `grok --output-format json`. Only a single-turn `end_turn` of the reserved model counts:
 * a second turn would mean a tool round trip, and `cancelled` is the plan-mode stop on a network attempt.
 * The verdict is the answer `text`, read with the duplicate-key check, and it must equal `structuredOutput`. */
export function readModuleExamGrokOutput(stdout: string, model: string): ModuleExamGrokResponse {
  const refused = (diagnostics: string[] = [], errors: string[] = []) => ({succeeded: false, output: '', errors, diagnostics, counters: null});
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return refused([stdout.slice(0, 2000)]); }
  const failure = z.object({type: z.literal('error'), message: z.string()}).safeParse(value);
  if (failure.success) return refused([], [failure.data.message]);
  const parsed = GrokResult.safeParse(value);
  if (!parsed.success) return refused();
  const result = parsed.data;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const u = result.usage, read = count(u?.cache_read_input_tokens), write = count(u?.cache_creation_input_tokens);
  const counters = u ? {input: count(u.input_tokens), output: count(u.output_tokens),
    cache: read !== null && write !== null ? read + write : null, reasoning: count(u.reasoning_tokens)} : null;
  const models = Object.keys(result.modelUsage ?? {});
  const sameModel = models.length > 0 && models.every(name => isModuleExamGrokModel(name, model));
  const answer = parseModuleExamJsonObject(result.text ?? '');
  const agrees = answer !== null && (result.structuredOutput === undefined || isDeepStrictEqual(answer.value, result.structuredOutput));
  const succeeded = result.stopReason === 'end_turn' && result.num_turns === 1 && sameModel && agrees;
  return {succeeded, output: succeeded ? answer!.text : '', errors: [], diagnostics: succeeded ? [] : [result.stopReason], counters};
}

const GROK_LIMIT = /\b(?:usage|rate)[ _-]?limit\b|\b429\b|\btoo many requests\b|\bout of credits\b|\bquota (?:exceeded|reached)\b/i;
const GROK_AUTH = /^not signed in\b|\bunauthori[sz]ed\b|\b401\b|\btoken (?:has )?expired\b/i;

export function resolveModuleExamGrokResult(
  response: Pick<ModuleExamGrokResponse, 'succeeded' | 'output' | 'errors'>,
  secrets: string[],
): {output: string; failureCode: string | null} {
  if (response.succeeded) {
    const redacted = redactSecrets(response.output.trim(), secrets);
    return {output: parseModuleExamJsonObject(redacted)?.text ?? redacted, failureCode: null};
  }
  // Only the CLI's structured error is classified: a log line on stderr never turns a failure into a quota stop.
  const text = response.errors.join('\n');
  const failureCode = !text ? 'MODULE_EXAM_PROVIDER_FAILED'
    : GROK_LIMIT.test(text) ? 'PROVIDER_USAGE_LIMIT'
      : GROK_AUTH.test(text) ? 'PROVIDER_AUTH_FAILED'
        : providerFailureCode(text) ?? 'MODULE_EXAM_PROVIDER_FAILED';
  return {output: '', failureCode};
}

export type ModuleExamGrokPaths = {bin: string; accountRoot: string; tmpRoot: string};
const grokPaths: ModuleExamGrokPaths = {bin: '/usr/local/bin/grok', accountRoot: '/account', tmpRoot: '/tmp'};

/** Runs the Grok reviewer on the read-only login mounted under `accountRoot`, which must be the login the supervisor
 * checked (`moduleExamLoginDigest`). The login is copied into a private home removed afterwards. Refresh is not
 * possible, since the login hosts stay closed, so a login near expiry is stale before the CLI runs. The child gets
 * only PATH, the private HOME and the loopback proxy, runs in an empty directory and reads the request from a file. */
export async function runModuleExamGrok(input: Pick<Input, 'model' | 'effort' | 'task' | 'timeoutMs' | 'moduleExamLoginDigest'>,
  signal: AbortSignal, paths: ModuleExamGrokPaths = grokPaths) {
  const login = await readGrokLogin(paths.accountRoot);
  let home: string | undefined, empty: string | undefined;
  try {
    if (!input.moduleExamLoginDigest || input.moduleExamLoginDigest !== login.digest) throw new Refusal('EXAM_LOGIN_STALE');
    if (examLoginNeedsRefresh(login.expiresAt, Date.now(), input.timeoutMs)) throw new Refusal('EXAM_LOGIN_STALE');
    home = await mkdtemp(join(paths.tmpRoot, 'ac-module-exam-'));
    await mkdir(join(home, '.grok'), {mode: 0o700});
    await writeFile(join(home, '.grok', 'auth.json'), login.bytes, {mode: 0o600, flag: 'wx'});
    empty = await mkdtemp(join(paths.tmpRoot, 'ac-module-exam-cwd-'));
    const promptFile = join(home, 'pedido.txt');
    await writeFile(promptFile, MODULE_EXAM_GROK_PREAMBLE + input.task, {mode: 0o600, flag: 'wx'});
    const env: Record<string, string> = {HOME: home, NO_COLOR: '1'};
    for (const name of ['PATH', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    const child = spawn(paths.bin, moduleExamGrokArgs(input, promptFile, empty), {cwd: empty, signal, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', overflow = false;
    const receive = (chunk: string, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > maxOutput) { overflow = true; child.kill('SIGKILL'); }
    };
    child.stdout.setEncoding('utf8').on('data', chunk => receive(chunk, 'stdout'));
    child.stderr.setEncoding('utf8').on('data', chunk => receive(chunk, 'stderr'));
    const status = await new Promise<number | null>(resolve => {
      child.once('close', resolve);
      child.once('error', () => resolve(null));
    });
    if (signal.aborted) throw new Refusal('MODULE_EXAM_INTERRUPTED');
    const result = readModuleExamGrokOutput(stdout, input.model);
    return {response: {...result, diagnostics: [...result.diagnostics, stderr.slice(-4000)],
      succeeded: result.succeeded && status === 0 && !overflow}, secrets: login.secrets};
  } finally {
    login.bytes.fill(0);
    for (const dir of [home, empty]) if (dir) await rm(dir, {recursive: true, force: true});
  }
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
    } else if (input.provider === 'grok') {
      const proxy = await startModuleExamLoopback();
      closeProxy = proxy.close;
      Object.assign(process.env, {HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url});
      if (abort.signal.aborted) throw new Refusal('MODULE_EXAM_INTERRUPTED');
      const {response, secrets} = await runModuleExamGrok(input, abort.signal);
      ({output, failureCode} = resolveModuleExamGrokResult(response, secrets));
      usageCounters = response.counters;
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
