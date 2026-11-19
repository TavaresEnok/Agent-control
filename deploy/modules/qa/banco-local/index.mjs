import {executionAllowed} from '../execute-tests.mjs';
import {freshPath, invariantPath, planBancoLocal, seedPath} from './plan.mjs';
import {bancoLocalVersion, createLocalPostgres} from './postgres.mjs';

export const bancoLocalTool = 'qa-banco-local';

export async function measureBancoPlan(plan, database) {
  const steps = [];
  const findings = [];
  const step = (name, status, detail) => steps.push({name, status, detail});

  async function run(name, evidence, action) {
    try {
      await action();
      step(name, 'ok', evidence);
      return true;
    } catch {
      step(name, 'failed', `${evidence}; operação local não concluída`);
      return false;
    }
  }

  async function migrate(db, phase, migrations) {
    for (const [index, {file, sql}] of migrations.entries()) {
      if (!await run(`${phase}-${index + 1}`, file, () => database.sql(db, sql))) return false;
    }
    return true;
  }

  async function assert(db, phase, file, {sql, line}) {
    let result;
    try {
      result = await database.assert(db, sql);
    } catch {
      result = 'invalid';
    }
    if (result === 'passed') {
      step(phase, 'ok', `${file}; pgTAP confirmou 1/1`);
      return true;
    }
    if (result === 'failed') {
      step(phase, 'failed', `${file}; pgTAP reprovou 1/1`);
      findings.push({tool: bancoLocalTool, rule: 'QA-BANCO-PGTAP', file, line, severity: 'media',
        message: `A assertiva funcional reprovou na fase ${phase}.`,
        evidence: `pgTAP confirmou um teste executado e reprovado na fase ${phase}.`});
    } else {
      step(phase, 'failed', `${file}; execução ou resultado pgTAP sem confirmação`);
    }
    return false;
  }

  async function fresh() {
    if (!await migrate('fresh', 'do-zero-migracao', plan.migrations)) {
      step('do-zero-assertiva', 'skipped', 'migração do zero interrompida');
    } else if (!plan.fresh) {
      step('do-zero-assertiva', 'skipped', `${freshPath} ausente`);
    } else {
      await assert('fresh', 'do-zero-assertiva', freshPath, plan.fresh);
    }
  }

  async function history() {
    const {seed, invariant, reason} = plan.history;
    if (reason) {
      step('historico', 'skipped', reason);
      return;
    }
    const prefix = plan.migrations.slice(0, -1);
    const tail = plan.migrations.slice(-1);
    const completed =
      await migrate('previous', 'historico-migracao', prefix) &&
      await run('historico-semente', seedPath, () => database.sql('previous', seed)) &&
      await assert('previous', 'historico-antes-do-dump', invariantPath, invariant) &&
      await run('historico-dump', 'dump custom gerado a partir do estado anterior', () => database.dump()) &&
      await run('historico-restauracao', 'dump custom restaurado no banco vazio', () => database.restore()) &&
      await assert('upgraded', 'historico-restaurado', invariantPath, invariant) &&
      await migrate('upgraded', 'atualizacao-migracao', tail);
    if (completed) {
      await assert('upgraded', 'historico-atualizado', invariantPath, invariant);
    } else {
      step('historico-atualizado', 'skipped', 'pré-requisito da atualização histórica interrompido');
    }
  }

  try {
    if (await run('instancia', 'cluster PostgreSQL efêmero em socket Unix privado', () => database.start())) {
      await fresh();
      await history();
    } else {
      step('do-zero', 'skipped', 'cluster indisponível');
      step('historico', 'skipped', 'cluster indisponível');
    }
  } finally {
    await run('limpeza', 'instância e arquivos temporários removidos', () => database.stop());
  }
  return {steps, findings};
}

export async function collectQaBancoLocal({repoDir, workspace, copiedFiles, incomplete, row}) {
  const skipped = detail => ({
    coverageRow: row(bancoLocalTool, 'não aferida', 'skipped', detail), extraRows: [], findings: [],
  });
  // A interface da coleta não permite injetar driver, conexão, socket ou caminho de executável.
  const plan = planBancoLocal({workspace, copiedFiles, incomplete});
  if (plan.reason) return skipped(plan.reason);
  if (!executionAllowed(repoDir)) return skipped('execução PostgreSQL reservada ao contêiner QA offline');

  let result;
  try {
    result = await measureBancoPlan(plan, createLocalPostgres(repoDir));
  } catch {
    return {coverageRow: row(bancoLocalTool, 'não aferida', 'failed',
      'falha ao preparar a instância PostgreSQL isolada'), extraRows: [], findings: []};
  }
  const extraRows = result.steps.map(({name, status, detail}) =>
    row(`${bancoLocalTool}:${name}`, bancoLocalVersion, status, detail));
  const failed = result.steps.filter(step => step.status === 'failed').length;
  const omitted = result.steps.filter(step => step.status === 'skipped').length;
  const status = failed ? 'failed' : omitted ? 'skipped' : 'ok';
  return {
    coverageRow: row(bancoLocalTool, bancoLocalVersion, status,
      `${result.steps.length - failed - omitted}/${result.steps.length} etapas confirmadas; ${failed} falhas; ${omitted} omissões`),
    extraRows, findings: result.findings,
  };
}
