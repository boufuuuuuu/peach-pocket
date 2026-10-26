/* Local external-link visit log. A link open is NOT verified playback. */
(function(root,factory){const m=factory();if(typeof module==='object'&&module.exports)module.exports=m;else root.PeachExternal=m;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const providerHosts=Object.freeze([
  ['missav',['missav.ws','missav.ai']],['javdb',['javdb.com']],['jable',['jable.tv']],
  ['ro85',['85ro.com']],['njavtv',['njavtv.com']],['tktube',['tktube-cb.com']]
 ]);
 function providerFromURL(raw){
  try{const hostname=new URL(raw).hostname.toLowerCase();for(const [id,hosts] of providerHosts)if(hosts.some(h=>hostname===h||hostname==='www.'+h))return id;}catch{}
  return 'external';
 }
 function suggestedTitle(raw){try{const u=new URL(raw);const tail=u.pathname.split('/').filter(Boolean).pop()||'';let label='';try{label=decodeURIComponent(tail);}catch{label=tail;}label=label.replace(/[-_]+/g,' ').trim();return (label&&label.length>2?label:u.hostname).slice(0,140);}catch{return '外部作品';}}
 function markOpened(row,at=new Date().toISOString()){
  if(!row||typeof row!=='object')throw Error('作品情報が不正です');
  if(!/^\d{4}-\d{2}-\d{2}T/.test(at))throw Error('日時が不正です');
  return {...row,externalOpenCount:Math.min(1000000,Math.max(0,Number(row.externalOpenCount)||0)+1),lastExternalOpenedAt:at,updatedAt:at};
 }
 function latestAt(row){return [row.lastPlayedAt,row.lastExternalOpenedAt].filter(Boolean).sort().at(-1)||'';}
 function recent(items){return (items||[]).filter(x=>latestAt(x)).sort((a,b)=>latestAt(b).localeCompare(latestAt(a)));}
 return {providerFromURL,suggestedTitle,markOpened,latestAt,recent};
});
