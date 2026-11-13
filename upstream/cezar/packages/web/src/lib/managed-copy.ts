/** Visible copy for the managed panel. Keys and stored labels stay in English. */
export function managedCopy(english: string, portuguese: string): string {
  return import.meta.env.VITE_AGENT_CONTROL_MANAGED === '1' ? portuguese : english
}
