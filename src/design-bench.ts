import {
  DESIGN_PLANTED_RULES,
  DesignConfirmResult,
  DesignExamFinding,
  DesignExamResult,
  type DesignWorker,
} from './design-types.ts';

function listAfter(task: string, header: string): string[] {
  const lines = task.split('\n');
  const at = lines.findIndex(line => line === header);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('- ')) break;
    const value = line.slice(2).trim();
    if (value.length > 0) out.push(value.slice(0, 400));
  }
  return out.slice(0, 80);
}

function checklistFromTask(task: string): string[] {
  const lines = task.split('\n');
  const at = lines.findIndex(line => line.startsWith('Itens:'));
  if (at < 0) return [];
  const inline = lines[at].slice('Itens:'.length).trim();
  const fromInline = inline.split(',').map(item => item.trim()).filter(item => item.length > 0);
  if (fromInline.length > 0) return fromInline.map(item => item.slice(0, 80)).slice(0, 80);
  const listed: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('- ')) break;
    const value = line.slice(2).trim();
    if (value.length > 0) listed.push(value.slice(0, 80));
  }
  return listed.slice(0, 80);
}

function field(task: string, label: string): string {
  const match = task.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'));
  return (match?.[1] ?? '').trim();
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Opinião não se confirma, mesmo se o texto também citar uma regra. */
function isTaste(title: string, rule: string): boolean {
  const text = fold(`${title}\n${rule}`);
  return text.includes('gosto') || text.includes('preferencia');
}

function ruleConfirmed(rule: string): boolean {
  if (Object.values(DESIGN_PLANTED_RULES).some(planted => rule.includes(planted))) return true;
  const upper = rule.toUpperCase();
  return upper.includes('WCAG') || upper.includes('DESIGN-');
}

function titleFor(rule: string): string {
  const id = rule.toUpperCase();
  if (id.includes('GOSTO') || id.includes('PREFEREN')) return 'Achado de gosto';
  if (id.includes('CONTRASTE')) return 'Contraste abaixo de 4.5:1';
  if (id.includes('FOCO')) return 'Foco invisível';
  if (id.includes('BOTAO') || id.includes('NOME')) return 'Controle sem nome';
  if (id.includes('CINZA')) return 'Cinzas demais';
  if (id.includes('ESPAC')) return 'Espaço fora da grade';
  if (id.includes('VAZIO')) return 'Estado vazio ausente';
  if (id.includes('CORTAD')) return 'Texto cortado';
  if (id.includes('ORDEM')) return 'Ordem do foco';
  if (id.includes('375') || id.includes('QUEBRADA') || id.includes('REFLOW') || id.includes('LARGURA')) {
    return 'Largura quebra em 375px';
  }
  if (id.includes('ALVO') || id.includes('24')) return 'Alvo menor que 24px';
  return 'Ponto de interface';
}

function suggestionFor(rule: string): string {
  const id = rule.toUpperCase();
  if (id.includes('GOSTO') || id.includes('PREFEREN')) return 'Não mude a cor #1b1b1b nem o tamanho 16px por opinião.';
  if (id.includes('CONTRASTE')) return 'Use texto #1b1b1b sobre fundo #ffffff para atingir 4.5:1.';
  if (id.includes('FOCO')) return 'Use outline: 2px solid #0b57d0 no foco visível.';
  if (id.includes('BOTAO') || id.includes('NOME')) return 'Dê ao botão o texto "Salvar".';
  if (id.includes('CINZA')) return 'Fique nos cinzas #1a1a1a e #5c5c5c e no acento #0b57d0.';
  if (id.includes('ESPAC')) return 'Use múltiplos de 4px, por exemplo 8px e 16px.';
  if (id.includes('VAZIO')) return 'Inclua data-empty e o texto "Nenhum item".';
  if (id.includes('CORTAD')) return 'Remova o corte e deixe o texto visível em 16px.';
  if (id.includes('ORDEM')) return 'Reordene o foco sem salto maior que 200px para cima.';
  if (id.includes('375') || id.includes('QUEBRADA') || id.includes('REFLOW') || id.includes('LARGURA') || id.includes('320')) {
    return 'Troque a largura fixa por width: 100% e max-width: 720px.';
  }
  if (id.includes('ALVO') || id.includes('24')) return 'Aumente o alvo para no mínimo 24px por 24px.';
  if (id.includes('DOHERTY') || id.includes('400MS')) return 'Mostre retorno em até 400ms com um indicador de 16px.';
  return 'Ajuste o ponto para 16px e a cor #1b1b1b.';
}

function lineOf(raw: string): number | null {
  if (raw === '-' || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function parseToolLine(line: string): {
  tool: string;
  rule: string;
  severity: string;
  line: string;
  file: string;
  snippet: string;
} | null {
  if (!line.startsWith('- tool=')) return null;
  const fields = new Map<string, string>();
  for (const part of line.slice(2).split(' | ')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const tool = fields.get('tool');
  const rule = fields.get('rule');
  const severity = fields.get('severity');
  if (!tool || !rule || !severity) return null;
  return {
    tool,
    rule,
    severity,
    line: fields.get('line') ?? '-',
    file: fields.get('file') ?? '',
    snippet: fields.get('snippet') ?? '',
  };
}

function findingsFromTask(task: string, fallbackFile: string): DesignExamFinding[] {
  const lines = task.split('\n');
  const at = lines.findIndex(line => line === 'Achados de ferramenta:');
  if (at < 0) return [];
  const findings: DesignExamFinding[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('- tool=')) break;
    const parsed = parseToolLine(line);
    if (!parsed || (parsed.severity !== 'alta' && parsed.severity !== 'media')) continue;
    const file = (parsed.file || fallbackFile).slice(0, 400);
    const rule = parsed.rule.slice(0, 120);
    if (!file || !rule) continue;
    const lineNumber = lineOf(parsed.line);
    findings.push(DesignExamFinding.parse({
      title: titleFor(rule).slice(0, 200),
      severity: parsed.severity,
      file,
      line: lineNumber,
      scenario: `A ferramenta ${parsed.tool.slice(0, 40)} apontou ${rule} (${lineNumber === null ? 'sem linha' : `linha ${lineNumber}`}).`.slice(0, 2000),
      suggestion: suggestionFor(rule).slice(0, 2000),
      cwe: null,
      reference: rule,
      snippet: parsed.snippet.replace(/\s+/g, ' ').trim().slice(0, 240),
    }));
    if (findings.length >= 40) break;
  }
  return findings;
}

function examFromTask(task: string): DesignExamResult {
  const filesRead = listAfter(task, 'Arquivos:');
  const checklist = checklistFromTask(task);
  if (filesRead.length === 0) throw new Error('EXAME_SEM_ARQUIVO');
  if (checklist.length === 0) throw new Error('EXAME_SEM_ITENS');
  return DesignExamResult.parse({
    kind: 'exame',
    filesRead,
    checklist,
    findings: findingsFromTask(task, filesRead[0] ?? ''),
  });
}

function confirmFromTask(task: string): DesignConfirmResult {
  const rule = field(task, 'Regra');
  const title = field(task, 'Título') || field(task, 'Titulo');
  const snippet = field(task, 'Trecho');
  let status: 'confirmado' | 'provavel' | 'descartado' = 'provavel';
  let reason = 'Não há regra plantada, WCAG nem DESIGN- no ponto.';
  if (isTaste(title, rule)) {
    status = 'descartado';
    reason = 'O título ou a regra fala de gosto ou preferencia, sem medida verificável.';
  } else if (ruleConfirmed(rule)) {
    status = 'confirmado';
    reason = `A regra ${rule || 'informada'} é plantada, WCAG ou DESIGN- e o trecho sustenta o ponto.`;
  }
  return DesignConfirmResult.parse({
    kind: 'confirmacao',
    status,
    reason: reason.slice(0, 2000),
    proof: `Trecho: ${snippet}`.slice(0, 2000),
  });
}

export function designBenchWorker(): DesignWorker {
  return {
    async run(call) {
      if (call.writePaths.length !== 0) throw new Error('WRITE_PATHS_PROIBIDO');
      const task = call.task;
      if (task.startsWith('Pedido de exame.')) return JSON.stringify(examFromTask(task));
      if (task.startsWith('Pedido de confirmação.')) return JSON.stringify(confirmFromTask(task));
      throw new Error('PEDIDO_DESCONHECIDO');
    },
  };
}
