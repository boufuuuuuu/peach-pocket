/* Opt-in encrypted catalog sync through a user-supplied CORS-enabled HTTPS WebDAV file.
   This does not send video blobs. Credentials are never persisted, and only the encrypted payload is uploaded. */
(function(root,factory){const mod=factory();if(typeof module==='object'&&module.exports)module.exports=mod;else root.PeachCloudSync=mod;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function validEndpoint(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!u.hostname.includes('.')||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)||!u.pathname.toLowerCase().endsWith('.json')||u.search)return '';u.hash='';return u.href;}catch{return '';}}
 function merge(local,remote){
  const map=new Map(local.map(x=>[x.id,{...x}]));
  for(const r of remote){if(!r||typeof r.id!=='string'||!r.id||r.id.length>90)continue;
   const old=map.get(r.id);if(!old){map.set(r.id,{...r,hasLocalCopy:false});continue;}
   const lhs=String(old.updatedAt||''),rhs=String(r.updatedAt||'');
   const src=rhs>lhs?r:old;
   // No cloud metadata is allowed to mark a local video present or overwrite a file fingerprint.
   map.set(r.id,{...src,hasLocalCopy:!!old.hasLocalCopy,fileFingerprint:old.fileFingerprint||r.fileFingerprint||''});
  }
  return [...map.values()];
 }
 function basicAuth(user,pass){if(!user||!pass)throw Error('WebDAVのIDとパスワードが必要です');let bytes=new TextEncoder().encode(`${user}:${pass}`),str='';for(const b of bytes)str+=String.fromCharCode(b);return 'Basic '+btoa(str);}
 async function exchange({endpoint,user,password,passphrase,local,encrypt,decrypt,fetcher=fetch}){
  const url=validEndpoint(endpoint);if(!url)throw Error('公開HTTPSのWebDAVファイルURLを指定してください');
  const Authorization=basicAuth(user,password);
  const headers={Authorization,'Cache-Control':'no-store'};
  const resp=await fetcher(url,{method:'GET',headers,cache:'no-store',redirect:'error'});
  let remote={items:[],follows:[]},etag=null;
  if(resp.status===200){etag=resp.headers?.get('ETag')||null;
   if(!etag)throw Error('安全な同期にはWebDAVのETag応答が必要です');
   const txt=await resp.text();if(txt.length>20*1024*1024)throw Error('同期データが大きすぎます');
   remote=await decrypt(JSON.parse(txt),passphrase);
   if(!Array.isArray(remote.items)||remote.items.length>10000)throw Error('同期データが不正です');
  }else if(resp.status!==404)throw Error(`WebDAV読み込み失敗（HTTP ${resp.status}）。CORS・認証・権限を確認してください`);
  const items=merge(local.items||[],remote.items);
  const follows=[...new Set([...(local.follows||[]),...(remote.follows||[])])].slice(0,100);
  const payload=await encrypt({schemaVersion:2,items:items.map(x=>({...x,hasLocalCopy:false})),follows},passphrase);
  const response=await fetcher(url,{method:'PUT',headers:{...headers,'Content-Type':'application/json',...(etag?{'If-Match':etag}:{'If-None-Match':'*'})},body:JSON.stringify(payload),redirect:'error'});
  if(!response.ok)throw Error(response.status===409||response.status===412?'他端末で更新されました。もう一度同期してください':`WebDAV書き込み失敗（HTTP ${response.status}）。書込み権限・CORSを確認してください`);
  return {items,follows};
 }
 return {validEndpoint,merge,exchange};
});
