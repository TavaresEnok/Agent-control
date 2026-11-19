/** A valid parameter.
 * @param legacy valid parameter
 */
export function first(legacy: string) { return legacy; }
/** The previous name was `@param legacy`.
 * @param legacy no longer accepted
 */
export function second(current: string) { return current; }
/** Billing. */
export class Billing {
  /** Charge used to document `@param legacy`.
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

/** Example with a comment opener.
 * ```js
 * const text = "/**";
 * ```
 * @param legacy no longer accepted
 */
export function sample(current: string) { return current; }
