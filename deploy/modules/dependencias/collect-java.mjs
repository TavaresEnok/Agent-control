import {isUtf8} from 'node:buffer';
import {execFile as execFileCb} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import lock from './openrewrite/lock.json' with {type: 'json'};

const execFile = promisify(execFileCb);
const RECIPE = 'charset-standard-utf8';
const REPLACEMENT = 'java.nio.charset.StandardCharsets.UTF_8';
const TOOL_TIMEOUT_MS = 120_000;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const JAVA_SOURCE_LIMITS = {files: 512, fileBytes: 512 * 1024, totalBytes: 32 * 1024 * 1024};

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function readJavaSource(root, rel, remainingBytes, readArtifact) {
  const parts = rel.split('/');
  const filename = parts.pop();
  const directories = [];
  let parent = root;
  // Resolve each component from an already open directory, refusing symlinks during the copy.
  try {
    for (const part of parts) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, DIRECTORY_FLAGS);
      directories.push(parent);
    }
    return await readArtifact(`/proc/self/fd/${parent.fd}/${filename}`, JAVA_SOURCE_LIMITS.fileBytes, remainingBytes, true);
  } catch {
    return {kind: 'unreadable'};
  } finally {
    for (const directory of directories.reverse()) await directory.close();
  }
}

async function verifyEdits(record, copy) {
  const source = await readFile(copy, 'utf8');
  if (record.edits.length > 32 || sha256(source) !== record.beforeSha256) throw new Error('Origem divergente');

  const parts = [];
  const edits = [];
  let end = 0;
  for (const {start, before} of record.edits) {
    if (!Number.isSafeInteger(start) || start < end || typeof before !== 'string' || !before.length
      || before.length > 256 || source.slice(start, start + before.length) !== before) {
      throw new Error('Edição fora da origem');
    }
    parts.push(source.slice(end, start), REPLACEMENT);
    edits.push({start, before, after: REPLACEMENT});
    end = start + before.length;
  }
  parts.push(source.slice(end));
  if (sha256(parts.join('')) !== record.afterSha256) throw new Error('Resultado divergente');

  const line = source.slice(0, edits[0].start).split(/\r\n|\r|\n/).length;
  const evidence = JSON.stringify({offsets: 'utf16', beforeSha256: record.beforeSha256, afterSha256: record.afterSha256, edits});
  return {line, evidence};
}

export async function runOpenRewriteCheck({repoRoot, workRoot, runtime, files, detected, skipped, readArtifact}) {
  const tool = {tool: 'openrewrite', version: 'nao-executada'};
  const coverage = [];
  const findings = [];
  if (!files.length) {
    const detail = detected
      ? `Projeto Java sem fontes elegíveis; fontes_ignoradas=${skipped}; prova_parcial=true.`
      : 'Nenhuma fonte ou manifesto Java detectado.';
    return {coverage: [{...tool, status: 'skipped', detail}], findings};
  }

  const cwd = join(workRoot, 'java');
  const sources = join(cwd, 'sources');
  const staged = new Map();
  let failures = 0;
  let omissions = skipped;
  let bytesLeft = JAVA_SOURCE_LIMITS.totalBytes;
  let version = tool.version;
  let phase = 'copia_java';
  const issues = [];
  try {
    await mkdir(sources, {recursive: true});
    const root = await open(repoRoot, DIRECTORY_FLAGS);
    try {
      for (const {rel} of files) {
        const source = await readJavaSource(root, rel, bytesLeft, readArtifact);
        if (source.kind !== 'ok') {
          const limited = source.kind === 'fileLimit' || source.kind === 'totalLimit';
          if (limited) omissions++;
          else failures++;
          issues.push({status: limited ? 'skipped' : 'failed', detail: `arquivo=${rel}; motivo=copia_${source.kind}; prova_parcial=true`});
          continue;
        }
        if (!isUtf8(source.content) || source.content.includes(0)) {
          omissions++;
          issues.push({status: 'skipped', detail: `arquivo=${rel}; motivo=fonte_fora_do_formato_UTF-8; prova_parcial=true`});
          continue;
        }
        bytesLeft -= source.bytes;
        const id = String(staged.size).padStart(4, '0');
        const dir = join(sources, id);
        const copy = join(dir, basename(rel));
        await mkdir(dir);
        await writeFile(copy, source.content, {flag: 'wx'});
        staged.set(id, {rel, copy});
      }
    } finally {
      await root.close();
    }

    if (staged.size) {
      phase = 'execucao_java';
      version = 'desconhecida';
      const home = resolve(runtime);
      const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
      let stdout;
      let executionError;
      try {
        ({stdout} = await execFile(join(home, 'jdk', 'bin', 'java'), [
          '-Xmx256m', '-XX:ActiveProcessorCount=2', '-XX:-UsePerfData',
          `-Duser.home=${cwd}`, `-Djava.io.tmpdir=${cwd}`, '-Dfile.encoding=UTF-8',
          '-cp', `${join(home, 'classes')}:${join(home, 'lib', '*')}`, 'OfflineRewrite',
        ], {
          cwd, env: {HOME: cwd, TMPDIR: cwd, LANG: 'C.UTF-8', TZ: 'UTC'},
          signal: timeout, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024,
        }));
      } catch (error) {
        stdout = error.stdout;
        executionError = timeout.aborted ? 'timeout' : error.code || error.signal || 'processo';
      }
      const [header, ...rows] = stdout?.trimEnd().split('\n') ?? [];
      // A JVM or class-loading failure can precede the version handshake.
      if (header) {
        phase = 'versao_java';
        const metadata = JSON.parse(header);
        if (metadata.version !== lock.openrewriteVersion || metadata.jdk !== lock.jdk.version) throw new Error('Versão divergente');
        version = metadata.version;
      }
      if (executionError) {
        return {coverage: [{...tool, version, status: 'failed',
          detail: `Falha ao executar OpenRewrite (${executionError}); esperado=${lock.openrewriteVersion}; prova_parcial=true.`}], findings};
      }

      phase = 'relatorio_java';
      if (!header || rows.length !== staged.size) throw new Error('Relatório incompleto');
      let evidenceBytes = 0;
      for (const row of rows) {
        const record = JSON.parse(row);
        const source = staged.get(record.file);
        if (!source || !Number.isSafeInteger(record.unproven) || record.unproven < 0 || !Array.isArray(record.edits)) {
          throw new Error('Relatório inconsistente');
        }
        staged.delete(record.file);
        if (record.error !== null) {
          if (!['parse_java', 'receita_java', 'resultado_java', 'localizacao_java'].includes(record.error) || record.edits.length) {
            throw new Error('Falha de arquivo inconsistente');
          }
          failures++;
          issues.push({status: 'failed', detail: `arquivo=${source.rel}; erro=${record.error}; prova_parcial=true`});
          continue;
        }
        if (record.unproven) {
          omissions++;
          issues.push({status: 'skipped', detail: `arquivo=${source.rel}; candidatos_sem_prova=${record.unproven}; prova_parcial=true`});
        }
        if (!record.edits.length) continue;
        const {line, evidence} = await verifyEdits(record, source.copy);
        evidenceBytes += Buffer.byteLength(evidence);
        if (evidenceBytes > MAX_EVIDENCE_BYTES) {
          omissions++;
          issues.push({status: 'skipped', detail: `arquivo=${source.rel}; motivo=limite_evidencia; prova_parcial=true`});
          continue;
        }
        findings.push({tool: tool.tool, rule: RECIPE, file: source.rel, line, severity: 'baixa',
          message: 'Usar StandardCharsets.UTF_8 em chamadas atribuídas a Charset.forName("UTF-8").', evidence});
      }
    }
  } catch {
    return {coverage: [{...tool, version, status: 'failed', detail: `Erro de OpenRewrite na fase ${phase}; prova_parcial=true.`}], findings: []};
  }

  const partial = failures > 0 || omissions > 0;
  coverage.push({ ...tool, version, status: failures ? 'failed' : partial ? 'skipped' : 'ok',
    detail: `Modo offline; receita=${RECIPE}; fontes=${files.length}; falhas=${failures}; omissoes=${omissions}; achados=${findings.length}; prova_parcial=${partial}.`});
  for (const issue of issues) coverage.push({...tool, version, ...issue});
  return {coverage, findings};
}
