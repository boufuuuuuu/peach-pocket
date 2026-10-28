/* 桃息吐息 v1.10.5: permission-respecting native-HLS diagnostics.
 * No playlist rewriting, relay, credential injection, or DRM handling.
 * URLs and encryption material are never returned by inspection.
 */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.PeachHls=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX_BYTES=65536;
 function candidates(master,variants,validate){
  const raw=[master,...(Array.isArray(variants)?variants:[])];
  const out=[],seen=new Set();
  for(const candidate of raw.slice(0,20)){
   const item=typeof candidate==='string'?candidate:
    candidate&&typeof candidate==='object'&&!Array.isArray(candidate)?
      candidate.url||candidate.playlist||candidate.streamUrl||candidate.src:'';
   const value=validate(item);
   if(value&&!seen.has(value)){seen.add(value);out.push(value);}
  }
  return out.slice(0,8);
 }
 function parse(text){
  const lines=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim());
  if(lines[0]!=='#EXTM3U')return {valid:false};
  const master=lines.some(l=>l.startsWith('#EXT-X-STREAM-INF:'));
  const media=lines.some(l=>l.startsWith('#EXTINF:'));
  const codecValues=[];
  for(const l of lines.filter(s=>s.startsWith('#EXT-X-STREAM-INF:'))){
   const m=l.match(/(?:^|,)CODECS="([^"]{1,140})"/i);
   if(m)codecValues.push(...m[1].split(',').map(c=>c.trim()).filter(c=>/^[a-zA-Z0-9._-]{1,48}$/.test(c)));
  }
  const seg=lines.filter(l=>l&&!l.startsWith('#'));
  const encrypt=lines.filter(l=>l.startsWith('#EXT-X-KEY:')||l.startsWith('#EXT-X-SESSION-KEY:'));
  const scheme=encrypt.some(l=>/METHOD=(?:SAMPLE-AES|AES-128)/i.test(l))?'encryption-declared':
   encrypt.length?'key-tag-other':'none';
  return {valid:true,kind:master?'master':media?'media':'unknown',
   codecValues:[...new Set(codecValues)].slice(0,8),
   variantCount:master?seg.length:0,segmentCount:media?seg.length:0,
   hasMap:lines.some(l=>l.startsWith('#EXT-X-MAP:')),
   encrypted:scheme,hasEndlist:lines.includes('#EXT-X-ENDLIST'),
   firstSegment:media?(seg[0]||''):'',version:(lines.find(l=>l.startsWith('#EXT-X-VERSION:'))||'').split(':')[1]||''};
 }
 function safeUrl(raw){
  try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||u.port&&u.port!=='443')return null;
   if(/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname))return null;
   return u;
  }catch{return null;}
 }
 // Only invoked on a user-authorized stream after a native playback error.
 // Manifest text is read under normal browser CORS rules; no segment bodies or keys are read.
 async function inspect(raw,{fetchImpl,timeoutMs=5000}={}){
  const target=safeUrl(raw);
  if(!target||!/\.m3u8$/i.test(target.pathname))return {status:'skipped'};
  const doFetch=fetchImpl||(typeof fetch==='function'?fetch:null);
  if(!doFetch)return {status:'unverifiable'};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.min(10000,Math.max(1000,timeoutMs)));
  try{
   const r=await doFetch(target.href,{method:'GET',mode:'cors',credentials:'omit',
    redirect:'follow',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});
   const status=Number(r.status)||null;
   if(!r.ok)return {status:'http-error',httpStatus:status};
   // Classify only the MIME type, never expose the response URL or redirect target.
   const mime=String(r.headers?.get?.('content-type')||'').split(';')[0].trim().toLowerCase();
   const mimeKind=['application/vnd.apple.mpegurl','application/x-mpegurl',
    'audio/mpegurl','audio/x-mpegurl'].includes(mime)?'hls':
    mime==='text/html'?'html':mime?'other':'not-visible';
   let body='';
   if(r.body?.getReader){
    const reader=r.body.getReader();const dec=new TextDecoder();let size=0;
    try{
     for(;;){const packet=await reader.read();if(packet.done)break;
      size+=packet.value?.byteLength||0;if(size>MAX_BYTES)return {status:'too-large'};
      body+=dec.decode(packet.value,{stream:true});
     }
     body+=dec.decode();
    }finally{try{await reader.cancel();}catch{}try{reader.releaseLock();}catch{}}
   }else{
    const length=Number(r.headers?.get?.('content-length')||0);
    if(length>MAX_BYTES)return {status:'too-large'};
    body=await r.text();if(new TextEncoder().encode(body).length>MAX_BYTES)return {status:'too-large'};
   }
   const info=parse(body);
   if(!info.valid)return {status:'invalid-manifest',httpStatus:status};
   let segmentStatus='not-tested',segmentHTTP=null;
   if(info.kind==='media'&&info.firstSegment){
    const segment=safeUrl(new URL(info.firstSegment,target.href).href);
    if(!segment||segment.origin!==target.origin)segmentStatus='different-origin';
    else {
     try{
      const h=await doFetch(segment.href,{method:'HEAD',mode:'cors',credentials:'omit',
       redirect:'follow',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});
      segmentStatus='http';segmentHTTP=Number(h.status)||null;
     }catch{segmentStatus='unverifiable';}
    }
   }
   // Discard text, raw segment names, signed URLs and key URIs.
   const {firstSegment,...safe}=info;
   return {status:'parsed',httpStatus:status,mimeKind,...safe,segmentStatus,segmentHTTP};
  }catch{return {status:controller.signal.aborted?'timeout':'unverifiable'};}
  finally{clearTimeout(timer);controller.abort();}
 }
 function describe(result){
  if(result.status==='parsed'){
   const type=result.kind==='master'?'マスター':result.kind==='media'?'メディア':'種類未特定';
   const number=result.kind==='master'?`候補 ${result.variantCount} 件`:`セグメント記述 ${result.segmentCount} 件`;
   const codecs=result.codecValues.length?`CODECS宣言：${result.codecValues.join(', ')}`:'CODECS宣言は確認できません';
   const segment=result.segmentStatus==='http'?`先頭セグメントHEAD：HTTP ${result.segmentHTTP}`:
    result.segmentStatus==='different-origin'?'先頭セグメントは別オリジン（未検証）':
    result.segmentStatus==='unverifiable'?'先頭セグメントの応答はJavaScriptから確認不可':'セグメント未検査';
   const mimeNote=result.mimeKind==='hls'?'MIMEはHLS':result.mimeKind==='html'?'MIMEがHTML（異常の可能性）':
    result.mimeKind==='other'?'MIMEが推奨HLS形式と異なります':'MIMEは確認不可';
   return `HLS構造：HTTP ${result.httpStatus}／${type}／${number}。${mimeNote}。${codecs}。暗号化：${result.encrypted==='none'?'宣言なし':'指定あり（鍵は未取得）'}。${segment}。再生互換性は確定していません。`;
  }
  if(result.status==='http-error')return `HLS構造：プレイリストのHTTP ${result.httpStatus}。`;
  if(result.status==='invalid-manifest')return 'HLS構造：応答が標準の#EXTM3Uで始まっていません。';
  if(result.status==='too-large')return 'HLS構造：安全上限を超えるため検査を中止しました。';
  if(result.status==='timeout')return 'HLS構造：診断が時間切れでした。ネイティブ再生とは別の結果です。';
  if(result.status==='skipped')return 'HLS構造：HTTPSのm3u8 URLではありません。';
  return 'HLS構造：JavaScriptからプレイリストを読み取れません（CORS・通信障害・応答不明）。SafariのネイティブHLS再生可否は別です。';
 }
 return Object.freeze({candidates,parse,inspect,describe});
});
