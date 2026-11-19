import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isRecord, maxBodyBytes, maxInventory, planOpenApi, planPact} from './examples.mjs';
import {exchangeMs, runProvider, startupMs} from './http.mjs';

export const functionalContractTools = {
  openapi: 'qa-openapi-exemplos',
  pact: 'qa-pact-interacoes',
};
const version = `1.0.0 (Node ${process.versions.node})`;
const manifest = 'qa-contracts.json';
export const maxContractDocuments = 8;
const maxExchanges = 16;
const budgetMs = 20_000;

function readBindingManifest(workspace, files) {
  if (!files.has(manifest)) return {};
  try {
    const document = JSON.parse(readFileSync(join(workspace, manifest), 'utf8'));
    if (isRecord(document) && document.version === 1 && Object.keys(document).every(key =>
      key === 'version' || (Object.hasOwn(functionalContractTools, key) && isRecord(document[key])))) return document;
  } catch {
    // Nenhum conteúdo nem erro de parsing é incorporado à evidência.
  }
  return null;
}

function readPlan(kind, workspace, file, validatedOpenApi) {
  if (kind === 'openapi') {
    const spec = validatedOpenApi.get(file);
    if (!spec) return {reason: 'especificação sem validação estática concluída'};
    if (!/^3\.[01]\.\d{1,3}$/.test(spec.openapi)) return {reason: 'versão fora do recorte OpenAPI 3.0/3.1'};
    return {...planOpenApi(spec), version: spec.openapi};
  }
  try {
    return planPact(JSON.parse(readFileSync(join(workspace, file), 'utf8')));
  } catch {
    return {reason: 'documento Pact ilegível ou JSON inválido', failed: true};
  }
}

const pactFile = /(?:^|\/)pacts\/[^/]+\.json$|(?:^|\/)(?:pact|[^/]+\.pact)\.json$/i;

export async function runFunctionalContract(kind, {
  workspace, workRoot, copiedFiles, openapiFiles, validatedOpenApi, enabled, row, key, pathLabel,
}) {
  const tool = functionalContractTools[kind];
  const report = (status, detail) => row(tool, version, status, detail);
  const files = new Set(copiedFiles);
  const bindings = readBindingManifest(workspace, files);
  const docs = kind === 'openapi' ? openapiFiles : copiedFiles.filter(file => pactFile.test(file) ||
    (file !== manifest && /\.json$/i.test(file) && Object.hasOwn(bindings?.pact ?? {}, file)));
  if (!docs.length) return {coverageRow: report('skipped', 'nenhum documento reconhecido no snapshot')};
  if (!bindings) return {coverageRow: report('failed', `${manifest}: manifesto de homologação inválido`)};

  const deadline = performance.now() + budgetMs;
  const extraRows = [];
  const findings = [];
  const measuredFiles = [];
  let declared = 0;
  let measured = 0;
  let failures = 0;
  let slots = maxExchanges;
  for (const file of docs.slice(0, maxContractDocuments)) {
    const plan = readPlan(kind, workspace, file, validatedOpenApi);
    const label = pathLabel(file);
    const docVersion = plan.version ? `${version} / ${kind === 'pact' ? 'Pact' : 'OpenAPI'} ${plan.version}` : version;
    const fileRow = (status, detail) => extraRows.push(row(key(tool, file), docVersion, status, `${label}: ${detail}`));
    if (plan.reason) {
      failures += Number(!!plan.failed);
      fileRow(plan.failed ? 'failed' : 'skipped', plan.reason);
      continue;
    }
    declared += plan.declared;
    const binding = bindings[kind];
    const adapter = binding && Object.hasOwn(binding, file) ? binding[file] : undefined;
    // Só um caminho relativo previamente copiado de um arquivo regular pode ser executado.
    let unavailable;
    if (!plan.declared) unavailable = 'sem exemplos de resposta ou interações declaradas';
    else if (typeof adapter !== 'string' || !adapter.endsWith('.mjs') || !files.has(adapter)) {
      unavailable = 'adaptador .mjs ausente do snapshot ou sem vínculo em qa-contracts.json';
    } else if (!enabled) unavailable = 'execução dinâmica reservada ao contêiner isolado';
    if (unavailable) {
      fileRow('skipped', `${plan.inventory}. 0/${plan.declared} medidos. ${unavailable}. ${plan.omitted} fora do limite de enumeração`);
      continue;
    }

    const runnable = plan.cases.filter(scenario => scenario.request).slice(0, slots);
    slots -= runnable.length;
    const batch = runnable.length
      ? await runProvider({workspace, workRoot, adapter, cases: runnable, exactLeaves: kind === 'pact', deadline})
      : {};
    const results = new Map(runnable.map((scenario, i) => [scenario, batch.results?.[i] ?? batch]));
    let docMeasured = 0;
    let docFailures = 0;
    let docDifferences = 0;
    for (const [index, scenario] of plan.cases.entries()) {
      const result = results.get(scenario);
      const status = result?.status ? 'ok' : result?.error ? 'failed' : 'skipped';
      const detail = result?.status
        ? `HTTP esperado ${scenario.expected.status}, recebido ${result.status}. ${result.problem ?? 'resposta conforme o exemplo'}`
        : scenario.reason ?? result?.skipped ?? result?.error ?? 'fora do limite de trocas da medição';
      const location = `${label}, ${scenario.at}`;
      extraRows.push(row(key(tool, file, `:${index + 1}`), docVersion, status, `${location}. ${detail}`));
      if (status === 'failed') docFailures++;
      if (status === 'ok') docMeasured++;
      if (result?.problem) {
        docDifferences++;
        findings.push({
          tool, rule: kind === 'pact' ? 'QA-PACT-RESPOSTA-DIVERGENTE' : 'QA-OPENAPI-EXEMPLO-DIVERGENTE',
          file, line: 1, severity: 'media', message: 'Resposta local divergiu do contrato funcional',
          evidence: `${location}. ${detail}`,
        });
      }
    }

    measured += docMeasured;
    failures += docFailures;
    if (docMeasured) measuredFiles.push(file);
    fileRow(docMeasured ? 'ok' : docFailures ? 'failed' : 'skipped',
      `${plan.inventory}. ${docMeasured}/${plan.declared} medidos, ${docDifferences} divergentes, ${docFailures} falhas operacionais e ${plan.omitted} fora do limite de enumeração`);
  }

  const status = measured ? 'ok' : failures ? 'failed' : 'skipped';
  const limits = `limites de ${maxContractDocuments} documentos, ${maxInventory} declarações/documento, ${maxExchanges} trocas, ${budgetMs / 1000} s no total, ${startupMs / 1000} s para iniciar, ${exchangeMs / 1000} s por troca e ${maxBodyBytes / 1024} KiB por corpo`;
  return {
    coverageRow: {
      ...report(status, `${measured}/${declared} exemplos ou interações medidos, ${findings.length} divergentes. ${Math.min(docs.length, maxContractDocuments)}/${docs.length} documentos examinados. ${limits}`),
      ...(measuredFiles.length ? {files: measuredFiles} : {}),
    },
    extraRows, findings,
  };
}
