/** Visible product name. Managed panel is always Agent Control; Cezar stays Cezar. */
export function panelBrandName(configured?: string | null): string {
  if (import.meta.env.VITE_AGENT_CONTROL_MANAGED === '1') return 'Agent Control'
  const trimmed = configured?.trim()
  return trimmed ? trimmed : 'cezar'
}
