import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
vi.mock('@xyflow/react', () => ({
 Background: () => null, BackgroundVariant: { Dots: 'dots' }, Controls: () => null,
 MarkerType: { ArrowClosed: 'arrowclosed' }, ReactFlowProvider: ({children}: {children: React.ReactNode}) => children,
 ReactFlow: ({nodes, onNodeClick}: {nodes: {id:string}[], onNodeClick: (event: unknown, node: {id:string}) => void}) => <button onClick={() => onNodeClick(null, nodes.find(n => n.id === 'implement')!)}>Selecionar nó</button>,
 Handle: () => null, Position: {Left:'left',Right:'right',Top:'top',Bottom:'bottom'}, BaseEdge: () => null,
 EdgeLabelRenderer: ({children}: {children: React.ReactNode}) => children,
}))
vi.mock('@/lib/project-router', () => ({ Link: ({to, children}: {to:string,children:React.ReactNode}) => <a href={to}>{children}</a> }))
vi.mock('../task-thread/run-header', () => ({RunHeader: () => null}))
vi.mock('./workflow-graph', () => ({FloatingPanel: ({children}: {children:React.ReactNode}) => <div>{children}</div>}))
import { TaskGraphView } from './task-graph'
afterEach(cleanup)
it('keeps node identity and state aligned between graph details and cards across a run update', () => {
 const run = {id:'run', steps:[{id:'implement', name:'Implement', kind:'agent', status:'running', iterations:1, tokensUsed:0, profileId:'profile-1'}], workflowDef:{name:'test', source:'file', steps:[{id:'implement', name:'Implement', prompt:'test'}]}} as unknown as ApiRun
 const {rerender} = render(<TaskGraphView run={run} embedded />)
 fireEvent.click(screen.getByText('Selecionar nó'))
 expect(screen.getByText('implement')).toBeTruthy()
 expect(screen.getByText('running')).toBeTruthy()
 expect(screen.getByText('profile-1')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Cartões'}))
 const list=screen.getByRole('list',{name:'Etapas do workflow'})
 expect(within(list).getByText('Identificador: implement')).toBeTruthy()
 expect(within(list).getByText('Estado: running')).toBeTruthy()
 expect(within(list.querySelector('[data-node-id=implement]')!).getByText('Responsável: não informado')).toBeTruthy()
 expect(within(list).getByText('Perfil da sessão: profile-1')).toBeTruthy()
 expect(screen.getByText(/Atraso de projeção: indisponível/)).toBeTruthy()
 rerender(<TaskGraphView run={{...run, steps:run.steps.map(step=>({...step,status:'done'}))}} embedded />)
 expect(within(list).getByText('Estado: done')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Grafo'}))
 expect(screen.getByText('done')).toBeTruthy()
})
