import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ConnectionState, SelectorStore, ShellState } from '@forge/client-runtime'
import type { SessionRef } from '@forge/protocol/environment-v2'
import { useEnvironmentRegistry } from '@/lib/origin-store/environment-provider'
export function useSelectorStore<S,T>(store:SelectorStore<S>,selector:(state:S)=>T,dependencies?:readonly string[]):T {
  const subscribe=useCallback((listener:()=>void)=>store.subscribe(selector,listener,Object.is,dependencies),[store,selector,dependencies])
  const snapshot=useCallback(()=>selector(store.getSnapshot()),[store,selector])
  return useSyncExternalStore(subscribe,snapshot,snapshot)
}
export function useEnvironmentSelector<T>(environmentId:string,domain:'shell',selector:(s:ShellState)=>T,dependencies?:readonly string[]):T
export function useEnvironmentSelector<T>(environmentId:string,domain:'connection',selector:(s:ConnectionState)=>T,dependencies?:readonly string[]):T
export function useEnvironmentSelector<T>(environmentId:string,domain:'shell'|'connection',selector:((s:ShellState)=>T)|((s:ConnectionState)=>T),dependencies?:readonly string[]):T {
  const client=useEnvironmentRegistry().get(environmentId)
  return useSelectorStore(client[domain] as SelectorStore<ShellState|ConnectionState>,selector as (s:ShellState|ConnectionState)=>T,dependencies)
}
export function useEnvironmentCatalog(){return useSelectorStore(useEnvironmentRegistry().catalog,identity)}
export function useLogicalProjects(){return useSelectorStore(useEnvironmentRegistry().logicalProjects,identity)}
function identity<T>(value:T):T{return value}
export function useSessionDetail(ref:SessionRef|null){
  const registry=useEnvironmentRegistry()
  const lease=useMemo(()=>ref?registry.get(ref.environmentId).acquireDetail(ref.sessionId):null,[registry,ref?.environmentId,ref?.sessionId])
  useEffect(()=>()=>lease?.release(),[lease])
  const subscribe=useCallback((listener:()=>void)=>lease?.store.subscribe(identity,listener)??(()=>{}),[lease])
  const snapshot=useCallback(()=>lease?.store.getSnapshot()??null,[lease])
  return useSyncExternalStore(subscribe,snapshot,snapshot)
}
