/* javinfo REST integration for 桃息吐息.
 * Browser-only / opt-in encrypted local key vault / no host-header forgery / no CORS bypass.
 * Only the service's published /query and /movie endpoints are accessed.
 */
(function(root,factory){
 const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.PeachJavinfo=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
 'use strict';
 const ORIGIN='https://api.javinfo.dev';
 const MAX_BYTES=1_000_000;
 const PROVIDERS=Object.freeze(['missav','sextb','javdatabase','javlibrary','fanza','dmm','javdb']);
 function providerId(raw){const val=String(raw||'missav').trim().toLowerCase();if(!PROVIDERS.includes(val))throw Error('未対応の作品情報プロバイダーです');return val;}
 function directMediaURL(raw){const url=Core.safeURL(raw,'licensed');if(!url)return '';try{return /\.(?:m3u8|mp4|m4v|mov|webm)$/i.test(new URL(url).pathname)?url:'';}catch{return '';}}
 function playbackDiagnosis(code,networkOnline=true,kind=''){const c=Number(code)||0;if(!networkOnline)return 'iPhoneがオフラインです。ネット接続を確認してください。';if(c===2)return '動画配信元への通信に失敗しました。URL期限切れ、配信元の拒否、回線などを確認してください。';if(c===3)return 'iPhoneで動画データをデコードできません。配信形式やセグメント形式がSafari非対応の可能性があります。';if(c===4)return kind==='hls'?'HLSの形式を再生できません。配信元が非標準セグメントを使用している、またはSafariが非対応の可能性があります。':'動画形式がSafariでサポートされていません。';if(c===1)return '動画の読込みが中断されました。';return '動画の読込みに失敗しました。配信元の制限、URL期限切れ、動画形式を確認してください。';}
 const clip=(value,max=300)=>Core.clean(value,max);
 function apiKey(value){const key=String(value||'').trim();if(!/^jvi_[A-Za-z0-9_-]{8,240}$/.test(key))throw Error('javinfoの有効なAPIキー（jvi_…）を入力してください');return key;}
 function queryText(value){const q=clip(value,120);if(q.length<2)throw Error('作品名・品番を2文字以上入力してください');return q;}
 function dvdCode(value){const code=clip(value,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9\-_.]{2,63}$/.test(code))throw Error('有効な品番を指定してください');return code;}
 function httpsPublic(raw){return Core.safeURL(raw,'licensed');}
 function imageURL(raw){return httpsPublic(raw);}
 function watchURL(raw){return Core.safeURL(raw,'missav');}
 function streamURL(raw){const url=httpsPublic(raw);if(!url)return '';try{const u=new URL(url);return /\.m3u8$/i.test(u.pathname)?u.href:'';}catch{return '';}}
 function actors(obj){const arr=obj?.actresses??obj?.performers??obj?.cast??obj?.extra?.actresses??[];
  return (Array.isArray(arr)?arr:[]).slice(0,25).map(x=>clip(typeof x==='string'?x:x?.name||'',70)).filter(Boolean);}
 function item(raw,root={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const code=clip(raw.dvdId||raw.code||raw.id||'',64);
  const title=clip(raw.titleJa||raw.titleEn||raw.title||raw.name||code,300);
  if(!code&&!title)return null;
  const extra=raw.extra&&typeof raw.extra==='object'?raw.extra:{};
  const provider=providerId(raw.source||root.source||root.provider||'missav');
  const page=extra.pageUrl||extra.url||raw.pageUrl||raw.url;
  const sourceURL=provider==='missav'?watchURL(page):Core.safeURL(page,'licensed');
  const cover=imageURL(raw.jacketFullUrl||raw.jacketUrl||raw.cover||raw.coverURL||raw.poster);
  const release=String(raw.releaseDate||raw.publishedAt||'');
  return {code,title:title||code,performers:actors(raw),provider,referenceURL:sourceURL,coverURL:cover,
    publishedAt:/^\d{4}-\d{2}-\d{2}$/.test(release)?release:'',
    // Provider API data does not itself prove stream redistribution permission.
    rightsConfirmed:false,playbackURL:'',embedURL:'',
    duration:Number.isFinite(Number(raw.runtimeMins))?Math.max(0,Number(raw.runtimeMins)*60):0};
 }
 function normalizeSearch(payload,context={}){
  if(!payload||typeof payload!=='object')throw Error('検索結果の形式が不正です');
  const items=Array.isArray(payload.results)?payload.results:Array.isArray(payload.result)?payload.result:[];
  if(items.length>100)throw Error('検索結果が多すぎます');
  return items.map(x=>item(x,{...context,...payload})).filter(Boolean).slice(0,30);
 }
 function normalizeDetail(payload,context={}){
  if(!payload||typeof payload!=='object')throw Error('作品詳細の形式が不正です');
  const body=payload.result;
  const metadata=item(body||{},{...context,...payload});
  if(!metadata)throw Error('作品詳細を取得できませんでした');
  const streams=body?.extra?.streams;
  const options=[streams?.master,...(Array.isArray(streams?.variants)?streams.variants:[])];
  const hls=options.map(streamURL).find(Boolean)||'';
  return {metadata,hls,available:Boolean(hls),source:metadata.provider};
 }
 function pageNumber(value){const n=Number(value);if(!Number.isInteger(n)||n<1||n>50)throw Error('ページは1〜50を指定してください');return n;}
 function uniqueResults(rows){const seen=new Set();return (rows||[]).filter(r=>{const k=String(r.code||r.referenceURL||r.title||'').trim().toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return true;});}
 async function request(kind,value,key,{fetcher=fetch,signal,page=1,provider='missav'}={}){
  const endpoint=kind==='query'?'/query':kind==='movie'?'/movie':null;
  if(!endpoint)throw Error('不明なAPI');
  const q=kind==='query'?queryText(value):dvdCode(value);
  const selectedProvider=providerId(provider);
  const headers={'content-type':'application/json','accept':'application/json','x-javinfo-key':apiKey(key)};
  const abort=new AbortController();let timer;
  if(signal){if(signal.aborted)abort.abort();else signal.addEventListener('abort',()=>abort.abort(),{once:true});}
  timer=setTimeout(()=>abort.abort(),15_000);
  try{
   let res;
   try{res=await fetcher(ORIGIN+endpoint,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',headers,body:JSON.stringify(kind==='query'?{q,providers:selectedProvider,num:12,page:pageNumber(page)}:{q,providers:selectedProvider}),signal:abort.signal});}
   catch(err){throw Error(abort.signal.aborted?'通信がタイムアウトまたは中断されました':'APIに接続できません（CORS・ネットワーク設定を確認）');}
   if(res.status===401||res.status===403)throw Error('APIキー・利用権限を確認してください（HTTP '+res.status+'）');
   if(res.status===429)throw Error('APIのレート制限に達しました。時間をおいてください');
   if(res.status===404)return kind==='query'?[]:null;
   if(!res.ok)throw Error('javinfo API HTTP '+res.status);
   const type=res.headers?.get('content-type')||'';
   if(!/\bjson\b|\/json(?:\s*;|$)/i.test(type))throw Error('JSON以外の応答です');
   if(Number(res.headers?.get('content-length')||0)>MAX_BYTES)throw Error('レスポンスが大きすぎます');
   const text=await res.text();if(new TextEncoder().encode(text).length>MAX_BYTES)throw Error('レスポンスが大きすぎます');
   const data=JSON.parse(text);
   return kind==='query'?normalizeSearch(data,{provider:selectedProvider}):normalizeDetail(data,{provider:selectedProvider});
  } finally{clearTimeout(timer);}
 }
 async function search(term,key,options){return request('query',term,key,options);}
 async function movie(code,key,options){return request('movie',code,key,options);}
 return {ORIGIN,PROVIDERS,providerId,directMediaURL,playbackDiagnosis,search,movie,item,normalizeSearch,normalizeDetail,apiKey,queryText,dvdCode,streamURL,pageNumber,uniqueResults};
});
