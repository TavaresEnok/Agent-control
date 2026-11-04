import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsField } from './settings-field'

const narrowQuery = '(max-width: 390px)'
export type ProjectTemplateSnapshot =
 | { workflow: 'baseline-synthetic-v1' }
 | { workflow: 'engineering-synthetic-v1' | 'semantic-proposal-v1'; qualityRevision: number; targetRef: string }
 | { workflow: 'engineering-native-v1'; qualityRevision: number; targetRef: string; writePaths: string[]; execution?: 'root' | 'plan' }
export type ProjectTemplateRow = {
 templateId: string
 revision: number
 headRevision: number
 name: string
 digest: string
 snapshot: { workflow: string }
}
export type ProjectTemplatePublishPayload = {
 templateId: string
 expectedRevision: number
 name: string
 template: ProjectTemplateSnapshot
 digest: string
}
export type ProjectTemplateApplyPayload = {
 templateId: string
 revision: number
 expectedRevision: number
 expectedContextRevision: number
}

function canonical(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
 if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}'
 const text = JSON.stringify(value)
 if (text === undefined) throw Error('PROJECT_TEMPLATE_SNAPSHOT_INVALID')
 return text
}

/** Same canonical bytes the control service hashes. Settings only; no account or transcript. */
export async function projectTemplateDigest(template: ProjectTemplateSnapshot) {
 const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(template)))
 return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function conversationTemplateDraft(input: { workflow: string; qualityRevision: string; targetRef: string; nativePaths: string }): ProjectTemplateSnapshot | null {
 if (input.workflow === 'baseline-synthetic-v1') return { workflow: 'baseline-synthetic-v1' }
 const qualityRevision = Number(input.qualityRevision)
 if (!Number.isInteger(qualityRevision) || qualityRevision < 1 || !input.targetRef) return null
 if (input.workflow === 'engineering-synthetic-v1' || input.workflow === 'semantic-proposal-v1') return { workflow: input.workflow, qualityRevision, targetRef: input.targetRef }
 if (input.workflow === 'engineering-native-v1') {
  const writePaths = input.nativePaths.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (writePaths.length === 0) return null
  return { workflow: 'engineering-native-v1', qualityRevision, targetRef: input.targetRef, writePaths }
 }
 return null
}

function workflowLabel(workflow: string) {
 if (workflow === 'baseline-synthetic-v1') return 'Fluxo básico de teste'
 if (workflow === 'engineering-synthetic-v1') return 'Implementação de teste'
 if (workflow === 'semantic-proposal-v1') return 'Proposta do gerente'
 if (workflow === 'engineering-native-v1') return 'Implementação com QA e revisão'
 return 'Fluxo'
}

function useNarrow() {
 const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(narrowQuery).matches)
 useEffect(() => {
  if (typeof matchMedia !== 'function') return
  const media = matchMedia(narrowQuery)
  const update = () => setNarrow(media.matches)
  update()
  media.addEventListener('change', update)
  return () => media.removeEventListener('change', update)
 }, [])
 return narrow
}

export function AgentControlProjectTemplates({ canManage, templates, truncated, draft, expectedContextRevision, busy, statusMessage, onPublish, onApply }: {
 canManage: boolean
 templates?: readonly ProjectTemplateRow[]
 truncated?: boolean
 draft: ProjectTemplateSnapshot | null
 expectedContextRevision: number
 busy: boolean
 statusMessage: string | null
 onPublish: (payload: ProjectTemplatePublishPayload) => void
 onApply: (payload: ProjectTemplateApplyPayload) => void
}) {
 const narrow = useNarrow()
 const [name, setName] = useState('')
 const [draftId] = useState(() => crypto.randomUUID())
 const [selectedId, setSelectedId] = useState('')
 const selected = templates?.find(item => item.templateId === selectedId)
 const localStatus = statusMessage !== null && (statusMessage.startsWith('PROJECT_TEMPLATE_') || statusMessage === 'TEMPLATE_REVISION_CONFLICT' || statusMessage === 'QUALITY_POLICY_CONFLICT' || statusMessage === 'QUALITY_POLICY_REQUIRED')
 const conflict = statusMessage === 'PROJECT_TEMPLATE_REVISION_CONFLICT' || statusMessage === 'TEMPLATE_REVISION_CONFLICT'
 const nameReady = name.trim().length > 0 && name.trim().length <= 80
 async function publish(templateId: string, expectedRevision: number) {
  if (!draft || !nameReady || busy || !canManage) return
  onPublish({ templateId, expectedRevision, name: name.trim(), template: draft, digest: await projectTemplateDigest(draft) })
 }
 return <SettingsField title="Templates do projeto" hint="Uma revisão salva aqui pode ser copiada para outra conversa do mesmo projeto. A cópia fica congelada.">
  <div className="flex min-w-0 max-w-full flex-col gap-2" data-viewport={narrow ? 'narrow' : 'desktop'}>
   <p className="text-sm">Salvar ou reutilizar não inicia execução, não chama modelo e não publica um plano.</p>
   {templates === undefined && <p role="status">O catálogo de templates do projeto não veio nesta resposta.</p>}
   {templates !== undefined && <>
    <p className="text-xs text-muted-foreground">A lista mostra no máximo 100 revisões, em ordem de nome, identidade e revisão.{truncated ? ' Há revisões além deste limite.' : ''}</p>
    {templates.length === 0 && <p role="status">Nenhum template de projeto nesta lista.</p>}
    <ul className="flex min-w-0 flex-col gap-2">{templates.map(item => <li key={`${item.templateId}:${item.revision}`} className="min-w-0 break-words rounded-md border p-3 text-sm">
     <label className="flex min-w-0 items-start gap-2"><input type="radio" name="project-template-identity" checked={selectedId === item.templateId} onChange={() => setSelectedId(item.templateId)}/>
      <span className="min-w-0">{item.name} · {workflowLabel(item.snapshot.workflow)} · revisão {item.revision} de {item.headRevision}</span></label>
     <p className="break-all font-mono text-xs">{item.digest}</p>
     <Button type="button" className="mt-2 min-h-11 max-w-full" disabled={!canManage || busy} onClick={() => onApply({ templateId: item.templateId, revision: item.revision, expectedRevision: item.headRevision, expectedContextRevision })}>Reutilizar revisão {item.revision}</Button>
    </li>)}</ul>
    {canManage ? <form className="flex min-w-0 max-w-full flex-col gap-2" onSubmit={event => { event.preventDefault(); void publish(draftId, 0) }}>
     <label className="flex min-w-0 flex-col gap-1">Nome do template do projeto
      <Input aria-label="Nome do template do projeto" value={name} onChange={event => setName(event.target.value)} maxLength={80} required className="min-w-0 max-w-full"/>
     </label>
     {!draft && <p role="status">Complete o fluxo da conversa antes de salvar o template.</p>}
     <Button type="submit" className="min-h-11 max-w-full" disabled={busy || !draft || !nameReady}>Salvar fluxo atual como template do projeto</Button>
     <Button type="button" className="min-h-11 max-w-full" disabled={busy || !draft || !nameReady || !selected} onClick={() => { if (selected) void publish(selected.templateId, selected.headRevision) }}>Publicar nova revisão do template selecionado</Button>
    </form> : <p role="status">Somente o titular do projeto publica ou reutiliza templates.</p>}
   </>}
   {conflict && <p role="alert">A revisão mudou. Recarregue a conversa e confira a revisão antes de repetir.</p>}
   {localStatus && !conflict && <p role="alert">{statusMessage}</p>}
  </div>
 </SettingsField>
}
