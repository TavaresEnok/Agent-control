import {startCycleChain} from './cycle-alpha.js';

export function continueCycleChain(step: number): number {
  if (step <= 0) return 10;
  return startCycleChain(step - 1) + 2;
}
