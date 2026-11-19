/** First.
 * @param legacy valid parameter
 */
export function first(legacy: string) { return legacy; }
/** Second.
 * @param current current parameter
 */
export function second(current: string) { return current; }
/** Billing. */
export class Billing {
  /** Charge.
   * @param current current parameter
   */
  charge(current: string) { return current; }
}
/** Public contract. */
export interface Contract {
  /** Submit. */
  submit(value: string): void;
}
/** Billing value. */
export const billing = 1;
