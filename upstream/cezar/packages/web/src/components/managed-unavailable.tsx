import { Link } from '@/lib/project-router'

/** Direct hit on a surface the managed panel does not offer. */
export function ManagedUnavailable() {
  return (
    <div data-route="managed-unavailable" className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-foreground">Não disponível no Agent Control</p>
      <Link to="/conversa" className="text-sm text-foreground underline">Conversa</Link>
    </div>
  )
}
