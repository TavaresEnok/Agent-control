import {cleanup,renderHook,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
const mocks=vi.hoisted(()=>({write:vi.fn()}))
vi.mock('@/api/queries',()=>({useWorkspaceUiState:()=>({data:{}}),useHealth:()=>({data:undefined})}))
vi.mock('./onboarding-kit',async(importOriginal)=>({...await importOriginal<typeof import('./onboarding-kit')>(),useOnboardingWrite:()=>mocks.write}))
import {useFeatureNews} from './first-run'
afterEach(()=>{cleanup();vi.unstubAllEnvs();mocks.write.mockReset()})
it('does not record native feature-news visits in managed mode, while standalone still records them',async()=>{
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','1')
 const managed=renderHook(()=>useFeatureNews('/settings/agent-control'))
 expect(mocks.write).not.toHaveBeenCalled()
 managed.unmount()
 vi.stubEnv('VITE_AGENT_CONTROL_MANAGED','0')
 renderHook(()=>useFeatureNews('/settings/agent-control'))
 await waitFor(()=>expect(mocks.write).toHaveBeenCalledTimes(1))
})
