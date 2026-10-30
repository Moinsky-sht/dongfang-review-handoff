/** Async request ownership. Credentials and transport handles never enter persisted scope. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const scopes=new AsyncLocalStorage();
export const getArkScope=()=>scopes.getStore()||null;
export function createLocalArkScope(input={}) {
  return {jobRunId:'local-'+randomUUID(),operationId:randomUUID(),operationKind:'direct-model-call',
    purpose:input.purpose||'editorial',...input};
}
export function withArkScope(scope,action) {
  if(!scope||typeof action!=='function')throw new TypeError('Ark execution scope and action are required');
  const inherited=getArkScope()||{};
  const next={...inherited,...scope};
  if(next.binding)next.binding=Object.freeze({...next.binding});
  return scopes.run(Object.freeze(next),action);
}
export function recordArkAttempt(receipt) {
  const scope=getArkScope();
  if(Array.isArray(scope?.requestReceipts))scope.requestReceipts.push(receipt);
  if(scope?.allRequestReceipts!==scope?.requestReceipts&&Array.isArray(scope?.allRequestReceipts))scope.allRequestReceipts.push(receipt);
}
