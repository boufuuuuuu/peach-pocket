/* MissAV interoperability: normalizes metadata exported by misscore/FastAPI or
 * the unofficial Python client. Does NOT scrape, fetch playback manifests,
 * assume streaming rights, or bundle third-party AGPL code.
 */
(function(root,factory){
 const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore,
                   typeof module==='object'&&module.exports?require('./provider-live.js'):root.PeachLive);
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.PeachMissavCompat=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core,Live){
 'use strict';
 const MAX_BYTES=2*1024*1024, MAX_ROWS=400;
 function first(obj,...keys){for(const k of keys){if(obj?.[k]!==undefined && obj[k]!==null && obj[k]!=='')return obj[k];}return '';}
 function rows(payload){
  if(Array.isArray(payload))return payload;
  if(!payload||typeof payload!=='object')throw Error('JSONオブジェクトか配列が必要です');
  for(const key of ['results','videos','movies','items','list','data']){
   const inner=payload[key];
   if(Array.isArray(inner))return inner;
   if(inner&&typeof inner==='object'&&inner!==payload){
    const list=rowsOrNull(inner);if(list)return list;
   }
  }
  if(first(payload,'video_code','title','title_original_japanese','name'))return [payload];
  throw Error('作品一覧が見つかりません。results / data / videos配列などが必要です');
 }
 function rowsOrNull(obj){
  if(Array.isArray(obj))return obj;
  for(const k of ['results','videos','movies','items','list','data'])if(Array.isArray(obj?.[k]))return obj[k];
  if(first(obj,'video_code','title','title_original_japanese'))return [obj];
  return null;
 }
 function extractPerformers(raw){
  const v=first(raw,'performers','actors','actresses','stars','cast');
  return (Array.isArray(v)?v:typeof v==='string'?v.split(/[,、，]/):[])
    .slice(0,20).map(x=>Core.clean(typeof x==='object'?first(x,'name','title'):x,80)).filter(Boolean);
 }
 function normalize(raw,coverOrigins=[]){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const title=Core.clean(first(raw,'title','title_original_japanese','video_title','name'),250);
  const code=Core.clean(first(raw,'video_code','code','product_code','number','dvd_id'),64);
  if(!title&&!code)return null;
  const source=first(raw,'referenceURL','reference_url','page_url','url','link','web_url');
  const referenceURL=source?Core.safeURL(source,'missav'):'';
  if(source&&!referenceURL)return null;
  const cover=first(raw,'coverURL','cover_url','thumbnail','thumbnail_url','poster','image');
  const candidate=Core.safeURL(cover,'licensed');
  let coverURL='';
  try{if(candidate&&coverOrigins.includes(new URL(candidate).origin))coverURL=candidate;}catch{}
  const date=String(first(raw,'publishedAt','publish_date','release_date','date'));
  return {provider:'missav',title:title||code,code,performers:extractPerformers(raw),referenceURL,coverURL,
   publishedAt:/^\d{4}-\d\d-\d\d/.test(date)?date.slice(0,10):'',
   // Imported, third-party JSON cannot prove distribution/playback rights.
   rightsConfirmed:false,playbackURL:'',embedURL:''};
 }
 function parse(payload,coverOrigins=[]){
  const input=typeof payload==='string'?JSON.parse(payload):payload;
  const list=rows(input);
  if(list.length>MAX_ROWS)throw Error('1回400件まで取り込めます');
  const result=list.map(x=>normalize(x,coverOrigins)).filter(Boolean);
  if(!result.length)throw Error('有効なMISSAV作品情報がありません');
  return result;
 }
 function checkedEndpoint(input){
  if(String(input||'').includes('#'))throw Error('URLフラグメントは使用できません');
  const u=Core.safeURL(input,'licensed');
  if(!u)throw Error('公開HTTPSのJSON API URLのみ指定できます');
  const parsed=new URL(u);
  if(parsed.hash)throw Error('URLフラグメントは使用できません');
  for(const key of parsed.searchParams.keys()){
   if(/token|key|password|secret|auth|session|credential/i.test(key))throw Error('認証情報をURLへ埋め込まないでください');
  }
  return parsed.href;
 }
 async function request(endpoint,{authKey='',fetcher=fetch,signal}={}){
  const url=checkedEndpoint(endpoint);
  const key=String(authKey||'');
  if(key.length>256||/[\r\n]/.test(key))throw Error('認証キーの形式が不正です');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  const onAbort=()=>controller.abort();
  if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',onAbort,{once:true});}
  try{
   const headers={Accept:'application/json'};
   if(key)headers['auth-key']=key;
   const res=await fetcher(url,{method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',headers,signal:controller.signal});
   if(!res.ok)throw Error('API応答エラー HTTP '+res.status);
   const mime=res.headers?.get('content-type')||'';
   if(!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(mime))throw Error('JSONではない応答です');
   if(Number(res.headers?.get('content-length')||0)>MAX_BYTES)throw Error('応答が2MBを超えています');
   const text=await res.text();
   if(text.length>MAX_BYTES)throw Error('応答が2MBを超えています');
   return JSON.parse(text);
  }finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);}
 }
 return {parse,normalize,rows,checkedEndpoint,request,MAX_BYTES,MAX_ROWS};
});
