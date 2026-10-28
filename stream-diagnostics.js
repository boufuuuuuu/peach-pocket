'use strict';
/*
 * 桃息吐息: 無断取得を行わない再生通信診断。
 * 操作を起点にHEADのみを優先し、HEADが失敗・非対応のときだけRange付きGETを試す。
 * GETの本体は読まずに即時キャンセル。CORSの失敗を再生不可と誤認しない。
 * 配信URLや認証トークンは返値・画面表示・ログに残さない。
 */
(function(root,factory){
 const api=factory();
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 root.PeachStreamDiagnostics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const HTTP_OK=new Set([200,206]);
 function safeStatus(x){return Number.isInteger(x)&&x>=100&&x<=599?x:null;}
 function httpResult(status,method,rangeIgnored=false){
  return {kind:HTTP_OK.has(status)?'http-ok':'http-error',httpStatus:status,method,rangeIgnored};
 }
 async function requestHeaders(url,{fetchImpl,method,timeoutMs}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(url,{
    method,mode:'cors',credentials:'omit',redirect:'follow',referrerPolicy:'no-referrer',
    ...(method==='GET'?{headers:{Range:'bytes=0-1023'}}:{}),signal:controller.signal
   });
   const status=safeStatus(response.status);
   // Even if the server ignores Range and sends 200, no response body is consumed.
   // Cancelling the stream and aborting the fetch prevents intentional full-file download.
   try{const cancelled=response.body?.cancel?.();cancelled?.catch?.(()=>{});}catch{}
   return {kind:'reply',status,method,rangeIgnored:method==='GET'&&status===200};
  }catch(err){return {kind:controller.signal.aborted?'timeout':'failed'};}
  finally{clearTimeout(timeout);controller.abort();}
 }
 async function probe(raw,opts={}){
  let u;
  try{u=new URL(raw);}catch{return {kind:'skipped',reason:'invalid-url'};}
  // blob / local URLs do not require an external HTTP network probe.
  if(u.protocol!=='https:')return {kind:'skipped',reason:'not-https'};
  if(u.username||u.password)return {kind:'skipped',reason:'url-credentials'};
  const fetchImpl=opts.fetchImpl||(typeof fetch==='function'?fetch:null);
  if(typeof fetchImpl!=='function')return {kind:'unverifiable'};
  const timeoutMs=Math.max(1000,Math.min(10000,Number(opts.timeoutMs)||5000));
  const head=await requestHeaders(u.href,{fetchImpl,method:'HEAD',timeoutMs});
  if(head.kind==='reply'&&head.status!==405&&head.status!==501){
   return httpResult(head.status,'HEAD');
  }
  // A CORS-blocked HEAD does not establish that GET or native HLS will fail.
  // Retry a bounded GET only when HEAD is unsupported or its result is unreadable.
  const get=await requestHeaders(u.href,{fetchImpl,method:'GET',timeoutMs});
  if(get.kind==='reply')return httpResult(get.status,'GET',get.rangeIgnored);
  return {kind:head.kind==='timeout'&&get.kind==='timeout'?'timeout':'unverifiable',httpStatus:null,method:null};
 }
 function describe(d){
  if(d.kind==='http-ok'){
   const rangeNote=d.rangeIgnored?' 配信側は部分取得の指定を無視しましたが、本体のダウンロードは中止しました。':'';
   return `通信診断：HTTP ${d.httpStatus}（${d.method}で応答を確認）。これは動画本体・HLSセグメントの再生成功を意味しません。${rangeNote}`;
  }
  if(d.kind==='http-error'){
   const note=d.httpStatus===403?'アクセス拒否の応答です。':d.httpStatus===404?'URLが見つからない応答です。':d.httpStatus===401?'認証が必要な応答です。':'サーバーが正常以外のHTTP応答を返しました。';
   return `通信診断：HTTP ${d.httpStatus}（${d.method}）。${note} 動画データを正常取得できたとは判定しません。`;
  }
  if(d.kind==='timeout')return '通信診断：応答ヘッダーの確認が時間切れになりました。Safariの動画再生可否はこの結果だけでは判断できません。';
  if(d.kind==='skipped')return '通信診断：HTTPSの外部動画URLではないため、ネットワーク調査を行いませんでした。';
  return '通信診断：JavaScriptからHTTP応答を確認できませんでした（CORS制限・通信障害などの可能性）。CORSの制限だけではiPhoneのネイティブ動画再生が不可能とは断定できません。';
 }
 return Object.freeze({probe,describe});
});
