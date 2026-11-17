import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { agentControlFetch } from './settings/agent-control-fetch'

export type AchadoCorrecaoProps = {
  runId: string
  achados: { id: string; title: string; status: string; file: string }[]
}

function podeCorrigir(status: string): boolean {
  return status === 'confirmado' || status === 'reaberto'
}

export function AchadoCorrecao({ runId, achados }: AchadoCorrecaoProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const escolhidos = selected.filter((id) => achados.some((achado) => achado.id === id && podeCorrigir(achado.status)))

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
    setNotice('')
  }

  async function corrigir() {
    if (busy || escolhidos.length === 0) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await agentControlFetch(`/api/v1/ac/personal/verificacoes/${encodeURIComponent(runId)}/corrigir`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ achadoIds: escolhidos }),
      })
      if (!response.ok) {
        setError('Não foi possível enviar o pedido de correção.')
        return
      }
      setSelected([])
      setNotice('Pedido de correção enviado ao gerente.')
    } catch {
      setError('Não foi possível enviar o pedido de correção.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Corrigir achados</h2>
      <p className="text-sm text-muted-foreground">
        Escolha os achados confirmados ou reabertos. O gerente recebe os caminhos de escrita, o teste de regressão e o critério de aceite.
      </p>
      {achados.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum achado nesta verificação.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {achados.map((achado) => {
            const aberto = podeCorrigir(achado.status)
            return (
              <li key={achado.id}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={escolhidos.includes(achado.id)}
                    disabled={!aberto || busy}
                    onChange={() => toggle(achado.id)}
                  />
                  <span>
                    <span className="font-medium">{achado.id}</span>
                    {' — '}
                    {achado.title}
                    <span className="block text-muted-foreground">{achado.file} · {achado.status}</span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <Button type="button" className="min-h-11 self-start" disabled={busy || escolhidos.length === 0} onClick={() => { void corrigir() }}>
        Corrigir
      </Button>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
    </section>
  )
}
