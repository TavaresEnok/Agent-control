import {Refusal} from './contracts.ts';

export const DESIGN_DECLARED_STATES = ['vazio', 'carregando', 'erro', 'logado'] as const;
export type DesignDeclaredState = (typeof DESIGN_DECLARED_STATES)[number];

export type DesignActionStep =
  | {op: 'clicar'; selector: string}
  | {op: 'esperar'; selector: string}
  | {op: 'preencher'; selector: string; text: string};

/**
 * Alcance que o host e a imagem consomem.
 * `padrao` não tem URL inventada. Os outros só entram com url ou acoes.
 */
export type DesignStateReach =
  | {name: 'padrao'}
  | {name: 'vazio' | 'carregando' | 'erro' | 'logado'; url: string}
  | {name: 'vazio' | 'carregando' | 'erro' | 'logado'; acoes: string[]};

export type DesignRouteConfig = {
  example?: string;
  /** Nomes citados sem url e sem acoes. Não entram na captura. */
  bareStates: DesignDeclaredState[];
  reaches: Array<Exclude<DesignStateReach, {name: 'padrao'}>>;
  /** Verdadeiro quando a chave logado existe e não traz url. O host faz o login. */
  loginState: boolean;
  dark: boolean;
};

export type DesignProjectConfig = {
  routes: Record<string, DesignRouteConfig>;
};

const STATE = new Set<string>(DESIGN_DECLARED_STATES);
const MAX_ACTIONS = 20;
const MAX_ACTION_LENGTH = 300;
const CLICK_STEP = /^clicar\s+(\S+)$/u;
const WAIT_STEP = /^esperar\s+(\S+)$/u;
const FILL_STEP = /^preencher\s+(\S+)\s+(.+)$/u;

/** A rota planejada pode ser o exemplo concreto de uma rota com parâmetro. */
function declaredRoute(config: DesignProjectConfig, route: string): DesignRouteConfig | undefined {
  const direct = config.routes[route];
  if (direct !== undefined) return direct;
  for (const item of Object.values(config.routes)) {
    if (item.example === route) return item;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeclaredState(value: string): value is DesignDeclaredState {
  return STATE.has(value);
}

/** Passo fechado: clicar, preencher ou esperar. Sem JS livre. */
export function parseDesignActionStep(step: string): DesignActionStep | undefined {
  if (step.length === 0 || step.length > MAX_ACTION_LENGTH) return undefined;
  const trimmed = step.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACTION_LENGTH || /[\u0000-\u001f]/.test(trimmed)) return undefined;
  const click = CLICK_STEP.exec(trimmed);
  const clickSelector = click?.[1];
  if (clickSelector !== undefined) return {op: 'clicar', selector: clickSelector};
  const wait = WAIT_STEP.exec(trimmed);
  const waitSelector = wait?.[1];
  if (waitSelector !== undefined) return {op: 'esperar', selector: waitSelector};
  const fill = FILL_STEP.exec(trimmed);
  const fillSelector = fill?.[1];
  const fillText = fill?.[2];
  if (fillSelector !== undefined && fillText !== undefined && fillText.length > 0) {
    return {op: 'preencher', selector: fillSelector, text: fillText};
  }
  return undefined;
}

/** Caminho relativo no mesmo host. Sem esquema, sem `..` e sem `javascript:`. */
export function isDesignStatePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\') || /[\u0000-\u001f\s]/.test(path)) return false;
  if (/javascript:/i.test(path) || path.includes('://')) return false;
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    return false;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return false;
  if (decoded.includes('..') || decoded.includes('\\') || /javascript:/i.test(decoded)) return false;
  try {
    const url = new URL(path, 'http://design.local');
    if (url.origin !== 'http://design.local') return false;
    if (url.username !== '' || url.password !== '') return false;
    const parts = url.pathname.split('/');
    if (parts.includes('..') || parts.includes('.')) return false;
  } catch {
    return false;
  }
  return true;
}

function emptyStates(): Pick<DesignRouteConfig, 'bareStates' | 'reaches' | 'loginState'> {
  return {bareStates: [], reaches: [], loginState: false};
}

function parseStateList(value: readonly unknown[]): Pick<DesignRouteConfig, 'bareStates' | 'reaches' | 'loginState'> {
  const bareStates: DesignDeclaredState[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !isDeclaredState(item)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    if (!bareStates.includes(item)) bareStates.push(item);
  }
  return {bareStates, reaches: [], loginState: bareStates.includes('logado')};
}

function parseStateObject(value: Record<string, unknown>): Pick<DesignRouteConfig, 'bareStates' | 'reaches' | 'loginState'> {
  const bareStates: DesignDeclaredState[] = [];
  const reaches: DesignRouteConfig['reaches'] = [];
  let loginState = false;
  for (const [key, spec] of Object.entries(value)) {
    if (!isDeclaredState(key)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    if (!isRecord(spec)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    const keys = Object.keys(spec);
    const hasUrl = Object.hasOwn(spec, 'url');
    const hasAcoes = Object.hasOwn(spec, 'acoes');
    if (hasUrl && hasAcoes) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    if (!hasUrl && !hasAcoes) {
      if (keys.length !== 0) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
      if (!bareStates.includes(key)) bareStates.push(key);
      if (key === 'logado') loginState = true;
      continue;
    }
    if (hasUrl) {
      if (keys.some(item => item !== 'url')) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
      if (typeof spec.url !== 'string' || !isDesignStatePath(spec.url)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
      reaches.push({name: key, url: spec.url});
      continue;
    }
    if (keys.some(item => item !== 'acoes')) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    if (!Array.isArray(spec.acoes) || spec.acoes.length === 0 || spec.acoes.length > MAX_ACTIONS) {
      throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    }
    const steps: string[] = [];
    for (const step of spec.acoes) {
      if (typeof step !== 'string' || parseDesignActionStep(step) === undefined) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
      steps.push(step.trim());
    }
    reaches.push({name: key, acoes: steps});
    if (key === 'logado') loginState = true;
  }
  return {bareStates, reaches, loginState};
}

function parseRouteStates(value: unknown): Pick<DesignRouteConfig, 'bareStates' | 'reaches' | 'loginState'> {
  if (value === undefined) return emptyStates();
  if (Array.isArray(value)) return parseStateList(value);
  if (isRecord(value)) return parseStateObject(value);
  throw new Refusal('DESIGN_CONFIG_INVALID', 400);
}

/** Config ausente é válida e não inventa estado. JSON quebrado recusa. */
export function parseDesignProjectConfig(text: string | undefined): DesignProjectConfig {
  if (text === undefined || text.trim().length === 0) return {routes: {}};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Refusal('DESIGN_CONFIG_INVALID', 400);
  }
  if (!isRecord(parsed) || !isRecord(parsed.routes)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
  const routes: Record<string, DesignRouteConfig> = {};
  for (const [route, value] of Object.entries(parsed.routes)) {
    if (!route.startsWith('/') || route.includes('..') || route.length > 200) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    if (!isRecord(value)) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    const example = typeof value.example === 'string' ? value.example : undefined;
    if (example !== undefined && (!example.startsWith('/') || example.includes('..') || /[:*]|\[[^\]]*\]/.test(example))) {
      throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    }
    if (Object.hasOwn(value, 'states') && value.states === undefined) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    const states = parseRouteStates(Object.hasOwn(value, 'states') ? value.states : undefined);
    routes[route] = {dark: value.dark === true, ...(example === undefined ? {} : {example}), ...states};
  }
  return {routes};
}

export function sourceHasDarkTheme(files: readonly {text: string}[]): boolean {
  const blob = files.map(file => file.text).join('\n');
  return /prefers-color-scheme\s*:\s*dark|data-theme|color-scheme\s*:/i.test(blob);
}

export type PlannedRoute = {
  route: string;
  themes: Array<'claro' | 'escuro'>;
  states: DesignStateReach[];
  loginState: boolean;
  skipped?: string;
};

/**
 * Rota com parâmetro entra só com exemplo concreto no config ou já resolvido na descoberta.
 * Sem url ou acoes, o relatório fica com "não capturado" e a captura é só o padrão.
 * logado sem url não entra no plano; wantsLogin avisa o host.
 */
export function planDesignRoutes(input: {
  discovered: readonly {route: string}[];
  dynamicSkipped: readonly string[];
  config: DesignProjectConfig;
  darkInSource: boolean;
}): {planned: PlannedRoute[]; notes: string[]; wantsLogin: boolean} {
  const notes: string[] = [];
  const planned: PlannedRoute[] = [];
  const seen = new Set<string>();
  for (const item of input.discovered) {
    if (seen.has(item.route)) continue;
    seen.add(item.route);
    const config = input.config.routes[item.route];
    const dark = input.darkInSource || config?.dark === true;
    planned.push({
      route: item.route,
      themes: dark ? ['claro', 'escuro'] : ['claro'],
      states: plannedReaches(config),
      loginState: config?.loginState === true,
    });
  }
  for (const route of input.dynamicSkipped) {
    const config = input.config.routes[route];
    if (config?.example) {
      if (seen.has(config.example)) continue;
      seen.add(config.example);
      const dark = input.darkInSource || config.dark;
      planned.push({
        route: config.example,
        themes: dark ? ['claro', 'escuro'] : ['claro'],
        states: plannedReaches(config),
        loginState: config.loginState === true,
      });
      notes.push(`A rota ${route} usou o exemplo ${config.example}.`);
      continue;
    }
    notes.push(`Rota ${route} pulada: sem exemplo em design.config.json.`);
  }
  for (const route of planned) {
    pushStateNote(notes, route.route, declaredRoute(input.config, route.route));
  }
  return {planned, notes, wantsLogin: planned.some(route => route.loginState)};
}

function plannedReaches(config: DesignRouteConfig | undefined): DesignStateReach[] {
  const states: DesignStateReach[] = [{name: 'padrao'}];
  if (config === undefined) return states;
  for (const reach of config.reaches) {
    if ('url' in reach) states.push({name: reach.name, url: reach.url});
    else states.push({name: reach.name, acoes: [...reach.acoes]});
  }
  return states;
}

function pushStateNote(notes: string[], route: string, declared: DesignRouteConfig | undefined): void {
  if (declared === undefined || (declared.reaches.length === 0 && declared.bareStates.length === 0)) {
    notes.push(uncapturedNote(route, DESIGN_DECLARED_STATES));
    return;
  }
  if (declared.bareStates.length === 0) return;
  notes.push(uncapturedNote(route, DESIGN_DECLARED_STATES.filter(name => declared.bareStates.includes(name))));
}

function uncapturedNote(route: string, names: readonly string[]): string {
  return `${route}: estado ${joinPt(names)} não capturado.`;
}

function joinPt(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}
