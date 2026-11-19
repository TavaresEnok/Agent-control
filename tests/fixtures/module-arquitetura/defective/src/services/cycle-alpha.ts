import {continueCycleChain} from './cycle-beta.js';

export function startCycleChain(step: number): number {
  if (step <= 0) return 0;
  return continueCycleChain(step - 1) + 1;
}
