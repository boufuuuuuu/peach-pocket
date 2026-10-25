/* Private video copies in per-origin IndexedDB. No network requests or sync. */
(function(root, factory){
 const mod=factory();if(typeof module==='object'&&module.exports)module.exports=mod;else root.PeachMedia=mod;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX_VIDEO_BYTES=1024*1024*1024; // Conservative per-file attempt limit, browser quota may be smaller.
 const types=/\.(mp4|m4v|mov|webm)$/i;
 const fileNameToMeta=name=>{
  const clean=String(name||'').split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
  const match=clean.match(/(?:^|[^A-Z0-9])(FC2)[\s._-]?(PPV)[\s._-]?(\d{4,10})(?!\d)/i) || clean.match(/(?:^|[^A-Z0-9])([a-zA-Z]{2,12})[\s._-]?(\d{2,6})(?!\d)/);
  let code='';
  if(match){code=match.length===4?`${match[1]}-${match[2]}-${match[3]}`:`${match[1]}-${match[2]}`;code=code.toUpperCase();}
  return {title:clean.replace(/[_]+/g,' ').slice(0,300)||'名称未設定',code};
 };
 const isVideo=file=>Boolean(file&&typeof file.size==='number'&&file.size>0&&file.size<=MAX_VIDEO_BYTES&&
   (String(file.type||'').startsWith('video/')||types.test(String(file.name||''))));
 const prettyBytes=size=>{
   if(!Number.isFinite(size)||size<0)return '不明';
   if(size<1024)return `${size} B`;
   const unit=size>=1024**3?'GB':size>=1024**2?'MB':'KB';const factor=unit==='GB'?1024**3:unit==='MB'?1024**2:1024;
   return `${(size/factor).toFixed(1)} ${unit}`;
 };
 function request(req){return new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error||new Error('保存領域エラー'));});}
 function transaction(db,mode,fn){return new Promise((resolve,reject)=>{
   let tx;try{tx=db.transaction('media',mode);fn(tx.objectStore('media'));}catch(e){reject(e);return;}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('保存領域エラー'));tx.onabort=()=>reject(tx.error||new Error('保存中断'));
 });}
 async function put(db,id,file){
   if(!isVideo(file))throw Error(file?.size>MAX_VIDEO_BYTES?'動画が1GBを超えています。現在の保存方式では登録できません':'MP4・MOV・WebMなどの動画ファイルを選択してください');
   await transaction(db,'readwrite',s=>s.put({id,blob:file,name:String(file.name||'video'),size:file.size,type:file.type||'',storedAt:new Date().toISOString()}));
 }
 async function removeWithRecord(db,id){return new Promise((resolve,reject)=>{
   let tx;try{
     tx=db.transaction(['items','media'],'readwrite');
     tx.objectStore('items').delete(id);tx.objectStore('media').delete(id);
   }catch(e){reject(e);return;}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('削除エラー'));
   tx.onabort=()=>reject(tx.error||new Error('削除が中断されました'));
 });}
 async function get(db,id){return request(db.transaction('media','readonly').objectStore('media').get(id));}
 async function remove(db,id){return transaction(db,'readwrite',s=>s.delete(id));}
 async function keys(db){return request(db.transaction('media','readonly').objectStore('media').getAllKeys());}
 return {MAX_VIDEO_BYTES,isVideo,fileNameToMeta,prettyBytes,put,get,remove,removeWithRecord,keys};
});
