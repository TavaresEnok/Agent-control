import {DesignChecklistItem, designRawFinding, type DesignExamFinding, type DesignRawFinding} from './design-types.ts';

const ITEMS = [
  {
    "id": "DESIGN-VISUAL-HIERARQUIA",
    "title": "Hierarquia: um único ponto focal",
    "prompt": "Na captura, isole a região onde a tarefa começa — cabeçalho, hero ou primeiro bloco acima da dobra. Conte o que disputa o primeiro olhar: título, número, botão, ilustração, selo. Deve haver um só ponto focal; o resto recua em tamanho, peso e cor, para o olho chegar no que importa. Se dois blocos empatam, o foco se perde. Correção concreta: título principal em 32px, peso 600; segundo título em 16px, peso 400; botão primário preenchido e o secundário só com contorno de 1px, sem fundo. Atribua a nota de 0 a 10 somente depois, ancorada nessa região e no elemento que deveria vencer."
  },
  {
    "id": "DESIGN-VISUAL-TIPOGRAFIA",
    "title": "Tipografia: escala, medida e pares",
    "prompt": "Selecione na captura um bloco de texto corrido — parágrafo, descrição de cartão ou célula — e meça a largura da linha e o salto entre níveis. O corpo precisa ficar entre 45 e 75 caracteres por linha. Título, subtítulo e texto pedem contraste real de tamanho, não apenas negrito no mesmo corpo. Se houver duas famílias, cada uma tem papel claro e parentesco visual; mistura aleatória não conta como par. Correção concreta: corpo 16px com largura máxima de 640px, título 28px e subtítulo 18px, a mesma sans no texto e nos rótulos. A nota, de 0 a 10, só depois de apontar o bloco medido."
  },
  {
    "id": "DESIGN-VISUAL-COR",
    "title": "Cor: paleta coesa e acento na ação",
    "prompt": "Observe o fundo e os controles da captura, não o logotipo isolado. A paleta deve ser coesa: neutros e cores de apoio na mesma temperatura e com saturação próxima, sem um cinza frio ao lado de um bege quente sem motivo. A cor de acento fica restrita à ação — botão primário, link da tarefa ou estado ativo — e não pinta fundos, ícones decorativos nem bordas de cartão. Correção concreta: fundo #F7F6F3, texto #1C1B19, acento único #0F6E56 só no botão primário; demais azuis e roxos saturados passam a #6B6862. Atribua a nota de 0 a 10 depois, citando a região e a cor que sobra."
  },
  {
    "id": "DESIGN-VISUAL-RITMO",
    "title": "Ritmo: proximidade e grade de 4/8px",
    "prompt": "Na captura, olhe uma coluna com rótulo, campo e botão, e o vão até a seção seguinte. Itens da mesma ideia ficam próximos; blocos de outra ideia se separam por um espaço maior, proporcional à hierarquia — o vão interno do grupo é menor que o vão entre grupos. Os intervalos visíveis caem na grade de 4 ou 8px; folgas de 7, 13 ou 22px quebram o ritmo. Correção concreta: 8px entre rótulo e campo, padding interno do grupo em 16px e 32px entre seções. A nota de 0 a 10 vem depois, ancorada na coluna ou na seção que você mediu."
  },
  {
    "id": "DESIGN-VISUAL-GRADE",
    "title": "Grade: eixos comuns e bordas alinhadas",
    "prompt": "Trace eixos nas bordas esquerdas da captura: título, texto, cartões e botões da mesma coluna. Eles partem do mesmo x, ou cada bloco começa alguns pixels deslocado? Bordas direitas de cartões irmãos também precisam coincidir, sem um mais largo por sombra, borda ou padding extra. Desalinhamento pequeno já denuncia grade improvisada. Correção concreta: início do conteúdo a 24px da borda do container, cartões da fileira com largura igual de 360px e gap de 16px. Atribua a nota de 0 a 10 somente depois de indicar a fileira ou a coluna em que as bordas falham."
  },
  {
    "id": "DESIGN-VISUAL-DENSIDADE",
    "title": "Densidade: informação à medida da tarefa",
    "prompt": "Use a tela inteira visível na captura e compare o volume de informação com a tarefa daquele momento. Decisão rápida não empilha tabela, gráfico, filtros e três ações; trabalho contínuo não esconde o dado principal em cartões vazios e margens enormes. O que a pessoa precisa agora está presente; o resto não compete pelo mesmo plano. Correção concreta: deixe um bloco principal e uma ação primária; desça o painel secundário com 48px de separação ou leve-o para a próxima etapa do fluxo. A nota de 0 a 10 só depois, citando a região sobrecarregada ou oca."
  },
  {
    "id": "DESIGN-VISUAL-COMPONENTES",
    "title": "Componentes: o mesmo botão, o mesmo cartão",
    "prompt": "Na mesma captura, compare dois botões do mesmo tipo de ação e dois cartões do mesmo tipo de conteúdo. Mesma função exige o mesmo componente: altura, raio, peso tipográfico e padding iguais. Diferença visual só se justifica quando o papel muda — primário contra secundário — e não porque cada tela foi desenhada solta. Correção concreta: botão primário com altura 40px, raio 6px, texto 14px peso 600 e padding horizontal 16px; cartões irmãos com padding 16px e raio 8px. Atribua a nota de 0 a 10 depois de apontar o par que diverge."
  },
  {
    "id": "DESIGN-VISUAL-MARCA",
    "title": "Marca própria contra cara de modelo",
    "prompt": "Leia a captura inteira e decida se a identidade é do produto ou se parece um modelo genérico de interface. Marque clichês de UI gerada: gradiente roxo genérico no hero ou no fundo, fileira de cartões idênticos sem diferença de conteúdo, emoji no lugar de ícone e sombra aplicada em tudo, inclusive texto e selos. Marca própria tem paleta, tipo e raio decididos para o assunto. Correção concreta: fundo sólido #F4F1EA no lugar do gradiente, cartões só com borda 1px #E4E0D8 sem sombra, emoji trocado por ícone de traço 1.5px. A nota de 0 a 10 vem depois, nomeando o clichê e a região."
  },
  {
    "id": "DESIGN-VISUAL-POLIMENTO",
    "title": "Polimento: ícone, estado, borda e raio",
    "prompt": "Inspecione ícones, estados e cantos numa barra de ações ou num cartão interativo da captura. Os ícones vêm de um único conjunto, com o mesmo peso de traço e o mesmo tamanho óptico, sem mistura de preenchido e contorno. Botão e campo mostram foco e hover diferentes do repouso. Raio e borda seguem a hierarquia: controle menor que o cartão que o contém, borda de 1px num único neutro. Correção concreta: traço de ícone 1.5px, anel de foco 2px #0F6E56 com afastamento de 2px, hover em #E7F3EF, raio 6px no botão e 8px no cartão. Atribua a nota de 0 a 10 depois, ancorada nesse controle."
  }
] as const;

export const VISUAL_AXES = ['hierarquia', 'tipografia', 'cor', 'ritmo', 'grade', 'densidade', 'componentes', 'marca', 'polimento'] as const;
export type VisualAxis = (typeof VISUAL_AXES)[number];

export type VisualScore = {axis: VisualAxis; score: number; region: string; suggestion: string};

export function visualChecklistItems(): DesignChecklistItem[] {
  return ITEMS.map(item => DesignChecklistItem.parse({
    id: item.id,
    source: 'VISUAL',
    title: item.title,
    appliesTo: 'screen',
    prompt: item.prompt,
  }));
}

export function visualAxisOf(id: string): VisualAxis | null {
  const key = id.replace(/^DESIGN-VISUAL-/, '').toLowerCase();
  return (VISUAL_AXES as readonly string[]).includes(key) ? key as VisualAxis : null;
}

function finiteScore(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(10, Math.round(number * 10) / 10));
}

export function parseVisualScores(value: unknown): VisualScore[] | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {kind?: unknown; scores?: unknown};
  if (row.kind !== 'visual' || !Array.isArray(row.scores)) return null;
  const scores: VisualScore[] = [];
  for (const item of row.scores) {
    if (!item || typeof item !== 'object') continue;
    const score = item as {axis?: unknown; score?: unknown; region?: unknown; suggestion?: unknown};
    const axis = typeof score.axis === 'string' ? score.axis : '';
    if (!(VISUAL_AXES as readonly string[]).includes(axis)) continue;
    const valueScore = finiteScore(score.score);
    const region = String(score.region ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const suggestion = String(score.suggestion ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (valueScore === null || region.length === 0 || suggestion.length === 0) continue;
    scores.push({axis: axis as VisualAxis, score: valueScore, region, suggestion});
  }
  return VISUAL_AXES.every(axis => scores.some(item => item.axis === axis)) ? scores : null;
}

export function visualScoreFindings(file: string, scores: readonly VisualScore[]): DesignRawFinding[] {
  const findings: DesignRawFinding[] = [];
  for (const score of scores) {
    if (score.score >= 7) continue;
    findings.push(designRawFinding({
      tool: 'visual',
      rule: `DESIGN-VISUAL-${score.axis.toUpperCase()}`,
      file,
      severity: 'media',
      snippet: `${score.axis} ${score.score}/10 em ${score.region}`.slice(0, 240),
    }));
  }
  return findings;
}

export function visualExamFindings(file: string, scores: readonly VisualScore[]): DesignExamFinding[] {
  return scores.filter(score => score.score < 7).map(score => ({
    title: `${score.axis} ${score.score}/10`.slice(0, 200),
    severity: 'media' as const,
    file: file.slice(0, 400),
    line: null,
    scenario: `Nota ${score.score} de 10 no eixo ${score.axis}, região ${score.region}.`.slice(0, 2000),
    suggestion: score.suggestion.slice(0, 2000),
    cwe: null,
    reference: `DESIGN-VISUAL-${score.axis.toUpperCase()}`.slice(0, 120),
    snippet: `${score.region}: ${score.score}/10`.slice(0, 240),
  }));
}

export function uncertainVisualAxes(examiner: readonly VisualScore[], reviewer: readonly VisualScore[]): string[] {
  const uncertain: string[] = [];
  for (const axis of VISUAL_AXES) {
    const left = examiner.find(item => item.axis === axis);
    const right = reviewer.find(item => item.axis === axis);
    if (!left || !right) continue;
    if (Math.abs(left.score - right.score) > 2) uncertain.push(`${axis}: examinador ${left.score}, revisor ${right.score}`);
  }
  return uncertain;
}

function genericScreen(task: string): boolean {
  return /6d28d9|7c3aed|linear-gradient/i.test(task) && /cartao|cartão|emoji/i.test(task);
}

export function visualReportMarkdown(rows: readonly {route: string; examiner: readonly VisualScore[]; reviewer: readonly VisualScore[]; uncertain: readonly string[]}[]): string {
  const lines = ['## Crítica visual', ''];
  if (rows.length === 0) {
    lines.push('Nenhuma tela recebeu nota visual.');
    return lines.join('\n');
  }
  const averages = new Map<string, {sum: number; count: number}>();
  for (const row of rows) {
    lines.push(`### ${row.route}`);
    for (const score of row.examiner) {
      lines.push(`- ${score.axis}: examinador ${score.score}/10 em ${score.region}. ${score.suggestion}`);
      const bucket = averages.get(score.axis) ?? {sum: 0, count: 0};
      bucket.sum += score.score;
      bucket.count += 1;
      averages.set(score.axis, bucket);
    }
    if (row.uncertain.length > 0) lines.push(`Julgamento incerto: ${row.uncertain.join('; ')}.`);
    lines.push('');
  }
  lines.push('### Média');
  for (const [axis, bucket] of averages) {
    const mean = Math.round((bucket.sum / bucket.count) * 10) / 10;
    lines.push(`- ${axis}: ${mean}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function benchVisualScores(task: string, role: 'specialist' | 'reviewer'): {kind: 'visual'; scores: VisualScore[]} {
  const generic = genericScreen(task);
  const reference = /Referências:/.test(task);
  const scores = VISUAL_AXES.map(axis => {
    let score = 8;
    if (generic && axis === 'marca') score = role === 'reviewer' ? 6 : 3;
    if (generic && axis === 'hierarquia') score = 4;
    if (generic && axis === 'componentes') score = 5;
    const suggestion = axis === 'marca'
      ? (reference ? 'A referência usa fundo #f4f1ea; a tela usa gradiente #6d28d9. Troque pelo sólido #f4f1ea e tire a sombra dos cartões.' : 'Troque o gradiente #6d28d9 por fundo #f4f1ea e o cartão por borda 1px #e4e0d8.')
      : axis === 'hierarquia'
        ? 'Deixe um título de 32px peso 600 e o restante em 16px.'
        : 'Ajuste o eixo para 16px e a cor #1b1b1b.';
    return {axis, score, region: generic ? 'hero e cartões' : 'tela', suggestion};
  });
  return {kind: 'visual', scores};
}
