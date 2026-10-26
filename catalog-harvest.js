/* Authorized catalog feed pagination. Never crawls a provider website or discovers URLs.
 * A configured first-party/authorized CORS JSON endpoint must explicitly expose pages.
 * Each scan is bounded, cancellable in caller code, and metadata-only on disk. */
(function(root,factory){
 const api=factory(typeof module==='object'&&module.exports?require('./provider-live.js'):root.PeachLive);
 if(typeof module==='object'&&module.exports)module.exports=api;else root.PeachHarvest=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Live){
 'use strict';
 const MAX_PAGES=10, MAX_ROWS=400, MAX_BODY=1024*1024;
 function cursor(raw){
  if(raw===null||raw===undefined||raw==='')return '';
  if(typeof raw!=='string'||raw.length>180||/[\x00-\x1f\x7f]/.test(raw))throw Error('不正な次ページカーソルです');
  return raw;
 }
 async function onePage(provider,endpoint,token='',allowedOrigins=[],coverOrigins=[],fetcher=fetch){
  if(!Live.IDS.includes(provider))throw Error('未対応サイト');
  const u=Live.endpointURL(endpoint);
  if(!u)throw Error('権限のあるCORS対応HTTPSカタログAPIが必要です');
  u.searchParams.set('provider',provider);u.searchParams.set('limit','100');
  if(token)u.searchParams.set('cursor',cursor(token));
  const ctl=new AbortController(),timeout=setTimeout(()=>ctl.abort(),12000);
  try{
   const res=await fetcher(u.href,{method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal:ctl.signal,headers:{Accept:'application/json'}});
   if(!res.ok)throw Error('HTTP '+res.status);
   if(!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(res.headers?.get('content-type')||''))throw Error('JSON以外の応答です');
   if(Number(res.headers?.get('content-length')||0)>MAX_BODY)throw Error('応答上限1MB');
   const text=await res.text();if(text.length>MAX_BODY)throw Error('応答上限1MB');
   const body=JSON.parse(text);
   if(!Array.isArray(body?.results)||body.results.length>100)throw Error('results配列は1ページ100件まで');
   const rows=body.results.map(r=>Live.parseCatalogRow(provider,r,allowedOrigins,coverOrigins)).filter(Boolean);
   return {rows,nextCursor:cursor(body.nextCursor),hasMore:Boolean(body.nextCursor)};
  }finally{clearTimeout(timeout);}
 }
 async function scan(provider,endpoint,{fetcher=fetch,allowedOrigins=[],coverOrigins=[],maxPages=MAX_PAGES,onPage}={}){
  const pages=Math.min(MAX_PAGES,Math.max(1,Number(maxPages)||1));
  const results=[],seen=new Set();let token='',hasMore=false,completed=0;
  for(let i=0;i<pages&&results.length<MAX_ROWS;i++){
   const page=await onePage(provider,endpoint,token,allowedOrigins,coverOrigins,fetcher);
   results.push(...page.rows.slice(0,MAX_ROWS-results.length));completed++;
   hasMore=page.hasMore;
   if(onPage)await onPage({page:completed,total:results.length,hasMore});
   if(!page.hasMore)break;
   if(seen.has(page.nextCursor))throw Error('取得先のページ指定が循環しています');
   seen.add(page.nextCursor);token=page.nextCursor;
  }
  return {rows:results,pages:completed,incomplete:hasMore||results.length>=MAX_ROWS};
 }
 return {onePage,scan,cursor,MAX_PAGES,MAX_ROWS};
});
