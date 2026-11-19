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

export function moduleExamClaudeArgs(input: Pick<Input, 'model' | 'effort'>): string[] {
  return [
    '--print', '--output-format', 'stream-json', '--verbose', '--model', input.model, '--effort', runnerEffort('claude', input.effort),
    '--tools', '', '--disallowedTools', '*', '--disable-slash-commands', '--setting-sources', 'user',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableClaudeAiConnectors":true}',
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
  return {...result, diagnostics: [...result.diagnostics, stderr],
    succeeded: result.succeeded && status === 0 && stdout.length + stderr.length <= maxOutput};
}

export async function runModuleExamWorker(input: Input) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  const timeout = setTimeout(stop, input.timeoutMs);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let output = '', failureCode: string | null = null, usageWindows: UsageWindowsObservation | null = null;
  let closeProxy: (() => void) | undefined;
  let closeMonitor: (() => void) | undefined;
  try {
    closeMonitor = await monitorModuleExamEgress(moduleExamSocket, stop);
    if (abort.signal.aborted) throw new Refusal('MODULE_EXAM_INTERRUPTED');
    if (input.provider === 'codex') {
      const account = await assertCodexSubscriptionIdentity(input.providerSubjectDigest);
      const response = await requestModuleExamCodex({...input, accountId: account.accountId,
        accessToken: account.accessToken, signal: abort.signal});
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
      const nonJson = response.succeeded && !response.output.trimStart().startsWith('{');
      const diagnostics = nonJson ? [...response.diagnostics, response.output.slice(-4000)] : response.diagnostics;
      const limit = claudeLimitFromText(diagnostics);
      if (response.succeeded && !limit && !diagnostics.some(providerFailureCode)) {
        output = redactSecrets(response.output.trim(), [input.oauthAccessToken]);
      } else {
        failureCode = limit?.failureCode ?? diagnostics.map(providerFailureCode).find(Boolean) ?? 'MODULE_EXAM_PROVIDER_FAILED';
        usageWindows = limit?.usageWindows ?? null;
      }
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
      usageWindows, nativeSessionId: null, failureCode, exitCode}));
    await result.sync();
  } finally { await result.close(); }
  process.exit(exitCode);
}
