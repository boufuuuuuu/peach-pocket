/* Catalog grouping and one-click playback decisions. No network, no site scraping. */
(function(root,factory){
 const c=factory(typeof module==='object'&&module.exports?require('./core.js'):root.PeachCore);
 if(typeof module==='object'&&module.exports)module.exports=c;else root.PeachCatalog=c;
})(typeof globalThis!=='undefined'?globalThis:this,function(Core){
 'use strict';
 function identity(row){
  const code=Core.norm(row?.code);
  if(code)return `code:${code}`;
  const title=Core.clean(row?.title||'',250).toLowerCase().replace(/\s+/g,' ');
  if(!title)return '';
  // Without a code, do not merge across providers: common titles are ambiguous.
  return `source:${row.provider}:${title}`;
 }
 function aggregate(rows,library=[]){
  const byKey=new Map();const savedByKey=new Map();
  for(const row of library){const k=identity(row);if(!savedByKey.has(k))savedByKey.set(k,[]);savedByKey.get(k).push(row);}
  for(const row of rows){
    const key=identity(row);if(!key)continue;
    let group=byKey.get(key);
    if(!group){group={key,code:row.code||'',title:row.title||row.code||'名称未設定',performers:[],coverURL:'',sources:[],saved:savedByKey.get(key)||[],playable:null,embedPlayable:null,publishedAt:''};byKey.set(key,group);}
    if(group.sources.some(x=>x.provider===row.provider&&x.referenceURL===row.referenceURL&&x.code===row.code))continue;
    group.sources.push(row);
    for(const n of row.performers||[])if(n&&!group.performers.includes(n))group.performers.push(n);
    if(!group.coverURL&&row.coverURL)group.coverURL=row.coverURL;
    if(!group.playable&&row.rightsConfirmed===true&&row.playbackURL)group.playable=row;
    if(!group.embedPlayable&&row.rightsConfirmed===true&&row.embedURL)group.embedPlayable=row;
    if(row.publishedAt&&(!group.publishedAt||row.publishedAt>group.publishedAt))group.publishedAt=row.publishedAt;
  }
  return [...byKey.values()].map(g=>({...g,isFavorite:g.saved.some(x=>x.isFavorite),isWatched:g.saved.some(x=>x.isWatched),lastPosition:Math.max(0,...g.saved.map(x=>Number(x.lastPosition)||0))}));
 }
 function mergeWithExisting(result,existing,genId){
  const k=identity(result);const found=existing.find(r=>r.provider===result.provider&&identity(r)===k);
  const state=found||existing.find(r=>identity(r)===k)||{};
  const source={...(found||{}),...result,id:found?.id||genId(),
   isFavorite:Boolean(state.isFavorite),isWatched:Boolean(state.isWatched),
   lastPosition:state.lastPosition||0,duration:state.duration||0,
   watchCount:found?.watchCount||0,watchedSeconds:found?.watchedSeconds||0,
   lastPlayedAt:found?.lastPlayedAt||'',hasLocalCopy:Boolean(found?.hasLocalCopy)};
  // Never overwrite a user's title or cast while refreshing the catalog.
  if(found){source.title=found.title;source.performers=found.performers?.length?found.performers:result.performers;}
  return Core.canonical(source,genId);
 }
 function newFollowed(groups,follows,seenIds){
  const watched=new Set(follows.map(x=>String(x).trim().toLowerCase()).filter(Boolean));
  const seen=new Set(seenIds);
  return groups.filter(g=>g.performers.some(p=>watched.has(p.toLowerCase()))&&!seen.has(g.key));
 }
 function linkedStateUpdates(target,records,patch){
   const key=identity(target);if(!key)return [];
   const permitted=['isFavorite','isWatched','lastPosition','duration','progressPercent'];
   const cleanPatch=Object.fromEntries(Object.entries(patch).filter(([k])=>permitted.includes(k)));
   return records.filter(r=>identity(r)===key).map(r=>Core.canonical({...r,...cleanPatch},()=>r.id));
 }
 function safePlayable(row,allowedOrigins){
  if(!row||row.rightsConfirmed!==true||!row.playbackURL)return '';
  const raw=Core.safeURL(row.playbackURL,'licensed');
  if(!raw)return '';
  try {const u=new URL(raw);return allowedOrigins.includes(u.origin)?u.href:'';}catch{return '';}
 }
 function safeEmbed(row,allowedOrigins){
  if(!row||row.rightsConfirmed!==true||!row.embedURL)return '';
  const raw=Core.safeURL(row.embedURL,'licensed');if(!raw)return '';
  try{const u=new URL(raw);return allowedOrigins.includes(u.origin)?u.href:'';}catch{return '';}
 }
 return {identity,aggregate,mergeWithExisting,newFollowed,linkedStateUpdates,safePlayable,safeEmbed};
});
