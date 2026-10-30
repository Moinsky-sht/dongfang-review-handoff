/** Exact model-version bindings. This module never reads credentials or calls a provider. */
import {createHash} from 'node:crypto';

// The resolved registry supplies exact IDs. Version formats are provider-owned;
// dates, prefixes and short numeric versions cannot be inferred here.
const modelName=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const endpointId=/^ep-\d{14}-[a-z0-9]{1,64}$/;
const fail=(code,message)=>Object.assign(new Error(message),{code,status:400});
const sha=value=>createHash('sha256').update(value).digest('hex');

// JSON.parse alone loses duplicate object keys. Parse this deliberately flat
// string-to-string contract before normalization, including escaped keys.
function flatBindings(raw){
 let at=0;const seen=new Set(),pairs=[];
 const ws=()=>{while(/\s/.test(raw[at]||'')&&at<raw.length)at++;};
 const token=()=>{ws();const match=/^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(raw.slice(at));
  if(!match)throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS 必须为模型版本与接入点的 JSON 字符串映射');
  at+=match[0].length;return JSON.parse(match[0]);};
 ws();if(raw[at++]!=='{')throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS 必须为 JSON 对象');
 ws();if(raw[at]==='}')at++;else for(;;){const name=token();if(seen.has(name))throw fail('ARK_MODEL_ENDPOINTS_DUPLICATE','ARK_MODEL_ENDPOINTS 中有重复模型版本');seen.add(name);
  ws();if(raw[at++]!==':')throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS JSON 格式无效');
  pairs.push([name,token()]);ws();const next=raw[at++];if(next==='}')break;if(next!==',')throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS JSON 格式无效');}
 ws();if(at!==raw.length)throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS JSON 格式无效');return pairs;
}

export function createArkModelEndpointConfig(raw){
 if(raw==null||raw==='')return null;
 if(typeof raw!=='string')throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS 必须为 JSON 字符串');
 try{JSON.parse(raw);}catch{throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS JSON 格式无效');}
 const pairs=flatBindings(raw),endpoints=new Set();
 if(!pairs.length)throw fail('ARK_MODEL_ENDPOINTS_INVALID','ARK_MODEL_ENDPOINTS 不能是空映射');
 for(const[name,endpoint]of pairs){
  if(!modelName.test(name)||name.startsWith('ep-'))throw fail('ARK_MODEL_NAME_INVALID','ARK_MODEL_ENDPOINTS 必须明确登记合法模型 ID');
  if(!endpointId.test(endpoint))throw fail('ARK_MODEL_ENDPOINT_INVALID','ARK_MODEL_ENDPOINTS 接入点 ID 格式无效');
  if(endpoints.has(endpoint))throw fail('ARK_MODEL_ENDPOINTS_DUPLICATE','一个接入点不能重复绑定不同模型版本');endpoints.add(endpoint);
 }
 const bindings=Object.freeze(Object.fromEntries(pairs.sort(([a],[b])=>a.localeCompare(b,'en'))));
 return Object.freeze({schemaVersion:1,bindings,sha256:sha(JSON.stringify(bindings))});
}

/** Revalidate archived configuration rather than consulting current environment. */
export function verifyArkModelEndpointConfig(config){
 if(config==null)return null;
 if(config.schemaVersion!==1||!config.bindings||typeof config.bindings!=='object'||Array.isArray(config.bindings)
    ||Object.keys(config).sort().join(',')!=='bindings,schemaVersion,sha256')throw fail('ARK_MODEL_ENDPOINTS_INVALID','已登记接入点配置身份无效');
 const checked=createArkModelEndpointConfig(JSON.stringify(config.bindings));
 if(checked.sha256!==config.sha256)throw fail('ARK_MODEL_ENDPOINTS_INVALID','已登记接入点配置指纹不一致');return checked;
}

export function resolveArkModelEndpoint(requestedModel,config){
 if(typeof requestedModel!=='string'||!requestedModel||requestedModel.trim()!==requestedModel)throw fail('ARK_MODEL_NAME_INVALID','审阅模型 ID 无效');
 if(!config)return{schemaVersion:1,requestedModel,resolvedModel:requestedModel,modelName:requestedModel,mode:'legacy-model',configFingerprint:null};
 const checked=verifyArkModelEndpointConfig(config);
 const named=Object.hasOwn(checked.bindings,requestedModel)?requestedModel:null;
 const registered=named||Object.keys(checked.bindings).find(name=>checked.bindings[name]===requestedModel);
 if(!registered)throw fail('ARK_MODEL_ENDPOINT_UNREGISTERED','所选精确模型版本未登记可调用接入点，请刷新并选择已登记模型');
 return{schemaVersion:1,requestedModel,resolvedModel:checked.bindings[registered],modelName:registered,mode:'configured-endpoint',configFingerprint:checked.sha256};
}
