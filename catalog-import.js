/* Offline import for legitimately obtained metadata. No scraping or media extraction. */
(function(root,factory){
 const a=factory(typeof module==='object'&&module.exports?require('./provider-live.js'):root.PeachLive,typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore);
 if(typeof module==='object'&&module.exports)module.exports=a;else root.PeachCatalogImport=a;
})(typeof globalThis!=='undefined'?globalThis:this,function(Live,Core){
 'use strict';
 const MAX_ROWS=400,MAX_FILE_BYTES=2*1024*1024;
 function parse(raw,coverOrigins=[]){
  const feeds=Array.isArray(raw?.catalogs)?raw.catalogs:[raw];
  if(!feeds.length||feeds.length>4)throw Error('1～4提供元のcatalogs配列が必要です');
  const result=[];
  for(const feed of feeds){
   if(!feed || !Live.IDS.includes(feed.provider)||!Array.isArray(feed.results))throw Error('providerとresults配列が必要です');
   if(feed.results.length>MAX_ROWS||result.length+feed.results.length>MAX_ROWS)throw Error('合計400件まで取り込めます');
   // Existing live validator intentionally truncates to 30. Validate every imported row.
   for(let i=0;i<feed.results.length;i+=30){
    const batch=Live.validateCatalog(feed.provider,{results:feed.results.slice(i,i+30)},[],coverOrigins);
    for(const row of batch){
     // A file upload cannot independently certify streaming rights.
     result.push({...row,playbackURL:'',embedURL:'',rightsConfirmed:false});
    }
   }
  }
  return result;
 }
 function merge(oldRows,added){
  const map=new Map();
  for(const row of [...oldRows,...added]){
   if(!Live.IDS.includes(row?.provider))continue;
   const id=Core.norm(row.code);
   const key=id?`${row.provider}:${id}`:`${row.provider}:${row.referenceURL||row.title}`;
   map.set(key,{...row,rightsConfirmed:false,playbackURL:''});
  }
  const values=[...map.values()];if(values.length>MAX_ROWS)throw Error('保存する作品情報は400件までです');
  return values;
 }
 function search(rows,query){
  const q=Core.clean(query,120).toLowerCase(),code=Core.norm(q);
  if(q.length<2)return [];
  return rows.filter(r=>[r.title,r.code,...r.performers].some(s=>String(s||'').toLowerCase().includes(q))||(code&&Core.norm(r.code).includes(code))).slice(0,100);
 }
 return {parse,merge,search,MAX_ROWS,MAX_FILE_BYTES};
});
