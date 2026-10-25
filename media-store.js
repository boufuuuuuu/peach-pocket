/* Private video copies in per-origin IndexedDB. No network requests or sync. */
(function(root, factory){
 const mod=factory();if(typeof module==='object'&&module.exports)module.exports=mod;else root.PeachMedia=mod;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX_VIDEO_BYTES=1024*1024*1024;
 const SAMPLE_BYTES=128*1024;
 const THUMB_MAX_BYTES=400*1024; // Conservative per-file attempt limit, browser quota may be smaller.
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
 async function fingerprint(file){
   if(!file || typeof file.slice!=='function' || !Number.isSafeInteger(file.size) || file.size<1)throw Error('動画ファイルが不正です');
   if(!globalThis.crypto?.subtle)throw Error('安全な動画照合にはHTTPSが必要です');
   const n=Math.min(file.size,SAMPLE_BYTES),positions=[0,Math.max(0,Math.floor((file.size-n)/2)),Math.max(0,file.size-n)];
   const unique=[...new Set(positions)];
   const buffers=await Promise.all(unique.map(p=>file.slice(p,p+n).arrayBuffer()));
   const byteLen=8+unique.length*(8+n);
   const body=new Uint8Array(byteLen);const view=new DataView(body.buffer);view.setBigUint64(0,BigInt(file.size),false);
   let offset=8;
   for(let i=0;i<unique.length;i++){
     view.setBigUint64(offset,BigInt(unique[i]),false);offset+=8;
     body.set(new Uint8Array(buffers[i]),offset);offset+=buffers[i].byteLength;
   }
   const digest=await crypto.subtle.digest('SHA-256',body.subarray(0,offset));
   return `sha256-sampled-v1:${Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')}:${file.size}`;
 }
 async function put(db,id,file,finger=''){
   if(!isVideo(file))throw Error(file?.size>MAX_VIDEO_BYTES?'動画が1GBを超えています。現在の保存方式では登録できません':'MP4・MOV・WebMなどの動画ファイルを選択してください');
   await transaction(db,'readwrite',s=>s.put({id,blob:file,name:String(file.name||'video'),size:file.size,type:file.type||'',fingerprint:finger,storedAt:new Date().toISOString()}));
 }
 async function removeWithRecord(db,id){return new Promise((resolve,reject)=>{
   let tx;try{
     tx=db.transaction(['items','media','thumbnails'],'readwrite');
     tx.objectStore('items').delete(id);tx.objectStore('media').delete(id);tx.objectStore('thumbnails').delete(id);
   }catch(e){reject(e);return;}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('削除エラー'));
   tx.onabort=()=>reject(tx.error||new Error('削除が中断されました'));
 });}
 async function get(db,id){return request(db.transaction('media','readonly').objectStore('media').get(id));}
 async function getThumbnail(db,id){return request(db.transaction('thumbnails','readonly').objectStore('thumbnails').get(id));}
 async function putThumbnail(db,id,blob){
   if(!(blob instanceof Blob) || !blob.type.startsWith('image/') || blob.size<=0 || blob.size>THUMB_MAX_BYTES)throw Error('サムネイルが不正です');
   return new Promise((resolve,reject)=>{let tx;try{tx=db.transaction('thumbnails','readwrite');tx.objectStore('thumbnails').put({id,blob,createdAt:new Date().toISOString()});}catch(e){reject(e);return;}tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||new Error('画像保存失敗'));tx.onabort=()=>reject(tx.error||new Error('画像保存中断'));});
 }
 async function mediaMetadata(db){return new Promise((resolve,reject)=>{
   const rows=[];let tx;try{tx=db.transaction('media','readonly');const request=tx.objectStore('media').openCursor();request.onsuccess=()=>{const c=request.result;if(c){const v=c.value;rows.push({id:v.id,name:v.name,size:v.size,fingerprint:v.fingerprint||''});c.continue();}else resolve(rows);};request.onerror=()=>reject(request.error);}catch(e){reject(e);}
 });}
 async function matchExisting(db,file,fp,records){
   // Reuse hashed v1.5 records even if the selected file was renamed.
   const byFingerprint=records.find(r=>r.provider==='local' && r.fileFingerprint===fp);
   if(byFingerprint)return byFingerprint;
   // Migration from v1.4: only sample legacy entries whose sizes match; no deletion.
   const meta=await mediaMetadata(db);
   for(const row of meta){
     if(row.fingerprint===fp)return records.find(r=>r.id===row.id)||null;
     if(row.fingerprint || row.size!==file.size)continue;
     const candidate=await get(db,row.id);if(candidate?.blob && await fingerprint(candidate.blob)===fp)return records.find(r=>r.id===row.id)||null;
   }
   return null;
 }
 async function captureThumbnail(file,{timeoutMs=7000}={}){
   if(typeof document==='undefined'||typeof URL==='undefined')return null;
   const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
   video.setAttribute('playsinline','');video.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-999px';
   const src=URL.createObjectURL(file);let timer;let done=false;
   const clean=()=>{video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(src);};
   try{return await new Promise(resolve=>{
     const finish=async(ok)=>{if(done)return;done=true;clearTimeout(timer);let result=null;
       if(ok){try{const canvas=document.createElement('canvas');const w=video.videoWidth,h=video.videoHeight;if(!w||!h)throw Error('寸法不明');
         const ratio=Math.min(1,360/w,240/h);canvas.width=Math.max(1,Math.round(w*ratio));canvas.height=Math.max(1,Math.round(h*ratio));
         canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
         result=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.7));if(result?.size>THUMB_MAX_BYTES)result=null;
       }catch{result=null;}}
       clean();resolve(result);
     };
     video.addEventListener('loadedmetadata',()=>{try{if(Number.isFinite(video.duration) && video.duration>1){video.currentTime=Math.min(2,video.duration*.12);}else video.addEventListener('loadeddata',()=>finish(true),{once:true});}catch{finish(false);}}, {once:true});
     video.addEventListener('seeked',()=>finish(true),{once:true});video.addEventListener('error',()=>finish(false),{once:true});
     timer=setTimeout(()=>finish(false),timeoutMs);
     document.body.append(video);video.src=src;video.load();
   });}catch{clean();return null;}
 }
 async function remove(db,id){return transaction(db,'readwrite',s=>s.delete(id));}
 async function keys(db){return request(db.transaction('media','readonly').objectStore('media').getAllKeys());}
 return {MAX_VIDEO_BYTES,SAMPLE_BYTES,isVideo,fileNameToMeta,prettyBytes,fingerprint,put,get,remove,removeWithRecord,keys,getThumbnail,putThumbnail,mediaMetadata,matchExisting,captureThumbnail};
});
