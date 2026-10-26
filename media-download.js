/* Download only standalone, explicitly permitted video files; do not scrape pages, HLS, DRM or bypass CORS. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.PeachDownload=api;})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
 'use strict';
 const MAX_BYTES=256*1024*1024; // iOS memory safety limit. Local Files import allows up to 1GB.
 const VIDEO_EXT=/\.(mp4|m4v|mov|webm)$/i;
 const VIDEO_TYPES=new Set(['video/mp4','video/quicktime','video/webm','video/x-m4v','application/octet-stream','binary/octet-stream']);
 function validatedUrl(raw){
  const clean=Core.safeURL(raw,'licensed');if(!clean)throw Error('公開HTTPSの動画ファイルURLだけ指定してください');
  const u=new URL(clean);
  if(!VIDEO_EXT.test(u.pathname))throw Error('動画ファイルの直リンク（.mp4/.m4v/.mov/.webm）が必要です。作品ページやm3u8は保存できません');
  return u.href;
 }
 function safeFilename(raw,fallback){
  const name=String(raw||fallback||'movie.mp4').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g,'_').slice(0,180);
  return name&&VIDEO_EXT.test(name)?name:'movie.mp4';
 }
 function typeAllowed(mime,path){
  const t=String(mime||'').split(';')[0].trim().toLowerCase();
  return VIDEO_TYPES.has(t) && VIDEO_EXT.test(path);
 }
 async function signatureOK(blob,ext){
  const head=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  if(ext==='webm')return head.length>=4&&head[0]===0x1a&&head[1]===0x45&&head[2]===0xdf&&head[3]===0xa3;
  return head.length>=12&&String.fromCharCode(...head.slice(4,8))==='ftyp';
 }
 async function fetchVideo(raw,{fetchImpl=fetch,onProgress=()=>{},signal}={}){
  const url=validatedUrl(raw);
  let response;
  try{response=await fetchImpl(url,{method:'GET',mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal});}
  catch(e){if(signal?.aborted)throw Error('保存を中止しました');throw Error('取得できません。配信側がダウンロードを許可しているか、CORS・ネット接続を確認してください');}
  if(!response || response.status!==200 || response.type==='opaque')throw Error('完全な動画ファイルを取得できません（HTTP '+(response?.status||'不明')+'）');
  if(response.url){const actual=validatedUrl(response.url);if(!actual)throw Error('安全ではない取得先です');}
  const mime=response.headers?.get('Content-Type')||'';
  if(!typeAllowed(mime,new URL(response.url||url).pathname))throw Error('動画データではありません。作品ページHTMLやプレイリストは保存できません');
  const length=Number(response.headers?.get('Content-Length'));
  if(Number.isFinite(length)&&length>MAX_BYTES)throw Error('オンライン保存は256MB以下です。大きい動画はiPhoneのファイルから登録してください');
  const chunks=[];let count=0;
  if(response.body?.getReader){
   const reader=response.body.getReader();
   try{while(true){const {value,done}=await reader.read();if(done)break;if(signal?.aborted)throw Error('保存を中止しました');count+=value.byteLength;
    if(count>MAX_BYTES)throw Error('オンライン保存は256MB以下です。大きい動画はファイルから登録してください');
    chunks.push(value);onProgress(count,Number.isFinite(length)&&length>0?length:null);
   }}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  } else {
   const blob=await response.blob();count=blob.size;if(count>MAX_BYTES)throw Error('オンライン保存は256MB以下です');chunks.push(blob);
  }
  if(count<1)throw Error('動画ファイルが空です');
  const name=safeFilename(new URL(url).pathname);
  const extension=name.split('.').pop().toLowerCase();
  const blob=new Blob(chunks);if(!(await signatureOK(blob,extension)))throw Error('動画ファイルの形式が一致しません（HTMLなどは保存できません）');
  const type=mime.split(';')[0].trim().toLowerCase()==='application/octet-stream'?({mp4:'video/mp4',m4v:'video/x-m4v',mov:'video/quicktime',webm:'video/webm'}[name.split('.').pop().toLowerCase()]||'video/mp4'):mime.split(';')[0].trim().toLowerCase();
  return new File(chunks,name,{type:type||'video/mp4',lastModified:Date.now()});
 }
 return {MAX_BYTES,validatedUrl,safeFilename,typeAllowed,signatureOK,fetchVideo};
});
