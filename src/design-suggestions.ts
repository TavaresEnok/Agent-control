import {DESIGN_PLANTED_RULES} from './design-types.ts';

/** Texto de antes, para regra sem frase própria. */
export const DESIGN_SUGGESTION_FALLBACK = 'A medida confirma o achado. A correção precisa mudar o valor medido.';

/**
 * Uma frase de correção por regra medida. A frase diz o que mudar, não repete a medida.
 * Inclui as regras da régua do navegador (R1, R2, R3) e dos analisadores (T1 a T5).
 */
const SUGGESTIONS: Readonly<Record<string, string>> = {
  [DESIGN_PLANTED_RULES.contrast]: 'Escureça o texto ou clareie o fundo até a razão chegar a 4,5:1, ou 3:1 em texto grande.',
  'DESIGN-TOKENS-CONTRASTE': 'Troque o par de cores do token até a razão chegar a 4,5:1 em texto comum.',
  'DESIGN-CONTRASTE-ESTADO': 'Ajuste a cor do hover e do foco para manter 4,5:1 no texto, ou 3:1 em texto grande e ícone.',
  'DESIGN-TELA-ROLAGEM-HORIZONTAL': 'Tire a largura fixa do elemento que passa da tela. Use max-width: 100% ou deixe a linha quebrar.',
  'DESIGN-ALVO-24': 'Aumente a área de toque para pelo menos 24 por 24 px, com padding ou min-height.',
  'DESIGN-ALVO-REFERENCIA': 'Leve a área de toque a 44 por 44 px nas telas de toque, com padding ou min-height.',
  'LH-CLS': 'Reserve espaço para imagem, anúncio e fonte antes de carregar: width e height ou aspect-ratio.',
  'LH-LCP': 'Carregue antes o maior elemento da tela: imagem menor, preload e menos script antes dele.',
  'LH-TBT': 'Divida o script longo, adie o que não é da primeira tela e tire dependência que não é usada.',
  'DESIGN-WALLACE-FONTES': 'Junte os tamanhos de fonte numa escala curta, de 6 a 8 passos.',
  'DESIGN-WALLACE-FAMILIAS': 'Use no máximo duas famílias de fonte e tire as que sobraram.',
  'DESIGN-WALLACE-CORES': 'Troque as cores soltas pelas cores do tema, em variáveis.',
  'DESIGN-WALLACE-ESPECIFICIDADE': 'Baixe a especificidade: troque id e seletor encadeado por uma classe.',
  'DESIGN-WALLACE-SELETORES': 'Quebre a regra com muitos seletores em classes de componente.',
  'DESIGN-WALLACE-DUPLICADAS': 'Tire as declarações repetidas e deixe uma só por regra.',
  'DESIGN-WALLACE-ZINDEX': 'Junte os z-index numa escala curta, em variáveis.',
  'DESIGN-WALLACE-UNIDADES': 'Use menos unidades: px para borda, rem para texto e espaço.',
  'DESIGN-WALLACE-IMPORTANT': 'Tire o !important e resolva a ordem das regras.',
  [DESIGN_PLANTED_RULES.empty]: 'Mostre um estado vazio com texto e uma ação quando a lista não tem item.',
  [DESIGN_PLANTED_RULES.grays]: 'Junte os cinzas parecidos numa escala de 5 a 7 tons, em variáveis.',
  'DESIGN-TOKENS-TIPO-CONTAGEM': 'Junte os tamanhos de texto numa escala curta, em variáveis.',
  'DESIGN-TOKENS-FAMILIAS': 'Use no máximo duas famílias de fonte.',
  'DESIGN-TOKENS-ACENTOS': 'Fique com uma ou duas cores de destaque e tire as outras.',
  'DESIGN-TEXTO-CORTADO-MEDIDO': 'Deixe o texto quebrar a linha ou mostre reticências com o texto inteiro no title.',
  'DESIGN-IMAGEM-QUEBRADA': 'Corrija o caminho da imagem ou tire a imagem da tela.',
  'DESIGN-TELA-ZOOM-CAMPO': 'Use fonte de 16 px nos campos, para o celular não aproximar a tela.',
  'DESIGN-TEXTO-SOBRA': 'Troque o texto de exemplo ou de variável pelo texto real.',
  'DESIGN-GRAFICO-SEM-ALTERNATIVA': 'Dê um nome ao gráfico e mostre os números também em texto ou tabela.',
  'DESIGN-MOVIMENTO-REDUZIDO': 'Pare a animação contínua quando o sistema pede movimento reduzido.',
  'DESIGN-TITULO-REPETIDO': 'Dê a cada rota um title próprio, com o nome da tela.',
  'WCAG-2-4-11-FOCO-ENCOBERTO': 'Deixe o foco visível: dê scroll-padding ao cabeçalho fixo ou mude a ordem das camadas.',
  'LH-VIEWPORT': 'Ponha <meta name="viewport" content="width=device-width, initial-scale=1"> no head.',
  'LH-FONTE-LEGIVEL': 'Use texto de pelo menos 12 px no celular, de preferência 16 px.',
  'DESIGN-TOKENS-ENTRELINHA': 'Use entrelinha de pelo menos 1,4 no texto corrido.',
  'WCAG-2-1-1-CLIQUE-SEM-TECLADO': 'Use um button, ou dê role, tabindex e tecla ao elemento clicável.',
  'DESIGN-TOKENS-FORA-DO-DECLARADO': 'Troque o valor solto pelo token declarado mais próximo.',
  'DESIGN-CONSISTENCIA-VALOR-ISOLADO': 'Use o mesmo valor das outras telas, pelo token comum.',
  'DESIGN-TITULOS-ESCALA': 'Deixe h1 maior que h2 e h2 maior que h3.',
  'declaration-property-value-disallowed-list': 'Troque transition: all pela lista do que anima, como opacity e transform.',
};

/** Frase de correção da regra. Regra sem frase própria recebe o texto de antes. */
export function suggestionFor(rule: string): string {
  return Object.hasOwn(SUGGESTIONS, rule) ? SUGGESTIONS[rule] ?? DESIGN_SUGGESTION_FALLBACK : DESIGN_SUGGESTION_FALLBACK;
}

/** Regras com frase própria. Serve aos testes. */
export function suggestionRules(): string[] {
  return Object.keys(SUGGESTIONS);
}
