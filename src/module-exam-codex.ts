import {request as httpRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {connect as connectTls, type TLSSocket} from 'node:tls';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {runnerEffort, type Effort} from './effort.ts';
import {moduleExamSocket} from './module-exam-egress.ts';
import {codexLimitFromText} from './quota-exhaustion.ts';

const host = 'chatgpt.com';
const maxResponseBytes = 1024 * 1024;

export function moduleExamCodexBody(model: string, effort: Effort, task: string) {
  return {
    model, reasoning: {effort: runnerEffort('codex', effort)}, store: false, stream: true,
    instructions: 'Reply with exactly one JSON object. Use only the supplied passive evidence.',
    input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: task}]}],
    tools: [], tool_choice: 'none', parallel_tool_calls: false,
  };
}

const TextItem = z.object({type: z.literal('message'), role: z.literal('assistant'),
  content: z.array(z.object({type: z.literal('output_text'), text: z.string()})).min(1)});
const Event = z.object({type: z.string(), response: z.unknown().optional(), item: z.unknown().optional()});
const OutputItemType = z.object({type: z.enum(['message', 'reasoning'])});
const ReasoningItem = z.object({type: z.literal('reasoning')});
const Completed = z.object({
  model: z.string(), status: z.literal('completed'),
  output: z.array(z.union([TextItem, ReasoningItem])).min(1),
});

/** A text turn has only assistant text and reasoning items. The adapter has
 * no dispatcher and rejects unexpected output item types or model identity. */
export function readModuleExamCodexOutput(stream: string, model: string, onUsage?: (usage: {input:number|null;output:number|null;cache:number|null;reasoning:number|null})=>void): string {
  let output: string | undefined;
  for (const frame of stream.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event: unknown;
    try { event = JSON.parse(data); } catch { throw new Refusal('MODULE_EXAM_RESPONSE_INVALID'); }
    const parsed = Event.safeParse(event);
    if (!parsed.success) throw new Refusal('MODULE_EXAM_RESPONSE_INVALID');
    const {type, item, response} = parsed.data;
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const itemType = OutputItemType.safeParse(item);
      if (!itemType.success) throw new Refusal('MODULE_EXAM_RESPONSE_INVALID');
    }
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      if (codexLimitFromText([data])) throw new Refusal('PROVIDER_USAGE_LIMIT');
      throw new Refusal('MODULE_EXAM_PROVIDER_FAILED');
    }
    if (type !== 'response.completed') continue;
    const completed = Completed.safeParse(response);
    if (output !== undefined || !completed.success || completed.data.model !== model) throw new Refusal('MODULE_EXAM_RESPONSE_INVALID');
    const usage = (response as {usage?: any}).usage;
    if (usage && typeof usage === 'object') {
      const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
      onUsage?.({input:count(usage.input_tokens),output:count(usage.output_tokens),cache:count(usage.input_tokens_details?.cached_tokens),reasoning:count(usage.output_tokens_details?.reasoning_tokens)});
    }
    output = completed.data.output.flatMap(entry => entry.type === 'message' ? entry.content.map(part => part.text) : []).join('');
  }
  if (!output?.trim()) throw new Refusal('MODULE_EXAM_RESPONSE_INVALID');
  return output;
}

function codexTunnel(signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const connect = httpRequest({socketPath: moduleExamSocket, method: 'CONNECT', path: host + ':443',
      headers: {Host: host + ':443'}, signal, agent: false});
    const fail = () => reject(new Refusal('MODULE_EXAM_EGRESS_UNAVAILABLE'));
    connect.once('error', fail);
    connect.once('response', response => { response.destroy(); fail(); });
    connect.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length || signal.aborted) { socket.destroy(); fail(); return; }
      // TLS verification stays in the worker. The controller relays encrypted bytes.
      const tls = connectTls({socket, servername: host, rejectUnauthorized: true});
      const abort = () => tls.destroy();
      signal.addEventListener('abort', abort, {once: true});
      tls.once('error', fail);
      tls.once('close', () => { signal.removeEventListener('abort', abort); fail(); });
      tls.once('secureConnect', () => resolve(tls));
    });
    connect.end();
  });
}

export function readModuleExamCodexResponse(response: IncomingMessage, model: string, onUsage?: Parameters<typeof readModuleExamCodexOutput>[2]): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = (code: string) => reject(new Refusal(code));
    if (response.statusCode === 429) {
      fail('PROVIDER_USAGE_LIMIT');
      response.destroy();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    response.on('error', () => fail('MODULE_EXAM_PROVIDER_FAILED'));
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxResponseBytes) { fail('MODULE_EXAM_RESPONSE_INVALID'); response.destroy(); return; }
      chunks.push(chunk);
    });
    response.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode !== 200 && codexLimitFromText([text])) { fail('PROVIDER_USAGE_LIMIT'); return; }
      if (response.statusCode === 401 || response.statusCode === 403) { fail('PROVIDER_AUTH_FAILED'); return; }
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) {
        fail('MODULE_EXAM_PROVIDER_FAILED');
        return;
      }
      try { resolve(readModuleExamCodexOutput(text, model, onUsage)); }
      catch (error) { reject(error); }
    });
  });
}

export async function requestModuleExamCodex(input: {
  accountId: string; accessToken: string; model: string; effort: Effort; task: string; sessionId: string; signal: AbortSignal; onUsage?: Parameters<typeof readModuleExamCodexOutput>[2];
}): Promise<string> {
  const body = JSON.stringify(moduleExamCodexBody(input.model, input.effort, input.task));
  const socket = await codexTunnel(input.signal);
  try {
    return await new Promise<string>((resolve, reject) => {
      const req = httpsRequest({hostname: host, path: '/backend-api/codex/responses', method: 'POST',
        createConnection: () => socket, signal: input.signal, headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'text/event-stream',
          Authorization: 'Bearer ' + input.accessToken, 'ChatGPT-Account-ID': input.accountId, session_id: input.sessionId,
        }}, response => { void readModuleExamCodexResponse(response, input.model, input.onUsage).then(resolve, reject); });
      req.once('error', () => reject(new Refusal('MODULE_EXAM_PROVIDER_FAILED')));
      req.end(body);
    });
  } finally { socket.destroy(); }
}
