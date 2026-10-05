import { expect, test } from 'bun:test'
const {resolveHookPermissionDecision}=await import('./toolHooks.js')

test('a live background guard preserves foreground hook allow and checks late background calls',async()=>{
  let background=false, checks=0
  const context:any={requireCanUseTool:()=>background,getAppState:()=>({toolPermissionContext:{mode:'default',alwaysAllowRules:{},alwaysDenyRules:{},alwaysAskRules:{},additionalWorkingDirectories:new Map()}})}
  const tool:any={name:'ListMcpResources'}
  const check:any=async()=>{checks++;return {behavior:'deny',message:'not available in background'}}
  const invoke=(decision:any)=>resolveHookPermissionDecision(decision,tool,{},context,check,{} as any,'test-call')
  expect((await invoke({behavior:'allow',updatedInput:{server:'fixture'}})).decision.behavior).toBe('allow')
  expect(checks).toBe(0)
  background=true
  const result=await invoke({behavior:'allow'})
  expect(result.decision.behavior).toBe('deny')
  expect(checks).toBe(1)
  expect((await invoke({behavior:'deny',message:'explicit hook deny'})).decision.behavior).toBe('deny')
  expect(checks).toBe(1)
})
