import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { PersonalPushControl } from '@/components/personal-push-control'
import { agentControlFetch } from './settings/agent-control-fetch'

const pageSchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1),
    role: z.enum(['owner', 'manager']),
    text: z.string(),
    createdAt: z.string(),
  })),
  next: z.string().regex(/^[0-9]{1,15}$/).nullable(),
})

type PanelMessage = z.infer<typeof pageSchema>['messages'][number]
type Pending = { clientId: string; text: string; phase: 'sending' | 'retry'; known: Set<string> }

const QUICK = [
  { label: 'Aprovar', text: 'aprovar', confirm: false },
  { label: 'Descartar', text: 'descartar', confirm: true },
  { label: 'Parar', text: 'pare', confirm: true },
  { label: 'Equipe', text: 'equipe', confirm: false },
] as const

function newClientId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function mergeMessages(current: PanelMessage[], incoming: PanelMessage[]): PanelMessage[] {
  if (incoming.length === 0) return current
  const seen = new Set(current.map((message) => message.id))
  const extra = incoming.filter((message) => !seen.has(message.id))
  return extra.length === 0 ? current : [...current, ...extra]
}

/** Drops a pending row once a new owner message with the same text shows up in the read. */
function dropEchoed(messages: PanelMessage[], pending: Pending[]): Pending[] {
  const used = new Set<string>()
  return pending.filter((item) => {
    const match = messages.find((message) =>
      message.role === 'owner' && message.text === item.text && !item.known.has(message.id) && !used.has(message.id))
    if (!match) return true
    used.add(match.id)
    return false
  })
}

export function ConversaRoute() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const [text, setText] = useState(() => searchParams.get('texto') ?? '')
  const [confirm, setConfirm] = useState<'descartar' | 'pare' | null>(null)
  const [syncError, setSyncError] = useState('')
  const [sendError, setSendError] = useState('')
  const cursor = useRef<string | null>(null)
  const readFailures = useRef(0)
  const readFailedAt = useRef<number | null>(null)
  const messagesRef = useRef(messages)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const busy = useRef(false)
  const inflight = useRef(new Set<string>())
  const mounted = useRef(true)
  const clearedTexto = useRef(false)
  messagesRef.current = messages

  useEffect(() => {
    if (clearedTexto.current) return
    clearedTexto.current = true
    if (!searchParams.has('texto')) return
    const next = new URLSearchParams(searchParams)
    next.delete('texto')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    setPending((current) => dropEchoed(messages, current))
  }, [messages])

  const noteReadFailure = useCallback(() => {
    readFailures.current += 1
    if (readFailedAt.current === null) readFailedAt.current = Date.now()
    const quietFor = Date.now() - readFailedAt.current
    if (quietFor >= 30_000) setSyncError('Não foi possível atualizar.')
    else if (readFailures.current >= 3) setSyncError('Reconectando…')
    else setSyncError('')
  }, [])

  const noteReadSuccess = useCallback(() => {
    readFailures.current = 0
    readFailedAt.current = null
    setSyncError('')
  }, [])

  const pull = useCallback(async () => {
    if (document.visibilityState === 'hidden' || busy.current) return
    busy.current = true
    const after = cursor.current
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (after) params.set('after', after)
      const response = await agentControlFetch(`/api/v1/ac/personal/conversation?${params}`, { cache: 'no-store' })
      if (!mounted.current) return
      if (response.status === 401) {
        queryClient.setQueryData(['ac-auth-status'], null)
        return
      }
      if (!response.ok) {
        noteReadFailure()
        return
      }
      const page = pageSchema.parse(await response.json())
      if (page.next) cursor.current = page.next
      setMessages((current) => after ? mergeMessages(current, page.messages) : page.messages)
      noteReadSuccess()
    } catch {
      if (mounted.current) noteReadFailure()
    } finally {
      busy.current = false
    }
  }, [noteReadFailure, noteReadSuccess, queryClient])

  useEffect(() => {
    mounted.current = true
    let timer = 0
    const stop = () => {
      if (timer) window.clearInterval(timer)
      timer = 0
    }
    const start = () => {
      stop()
      if (document.visibilityState !== 'visible') return
      timer = window.setInterval(() => { void pull() }, 3000)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void pull()
        start()
      } else stop()
    }
    void pull()
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      mounted.current = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pull])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, pending])

  async function deliver(body: string, clientId: string) {
    const value = body.slice(0, 8000)
    if (!value.trim() || inflight.current.has(clientId)) return
    inflight.current.add(clientId)
    stick.current = true
    setSendError('')
    setPending((current) => {
      const known = current.find((item) => item.clientId === clientId)?.known ?? new Set(messagesRef.current.map((message) => message.id))
      const next = current.filter((item) => item.clientId !== clientId)
      return [...next, { clientId, text: value, phase: 'sending', known }]
    })
    try {
      const response = await agentControlFetch('/api/v1/ac/personal/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value, clientId }),
        cache: 'no-store',
      })
      if (response.status === 401) {
        queryClient.setQueryData(['ac-auth-status'], null)
        return
      }
      if (!response.ok) {
        setPending((current) => current.map((item) => item.clientId === clientId ? { ...item, phase: 'retry' } : item))
        setSendError('Não foi possível enviar.')
        return
      }
      void pull()
    } catch {
      setPending((current) => current.map((item) => item.clientId === clientId ? { ...item, phase: 'retry' } : item))
      setSendError('Sem rede.')
    } finally {
      inflight.current.delete(clientId)
    }
  }

  function sendDraft() {
    const value = text
    if (!value.trim()) return
    setText('')
    void deliver(value, newClientId())
  }

  function onQuick(entry: (typeof QUICK)[number]) {
    if (entry.confirm) {
      setConfirm(entry.text)
      return
    }
    void deliver(entry.text, newClientId())
  }

  const notice = sendError || syncError

  return (
    <div data-route="conversa" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b px-2 py-1">
        <PersonalPushControl />
      </div>
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current
          if (!el) return
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
        }}
        aria-label="Mensagens"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>
        ) : null}
        {messages.map((message) => {
          const mine = message.role === 'owner'
          const when = clock(message.createdAt)
          return (
            <article key={message.id} className={cn('flex max-w-[85%] flex-col gap-0.5', mine ? 'ml-auto items-end' : 'mr-auto items-start')}>
              <p className="text-xs text-muted-foreground">{mine ? 'Você' : 'Gerente'}{when ? ` · ${when}` : ''}</p>
              <p className={cn('whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm', mine ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>{message.text}</p>
            </article>
          )
        })}
        {pending.map((item) => (
          <article key={item.clientId} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
            <p className="text-xs text-muted-foreground">Você · {item.phase === 'sending' ? 'enviando…' : 'não enviou'}</p>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{item.text}</p>
            {item.phase === 'retry' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => { void deliver(item.text, item.clientId) }}>Tentar de novo</Button>
            ) : null}
          </article>
        ))}
      </div>
      <form
        className="sticky bottom-0 flex flex-col gap-2 border-t bg-background px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          sendDraft()
        }}
      >
        {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        <div className="flex flex-wrap gap-2">
          {QUICK.map((entry) => (
            <Button key={entry.text} type="button" variant="outline" className="min-h-11" onClick={() => onQuick(entry)}>{entry.label}</Button>
          ))}
        </div>
        {confirm ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{confirm === 'pare' ? 'Parar a execução?' : 'Descartar a proposta?'}</span>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                const value = confirm
                setConfirm(null)
                void deliver(value, newClientId())
              }}
            >Confirmar</Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirm(null)}>Cancelar</Button>
          </div>
        ) : null}
        <Textarea
          aria-label="Mensagem"
          placeholder="Mensagem para o gerente"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            sendDraft()
          }}
        />
        <Button type="submit" className="min-h-11 self-end" disabled={!text.trim()}>Enviar</Button>
      </form>
    </div>
  )
}
