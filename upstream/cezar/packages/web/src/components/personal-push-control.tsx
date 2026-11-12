import {useEffect, useState} from 'react'
import {BellIcon} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {agentControlFetch} from '@/routes/settings/agent-control-fetch'

const storageKey = 'ac-personal-push-id'

function iphoneOutsideApp() {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const iphone = /iPhone/.test(navigator.userAgent)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?: boolean}).standalone === true
  return iphone && !standalone
}

function keyBytes(value: string) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Bell on the managed conversation. The service worker is registered for the whole panel. */
export function PersonalPushControl() {
  const [open, setOpen] = useState(false)
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const iphone = iphoneOutsideApp()

  useEffect(() => {
    try { setSubscriptionId(localStorage.getItem(storageKey)) } catch { setSubscriptionId(null) }
  }, [])

  if (import.meta.env.VITE_AGENT_CONTROL_MANAGED !== '1') return null

  async function activate() {
    if (busy || iphone) return
    setBusy(true)
    setMessage('')
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setMessage('Este aparelho não recebe avisos.')
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setMessage('O navegador não permitiu os avisos.')
        return
      }
      const registration = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const listed = await agentControlFetch('/api/v1/ac/personal/push', {cache: 'no-store'})
      if (!listed.ok) throw new Error('PUSH_UNAVAILABLE')
      const page = await listed.json() as {publicKey?: unknown}
      if (typeof page.publicKey !== 'string' || !page.publicKey) throw new Error('PUSH_UNAVAILABLE')
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(page.publicKey),
      })
      const saved = await agentControlFetch('/api/v1/ac/personal/push/subscribe', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({subscription: subscription.toJSON(), label: 'este aparelho'}),
        cache: 'no-store',
      })
      if (!saved.ok) throw new Error('PUSH_UNAVAILABLE')
      const body = await saved.json() as {id?: unknown}
      if (typeof body.id !== 'string' || !body.id) throw new Error('PUSH_UNAVAILABLE')
      localStorage.setItem(storageKey, body.id)
      setSubscriptionId(body.id)
      setMessage('Avisos ativados neste aparelho.')
    } catch {
      setMessage('Não foi possível ativar os avisos neste aparelho.')
    } finally {
      setBusy(false)
    }
  }

  async function deactivate() {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      if (subscriptionId) await agentControlFetch('/api/v1/ac/personal/push/subscribe/' + encodeURIComponent(subscriptionId), {method: 'DELETE', cache: 'no-store'})
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
      await (await registration?.pushManager.getSubscription())?.unsubscribe()
      localStorage.removeItem(storageKey)
      setSubscriptionId(null)
      setMessage('Avisos desativados neste aparelho.')
    } catch {
      setMessage('Não foi possível desativar os avisos.')
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/push/test', {method: 'POST', cache: 'no-store'})
      setMessage(response.ok ? 'Teste enviado.' : 'Não foi possível enviar o teste.')
    } catch {
      setMessage('Não foi possível enviar o teste.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <Button type="button" variant="outline" size="icon" aria-label="Avisos" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <BellIcon />
      </Button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-sm">
          {iphone ? <p>No iPhone, instale o painel na tela inicial para receber avisos.</p> : null}
          {iphone ? null : <Button type="button" disabled={busy} onClick={() => { void activate() }}>Ativar avisos neste aparelho</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={() => { void deactivate() }}>Desativar</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => { void sendTest() }}>Enviar teste</Button>
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
