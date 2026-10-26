/* Encrypted portable archive containing records, locally saved videos, and thumbnails.
 * Format MMBK1801 + little-endian header length + plaintext envelope(salt,iv,encrypted manifest)
 * + AES-GCM encrypted 1MiB segments. All filenames, media IDs and metadata are encrypted.
 * There is no network activity. Each byte range is verified before any DB changes.
 */
(function(root,factory){const mod=factory();if(typeof module==='object'&&module.exports)module.exports=mod;else root.PeachFullBackup=mod;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAGIC='MMBK1801',CHUNK=1024*1024,MAX_HEADER=8*1024*1024,MAX_ASSETS=2000,ITERATIONS=310000;
 const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
 const rand=n=>crypto.getRandomValues(new Uint8Array(n));
 const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.slice(i,i+8192));return btoa(s);};
 const unb64=str=>Uint8Array.from(atob(str),c=>c.charCodeAt(0));
 const validPass=p=>typeof p==='string'&&p.length>=12&&p.length<=256;
 async function keyFor(password,salt){if(!validPass(password))throw Error('合言葉は12文字以上で入力してください');let k=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},k,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;};
 const aad=(type,id,index)=>enc.encode(`momo-backup-v1|${type}|${id}|${index}`);
 async function seal(key,bytes,iv,addition){return new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:addition},key,bytes));}
 async function unseal(key,bytes,iv,addition){try{return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:addition},key,bytes));}catch{throw Error('合言葉が違うか、完全バックアップが壊れています');}}
 function validatePayload(p){if(!p||p.version!==1||!Array.isArray(p.items)||p.items.length>10000||!Array.isArray(p.assets)||p.assets.length>MAX_ASSETS)throw Error('バックアップのデータ形式が不正です');}
 async function create({items,assets,meta={}},password,onProgress=()=>{}){
  if(!Array.isArray(items)||items.length>10000||!Array.isArray(assets)||assets.length>MAX_ASSETS)throw Error('件数が上限を超えています');
  const salt=rand(16),key=await keyFor(password,salt),blocks=[],descriptors=[];let total=0,done=0;
  for(const asset of assets){if(!(asset.blob instanceof Blob)||!['media','thumbnail'].includes(asset.type)||typeof asset.id!=='string'||asset.id.length>90 || (asset.type==='media'&&(asset.blob.size<1||asset.blob.size>1024*1024*1024)) || (asset.type==='thumbnail'&&(asset.blob.size<1||asset.blob.size>400*1024)))throw Error('動画・画像データが不正です');total+=asset.blob.size;}
  for(const asset of assets){
    const info={type:asset.type,id:asset.id,size:asset.blob.size,mime:asset.blob.type||'application/octet-stream',name:String(asset.name||'').slice(0,255),chunks:[]};
    for(let index=0,at=0;at<asset.blob.size;index++,at+=CHUNK){
      const bytes=new Uint8Array(await asset.blob.slice(at,at+CHUNK).arrayBuffer());const iv=rand(12);const encrypted=await seal(key,bytes,iv,aad(asset.type,asset.id,index));
      info.chunks.push({length:encrypted.length,iv:b64(iv)});blocks.push(encrypted);done+=bytes.length;onProgress(done,total);
    }
    descriptors.push(info);
  }
  const manifest=enc.encode(JSON.stringify({version:1,exportedAt:new Date().toISOString(),items,meta,assets:descriptors}));
  if(manifest.length>MAX_HEADER-100000)throw Error('作品情報が大きすぎます');
  const iv=rand(12),data=await seal(key,manifest,iv,enc.encode(MAGIC));
  const header=enc.encode(JSON.stringify({format:MAGIC,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:b64(salt),iv:b64(iv),data:b64(data)}));
  if(header.length>MAX_HEADER)throw Error('バックアップ情報の上限を超えています');
  return new Blob([enc.encode(MAGIC),u32(header.length),header,...blocks],{type:'application/octet-stream'});
 }
 async function parse(file,password,onProgress=()=>{}){
  if(!(file instanceof Blob)||file.size<25)throw Error('完全バックアップファイルが不正です');
  const pre=new Uint8Array(await file.slice(0,12).arrayBuffer());if(dec.decode(pre.slice(0,8))!==MAGIC)throw Error('完全バックアップの形式が違います');
  const len=new DataView(pre.buffer).getUint32(8,true);if(!len||len>MAX_HEADER||12+len>file.size)throw Error('バックアップのヘッダーが不正です');
  let h;try{h=JSON.parse(await file.slice(12,12+len).text());}catch{throw Error('ヘッダーが壊れています');}
  if(h.format!==MAGIC||h.iterations!==ITERATIONS||h.kdf!=='PBKDF2-SHA256')throw Error('対応していないバックアップ形式です');
  let salt,iv,data;try{salt=unb64(h.salt);iv=unb64(h.iv);data=unb64(h.data);}catch{throw Error('ヘッダーが壊れています');}
  if(salt.length!==16||iv.length!==12||data.length<16)throw Error('暗号化情報が壊れています');
  const key=await keyFor(password,salt);let manifest;
  try{manifest=JSON.parse(dec.decode(await unseal(key,data,iv,enc.encode(MAGIC))));}catch(e){throw Error('合言葉が違うか、ヘッダーが破損しています');}
  validatePayload(manifest);
  const assets=[];let offset=12+len;const total=file.size-offset;let done=0;
  for(const asset of manifest.assets){
    if(!['media','thumbnail'].includes(asset.type)||typeof asset.id!=='string'||asset.id.length>90||!Number.isSafeInteger(asset.size)||asset.size<0||!Array.isArray(asset.chunks)||asset.chunks.length>16384)throw Error('保存データの構造が不正です');
    const parts=[];let size=0;
    for(let index=0;index<asset.chunks.length;index++){
      const part=asset.chunks[index],limit=CHUNK+16;
      if(!Number.isInteger(part.length)||part.length<17||part.length>limit||offset+part.length>file.size)throw Error('バックアップが途中で切れています');
      let chunkIv;try{chunkIv=unb64(part.iv);}catch{throw Error('暗号化データが不正です');}
      if(chunkIv.length!==12)throw Error('暗号化データが不正です');
      const ciphertext=new Uint8Array(await file.slice(offset,offset+part.length).arrayBuffer());offset+=part.length;
      const plaintext=await unseal(key,ciphertext,chunkIv,aad(asset.type,asset.id,index));size+=plaintext.byteLength;parts.push(plaintext);done+=part.length;onProgress(done,total);
    }
    if(size!==asset.size)throw Error('バックアップ内ファイルのサイズが一致しません');
    if(asset.type==='media'&&(size<1||size>1024*1024*1024))throw Error('動画ファイルのサイズが不正です');
    if(asset.type==='thumbnail'&&(size<1||size>400*1024||!String(asset.mime||'').startsWith('image/')))throw Error('画像ファイルが不正です');
    assets.push({type:asset.type,id:asset.id,name:String(asset.name||'').slice(0,255),blob:new Blob(parts,{type:typeof asset.mime==='string'?asset.mime:'application/octet-stream'})});
  }
  if(offset!==file.size)throw Error('不明な余剰データがあります');
  return {items:manifest.items,meta:manifest.meta||{},assets,exportedAt:manifest.exportedAt};
 }
 return {MAGIC,CHUNK,create,parse,validatePayload};
});
