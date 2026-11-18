import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {openDesignBrowser} from './design-browser.ts';
import {parseDesignArgs, readDesignLoginFile, readDesignRepository, resolvePersonalDesign} from './design-command.ts';
import {runDesignModule} from './design-module.ts';

const messages: Record<string, string> = {
  DESIGN_USAGE: 'Uso: npm run personal:design -- <instalação.json> <projectId> --url <url> [--login-file <arquivo>]',
  PERSONAL_ACTIVATION_REQUIRED: 'O exame de design só roda numa instalação pessoal.',
  NOT_FOUND: 'Projeto não encontrado.',
  DESIGN_CONTEXT_REQUIRED: 'O projeto não tem um contexto para o exame.',
  DESIGN_WORKER_UNAVAILABLE: 'O runtime pessoal não está ativo.',
  DESIGN_EXTERNAL_TARGET: 'A URL tem que ficar em localhost, 127.0.0.1 ou num host .local.',
  DESIGN_TARGET_ESCAPE: 'A URL aponta para outro destino.',
  DESIGN_LOGIN_MODE: 'O arquivo de login tem que estar no modo 0600.',
  DESIGN_LOGIN_INVALID: 'O arquivo de login não tem os campos esperados.',
  DESIGN_COMMIT_INVALID: 'Não foi possível ler o commit do repositório.',
  DESIGN_PROVIDER_MUST_DIFFER: 'O revisor tem que ser outro provedor.',
  EXAM_PROVIDER_UNSUPPORTED: 'O exame de leitura só aceita uma conta Claude.',
  DESIGN_EXAM_TIMEOUT: 'O exame passou do tempo.',
  DESIGN_REPO_UNREADABLE: 'Não foi possível ler o repositório do projeto.',
  DESIGN_PASSWORD_LEAK: 'A senha de login apareceria no relatório.',
  DESIGN_BROWSER_MISSING: 'O Chrome do painel não está disponível para a captura.',
};

/** Known codes keep their Portuguese line. Anything else is one fixed sentence, so a path or secret never reaches the terminal. */
export function designCliFailureText(error: unknown): string {
  const code = error instanceof Refusal ? error.code : error instanceof Error ? error.message : '';
  return Object.hasOwn(messages, code) ? messages[code] : 'O exame de design falhou.';
}

function fail(error: unknown): never {
  console.error(designCliFailureText(error));
  process.exit(1);
  throw error instanceof Error ? error : new Error('O exame de design falhou.');
}

/** The ledger refuses a lease longer than 60s. A model call outlasts that, so renew it until the exam returns. */
export function keepPersonalDesignLease<T>(ledger: {heartbeat: (authority: T) => Promise<unknown>}, authority: T, everyMs = 5000) {
  const timer = setInterval(() => {
    void Promise.resolve(ledger.heartbeat(authority)).catch(() => undefined);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function main() {
  const parsed = parseDesignArgs(process.argv.slice(2));
  const opened = parsed.loginFile === undefined ? undefined : await readDesignLoginFile(parsed.loginFile);
  let resolved: Awaited<ReturnType<typeof resolvePersonalDesign>> | undefined;
  try {
    resolved = await resolvePersonalDesign(process.argv.slice(2));
    const stopLease = keepPersonalDesignLease(resolved.ledger, resolved.authority);
    const browser = await openDesignBrowser(parsed.url);
    const runId = randomUUID();
    try {
      const result = await runDesignModule({
        activation: 'personal',
        projectId: resolved.projectId,
        repo: resolved.repo,
        targetUrl: parsed.url,
        dataDirectory: resolved.dataDirectory,
        intentId: resolved.intentId,
        runId,
        createdAt: new Date(),
        commit: resolved.commit,
        files: await readDesignRepository(resolved.repo),
        worker: resolved.worker,
        reserve: resolved.reserve,
        release: resolved.release,
        driver: browser.driver,
        ...(opened === undefined ? {} : {login: opened.login}),
      });
      console.log(runId);
      console.log(result.directory);
    } finally {
      stopLease();
      await browser.close();
      await resolved.ledger.pool.query(
        "UPDATE ac_intents SET state='done' WHERE id=$1 AND context_id=$2 AND state='accepted'",
        [resolved.intentId, resolved.authority.contextId],
      ).catch(() => undefined);
    }
  } catch (error) {
    opened?.wipe();
    await resolved?.close();
    fail(error);
  }
  opened?.wipe();
  await resolved?.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(fail);
}
