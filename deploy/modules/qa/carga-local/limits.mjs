export const limits = Object.freeze({
  routes: 3,
  manifestBytes: 4096,
  bodyBytes: 4096,
  vus: 2,
  iterationsPerVu: 4,
  phaseMs: 5000,
  processMs: 6500,
  totalMs: 24000,
  startupMs: 2000,
  requestMs: 1000,
  latencyMs: 250,
  controlP95Ms: 150,
  minimumDeltaMs: 150,
  recoveryMarginMs: 75,
});

export const phases = Object.freeze(['controle', 'degradada', 'recuperacao']);
export const requestsPerPhase = limits.vus * limits.iterationsPerVu;
