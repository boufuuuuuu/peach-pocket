/* Peach Pocket provider adapters.
 * No scraping, relay, DRM handling, third-party login or video URL extraction.
 * Requires a user-authorized public, browser-CORS-enabled JSON catalog endpoint.
 */
(function(root, factory) {
  const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PeachLive=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
  'use strict';
  const IDS=['missav','javdb','jable','ro85'];
  const LIMIT=30;
  const MAX_RESPONSE=1024*1024;
  function isProvider(id){return IDS.includes(id);}
  function httpsURL(value){
    const url=Core.safeURL(value,'licensed');
    return url?new URL(url):null;
  }
  function endpointURL(input){
    try{const raw=new URL(String(input||''));if(raw.search||raw.hash)return null;}catch{return null;}
    const url=httpsURL(input);
    // URLs with query params may leak secrets to logs; never accept them as configuration.
    if(!url||url.search||url.hash||!/^\/$|^\/[a-zA-Z0-9._~!$&'()*+,;=:@/-]*$/.test(url.pathname))return null;
    return url;
  }
  function validOrigin(raw){
    try { const original=new URL(String(raw||''));if(original.search||original.hash)return null;const u=httpsURL(raw);return u&&u.href===u.origin+'/'?u.origin:null; }catch{return null;}
  }
  function parseOrigins(text){
    const values=String(text||'').split(/[\s,、]+/).filter(Boolean);
    if(values.length>15)throw Error('許可ホストは15個までです');
    const set=[];
    for(const raw of values){const origin=validOrigin(raw);if(!origin)throw Error('HTTPSのオリジンのみを入力してください（例：https://media.example.org）');if(!set.includes(origin))set.push(origin);}
    return set;
  }
  function siteHomepage(provider){
    if(!isProvider(provider))throw Error('未対応サイト');
    return ({missav:'https://missav.ws/',javdb:'https://javdb.com/',jable:'https://jable.tv/',ro85:'https://www.85ro.com/ja/'})[provider];
  }
  // 85ro: the search-form URL contract is unverified, so open the proven Japanese home page.
  function supportsDeepSearch(provider){if(!isProvider(provider))throw Error('未対応サイト');return provider!=='ro85';}
  function siteSearchURL(provider,query){
    if(!isProvider(provider))throw Error('未対応サイト');
    const q=String(query||'').trim().slice(0,120);
    if(!q)return '';
    if(provider==='ro85')return siteHomepage(provider);
    if(provider==='missav')return `https://missav.ws/search/${encodeURIComponent(q)}`;
    if(provider==='jable')return `https://jable.tv/search/${encodeURIComponent(q)}/`;
    return `https://javdb.com/search?q=${encodeURIComponent(q)}`;
  }
  function parseCatalogRow(provider,source,allowedOrigins,allowedCoverOrigins=[]){
    if(!source||typeof source!=='object'||Array.isArray(source))return null;
    const title=Core.clean(source.title,250),code=Core.clean(source.code,64);
    if(!title&&!code)return null;
    let sourceURL='';
    if(source.referenceURL||source.sourceURL||source.url){
      sourceURL=Core.safeURL(source.referenceURL||source.sourceURL||source.url,provider);
      if(!sourceURL)return null;
    }
    const cast=source.performers||source.actors||[];
    const performers=(Array.isArray(cast)?cast:String(cast).split(/[,、]/)).slice(0,20)
      .map(n=>Core.clean(typeof n==='string'?n:n?.name||'',80)).filter(Boolean);
    const cover=httpsURL(source.coverURL||source.poster||'');
    const coverURL=cover&&allowedCoverOrigins.includes(cover.origin)?cover.href:'';
    // An explicit contractual flag in a trusted catalog is necessary; a scraped
    // URL, referer spoofing or found .m3u8 alone must never grant playback.
    const permitted=source.rights?.playbackAllowed===true && source.rights?.confirmed===true;
    const stream=httpsURL(source.playbackURL||source.streamURL||'');
    const allowed=stream && allowedOrigins.includes(stream.origin);
    const playbackURL=(permitted&&allowed)?stream.href:'';
    return {provider,title:title||code,code,performers,referenceURL:sourceURL,
      coverURL,playbackURL,rightsConfirmed:Boolean(permitted&&allowed),
      publishedAt:/^\d{4}-\d{2}-\d{2}$/.test(String(source.publishedAt||''))?source.publishedAt:''};
  }
  function validateCatalog(provider,payload,allowedOrigins=[],coverOrigins=[]){
    if(!isProvider(provider))throw Error('未対応サイト');
    const items=Array.isArray(payload)?payload:payload?.results;
    if(!Array.isArray(items))throw Error('結果はresults配列で返してください');
    if(items.length>100)throw Error('結果は最大100件までです');
    return items.slice(0,LIMIT).map(x=>parseCatalogRow(provider,x,allowedOrigins,coverOrigins)).filter(Boolean);
  }
  async function search(provider,query,endpoint,allowedOrigins=[],fetcher=fetch,coverOrigins=[]){
    if(!isProvider(provider))throw Error('未対応サイト');
    const u=endpointURL(endpoint);
    if(!u)throw Error('HTTPSの公開JSON API URLを設定してください（秘密鍵付きURLは禁止）');
    const q=Core.clean(query,120);
    if(!q)throw Error('検索キーワードを入力してください');
    u.searchParams.set('provider',provider);u.searchParams.set('q',q);
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    try {
      const res=await fetcher(u.href,{method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      if(!res.ok)throw Error(`HTTP ${res.status}`);
      const type=res.headers?.get('content-type')||'';
      if(!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(type))throw Error('JSON以外の応答です');
      const size=Number(res.headers?.get('content-length')||0);
      if(size>MAX_RESPONSE)throw Error('レスポンスが1MBを超えています');
      const text=await res.text();
      if(text.length>MAX_RESPONSE)throw Error('レスポンスが1MBを超えています');
      return validateCatalog(provider,JSON.parse(text),allowedOrigins,coverOrigins);
    } finally {clearTimeout(timeout);}
  }
  return {IDS,endpointURL,parseOrigins,validOrigin,siteHomepage,supportsDeepSearch,siteSearchURL,parseCatalogRow,validateCatalog,search};
});
