import {spawn} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync} from 'node:fs';
import {request} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isJsonContentType, matchesExample, maxBodyBytes} from './examples.mjs';

export const startupMs = 3000;
export const exchangeMs = 2000;
const runner = fileURLToPath(new URL('./provider.mjs', import.meta.url));

function waitUntilReady(child, timeout) {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), timeout);
    function finish(ready) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(ready);
    }
    const onMessage = message => finish(message === 'ready');
    const onExit = () => finish(false);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onExit);
  });
}

function exchange(socketPath, scenario, exactLeaves, timeout) {
  return new Promise(resolve => {
    const {method, target, body, charset} = scenario.request;
    const expected = scenario.expected;
    const unavailable = () => resolve({error: 'troca HTTP interrompida ou fora do prazo'});
    const req = request({
      socketPath, method, path: target, agent: false, signal: AbortSignal.timeout(timeout),
      headers: {accept: 'application/json', ...(body === undefined ? {} : {
        'content-type': charset ? 'application/json; charset=utf-8' : 'application/json',
        'content-length': Buffer.byteLength(body),
      })},
    }, res => {
      const status = res.statusCode;
      const finish = problem => {
        resolve({status, problem});
        res.destroy();
      };
      res.once('error', unavailable);
      if (status !== expected.status) return finish('código HTTP diferente do exemplo');
      const contentType = res.headers['content-type'];
      if (!isJsonContentType(contentType)) return finish('tipo de conteúdo diferente de JSON');
      if (expected.charset && !contentType.includes(';')) return finish('charset UTF-8 declarado pelo Pact ausente');
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          resolve({error: 'resposta acima do limite de 64 KiB'});
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () => {
        let actual;
        try {
          actual = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
        } catch {
          return finish('resposta sem JSON válido em UTF-8');
        }
        const mismatch = exactLeaves ? 'conteúdo JSON não corresponde à interação Pact' : 'estrutura JSON diferente do exemplo';
        finish(matchesExample(actual, expected.value, exactLeaves) ? undefined : mismatch);
      });
    });
    req.once('error', unavailable);
    req.end(body);
  });
}

export async function runProvider({workspace, workRoot, adapter, cases, exactLeaves, deadline}) {
  let scratch;
  let child;
  let closed;
  try {
    scratch = mkdtempSync(join(workRoot, 'contract-'));
    const cwd = join(scratch, 'component');
    const socket = join(scratch, 'http.sock');
    cpSync(workspace, cwd, {recursive: true});
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    if (!remaining()) return {skipped: 'orçamento de tempo da medição esgotado'};
    child = spawn(process.execPath, [runner, adapter, socket], {
      cwd, detached: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: scratch, LANG: 'C.UTF-8', TZ: 'UTC'},
    });
    closed = new Promise(resolve => child.once('close', resolve));
    if (!await waitUntilReady(child, Math.min(startupMs, remaining()))) {
      return {error: 'adaptador local não iniciou no prazo ou não exporta o handler HTTP'};
    }
    const results = [];
    for (const scenario of cases) {
      if (!remaining()) {
        results.push({skipped: 'orçamento de tempo da medição esgotado'});
        continue;
      }
      results.push(await exchange(socket, scenario, exactLeaves, Math.min(exchangeMs, remaining())));
    }
    return {results};
  } catch {
    return {error: 'falha operacional ao preparar ou executar o adaptador local'};
  } finally {
    try {
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await closed;
    } finally {
      if (scratch) rmSync(scratch, {recursive: true, force: true});
    }
  }
}
