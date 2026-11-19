/** A valid parameter.
 * @param legacy valid parameter
 */
export function first(legacy: string) { return legacy; }
/** Obsolete parameter.
 * @param legacy no longer accepted
 */
export function second(current: string) { return current; }
/** Billing. */
export class Billing {
  /** Charge.
   * @param legacy no longer accepted
   * @see {@link MissingCharge}
   */
  charge(current: string) { return current; }
  /** Private implementation. */
  private hidden() {}
}
/** Public contract. */
export interface Contract {
  /** Submit. */
  submit(value: string): void;
}
/** Billing value. */
export const billing = 1;
