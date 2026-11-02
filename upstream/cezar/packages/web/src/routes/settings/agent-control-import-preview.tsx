import {useState} from 'react'
import {z} from 'zod'
import {Button} from '@/components/ui/button'
import {agentControlFetch} from './agent-control-fetch'
import {BACKUP_MANIFEST_LIMIT,downloadPreviewReport,inspectBackupManifest} from './agent-control-backup-preview'

const reportSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('import'),projectId:z.string().uuid(),inputSha256:z.string().regex(/^[a-f0-9]{64}$/),bundleDigest:z.string().regex(/^[a-f0-9]{64}$/),counts:z.object({contexts:z.number(),messages:z.number(),runs:z.number(),sourcePaused:z.number()}),checks:z.object({schemaValid:z.literal(true),projectOwner:z.literal(true),sessionOwnershipVerified:z.literal(false),keysVerified:z.literal(false),ciphertextVerified:z.literal(false)}),executionEnabled:z.literal(false)})
type Report=z.infer<typeof reportSchema>
/** Import is a read-only preview; no keys or selected file contents are stored. */
export function AgentControlImportPreview(){
 const [file,setFile]=useState<File|null>(null),[report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [manifest,setManifest]=useState<File|null>(null),[backupReport,setBackupReport]=useState<Awaited<ReturnType<typeof inspectBackupManifest>>|null>(null),[backupError,setBackupError]=useState('')
 const inspect=async()=>{
  if(!file)return
  setReport(null);setError('')
  if(file.size>192*1024){setError('Arquivo excede o limite de 192 KiB.');return}
  setBusy(true)
  try{
   const response=await agentControlFetch('/api/v1/ac/import/preview',{method:'POST',headers:{'content-type':'application/json'},body:await file.arrayBuffer()})
   if(!response.ok)throw Error('Não foi possível validar o arquivo para este projeto.')
   setReport(reportSchema.parse(await response.json()))
  }catch{setError('Não foi possível validar o arquivo para este projeto.')}
  finally{setBusy(false)}
 }
 return <section aria-label="Prévia de importação" className="min-w-0 break-words">
  <h3>Importação e restauração</h3>
  <p>Confira um pacote JSON de importação. A prévia não importa dados nem verifica acesso às sessões ou chaves.</p>
  <label>Pacote JSON <input type="file" accept="application/json,.json" onChange={event=>{setFile(event.target.files?.[0]??null);setReport(null);setError('')}} /></label>
  <Button type="button" disabled={!file||busy} onClick={()=>void inspect()}>{busy?'Validando…':'Ver prévia'}</Button>
  {error&&<p role="alert">{error}</p>}
  {report&&<div><p>Prévia válida para este projeto. Nenhum dado foi importado.</p>
   <p>Contextos: {report.counts.contexts}; mensagens: {report.counts.messages}; execuções: {report.counts.runs}; contextos pausados na origem: {report.counts.sourcePaused}.</p>
   <p>SHA-256 do arquivo: <code className="break-all">{report.inputSha256}</code></p><p>Digest do pacote: <code className="break-all">{report.bundleDigest}</code></p>
   <p>Sessões, chaves e conteúdo cifrado ainda não foram verificados.</p><Button type="button" onClick={()=>downloadPreviewReport(report)}>Baixar relatório da prévia</Button></div>}
  <h4>Prévia de restauração do laboratório</h4>
  <p>Selecione o MANIFEST.json de um backup sintético do laboratório. A análise acontece neste navegador.</p>
  <label>Manifesto JSON <input type="file" accept="application/json,.json" onChange={event=>{setManifest(event.target.files?.[0]??null);setBackupReport(null);setBackupError('')}} /></label>
  <Button type="button" disabled={!manifest} onClick={()=>{void (async()=>{setBackupReport(null);setBackupError('');try{if(!manifest||manifest.size>BACKUP_MANIFEST_LIMIT)throw Error();setBackupReport(await inspectBackupManifest(new Uint8Array(await manifest.arrayBuffer())))}catch{setBackupError('Manifesto inválido ou acima do limite de 192 KiB.')}})()}}>Verificar manifesto</Button>
  {backupError&&<p role="alert">{backupError}</p>}
  {backupReport&&<div><p>Arquivos: {backupReport.counts.files}; bytes declarados: {backupReport.counts.sourceBytes}; fontes opcionais ausentes: {backupReport.counts.missingOptional}.</p>
   <p>SHA-256 do manifesto: <code className="break-all">{backupReport.inputSha256}</code></p>
   <p>O arquivo de backup, sua autenticação e o banco não foram verificados. Restauração não está habilitada.</p>
   <Button type="button" onClick={()=>downloadPreviewReport(backupReport)}>Baixar relatório do manifesto</Button></div>}
  <p>Exportação de backup e restauração de dados não estão disponíveis por esta tela.</p>
 </section>
}
