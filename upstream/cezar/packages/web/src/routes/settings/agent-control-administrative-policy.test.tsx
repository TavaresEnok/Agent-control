import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {AgentControlAdministrativePolicy} from './agent-control-administrative-policy'
afterEach(cleanup)
it('only publishes registered operations with known managers and permits an explicit empty policy',()=>{
 const publish=vi.fn(),operation={id:'fixture.operation',version:1,executorDigest:'a'.repeat(64),receiptKeyFingerprint:'b'.repeat(64)}
 render(<AgentControlAdministrativePolicy view={{policies:[],operations:[operation],managerProfileIds:['manager-known'],recentOperations:[]}} canEdit busy={false} onPublish={publish}/>)
 fireEvent.click(screen.getByText('fixture.operation · versão 1'))
 const button=screen.getByText('Publicar política administrativa') as HTMLButtonElement
 expect(button.disabled).toBe(true)
 fireEvent.click(screen.getByText('manager-known'))
 expect(button.disabled).toBe(false);fireEvent.click(button)
 expect(publish).toHaveBeenLastCalledWith({expectedRevision:0,policy:{operations:[{...operation,managerProfileIds:['manager-known']}]}})
 fireEvent.click(screen.getByText('Limpar operações da política'));fireEvent.click(button)
 expect(publish).toHaveBeenLastCalledWith({expectedRevision:0,policy:{operations:[]}})
})
