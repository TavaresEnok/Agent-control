import {Refusal} from './contracts.ts';

export const DESIGN_DECLARED_STATES = ['vazio', 'carregando', 'erro', 'logado'] as const;
export type DesignDeclaredState = (typeof DESIGN_DECLARED_STATES)[number];

export type DesignRouteConfig = {
  example?: string;
  states: DesignDeclaredState[];
  dark: boolean;
};

export type DesignProjectConfig = {
  routes: Record<string, DesignRouteConfig>;
};

const STATE = new Set<string>(DESIGN_DECLARED_STATES);

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
    const states = Array.isArray(value.states) ? value.states.filter((item): item is DesignDeclaredState => typeof item === 'string' && STATE.has(item)) : [];
    if (Array.isArray(value.states) && states.length !== value.states.length) throw new Refusal('DESIGN_CONFIG_INVALID', 400);
    routes[route] = {states, dark: value.dark === true, ...(example === undefined ? {} : {example})};
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
  states: Array<'padrao' | DesignDeclaredState>;
  skipped?: string;
};

/**
 * Rota com parâmetro entra só com exemplo concreto no config ou já resolvido na descoberta.
 * Sem declaração de estado, o relatório fica com "não capturado" e a captura é só o padrão.
 */
export function planDesignRoutes(input: {
  discovered: readonly {route: string}[];
  dynamicSkipped: readonly string[];
  config: DesignProjectConfig;
  darkInSource: boolean;
}): {planned: PlannedRoute[]; notes: string[]} {
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
      states: ['padrao', ...(config?.states ?? [])],
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
        states: ['padrao', ...config.states],
      });
      notes.push(`A rota ${route} usou o exemplo ${config.example}.`);
      continue;
    }
    notes.push(`Rota ${route} pulada: sem exemplo em design.config.json.`);
  }
  for (const route of planned) {
    const declared = declaredRoute(input.config, route.route);
    if (declared === undefined || declared.states.length === 0) {
      notes.push(`${route.route}: estado vazio, carregando, erro e logado não capturado.`);
    }
  }
  return {planned, notes};
}
