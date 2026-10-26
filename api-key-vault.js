/* javinfo API key vault for 桃息吐息.
   Explicit opt-in only; an origin-scoped, non-extractable AES-GCM CryptoKey lives in IndexedDB.
   This limits accidental exposure and casual storage inspection. It CANNOT defend against
   malicious same-origin scripts/XSS. Never include these meta entries in backup/sync/export.
*/
(function(root,factory){const mod=factory();if(typeof module==='object'&&module.exports)module.exports=mod;else root.PeachKeyVault=mod;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const SECRET='javinfoSecretV196',KEY='javinfoCryptoKeyV196';
 function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||Error('保存領域を読み込めません'));});}
 function transaction(db,mode,fn){return new Promise((resolve,reject)=>{const tx=db.transaction('meta',mode);try{fn(tx.objectStore('meta'));}catch(e){try{tx.abort();}catch{}reject(e);return;}tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||Error('保存に失敗'));tx.onabort=()=>reject(tx.error||Error('保存中断'));});}
 async function save(db,raw,cryptoObj=globalThis.crypto){
  const secret=String(raw||'').trim();if(!/^jvi_[A-Za-z0-9_-]{8,240}$/.test(secret))throw Error('有効なjavinfo APIキーを入力してください');
  if(!cryptoObj?.subtle||!cryptoObj?.getRandomValues)throw Error('このブラウザでは端末内暗号化保存に対応していません');
  const key=await cryptoObj.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=cryptoObj.getRandomValues(new Uint8Array(12));
  const bytes=new Uint8Array(await cryptoObj.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(secret)));
  await transaction(db,'readwrite',store=>{store.put({key:KEY,value:key});store.put({key:SECRET,value:{iv:[...iv],data:[...bytes]}});});
 }
 async function load(db,cryptoObj=globalThis.crypto){
  if(!cryptoObj?.subtle)return '';
  const tx=db.transaction('meta','readonly'),store=tx.objectStore('meta');
  const [keyRow,secretRow]=await Promise.all([request(store.get(KEY)),request(store.get(SECRET))]);
  const key=keyRow?.value,payload=secretRow?.value;
  if(!key||!payload||!Array.isArray(payload.iv)||payload.iv.length!==12||!Array.isArray(payload.data))return '';
  try{const raw=await cryptoObj.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(payload.iv)},key,new Uint8Array(payload.data));const value=new TextDecoder().decode(raw);return /^jvi_[A-Za-z0-9_-]{8,240}$/.test(value)?value:'';}
  catch{return '';}
 }
 async function clear(db){await transaction(db,'readwrite',store=>{store.delete(KEY);store.delete(SECRET);});}
 return {SECRET,KEY,save,load,clear};
});
