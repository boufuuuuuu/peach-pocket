/* Read-only reconciliation planning for locally stored media. Never deletes data. */
(function(root,factory){
 const m=factory();if(typeof module==='object'&&module.exports)module.exports=m;else root.PeachHealth=m;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function inspect(records,mediaRows,thumbIds=[]){
  const items=Array.isArray(records)?records:[],media=Array.isArray(mediaRows)?mediaRows:[];
  const ids=new Set(items.map(x=>x.id));
  const map=new Map(media.filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
  const missing=[],unmarked=[],orphans=[],orphanThumbnails=[],patches=[];
  let bytes=0;
  for(const m of map.values())bytes+=Number.isSafeInteger(m.size)&&m.size>0?m.size:0;
  for(const item of items){
   const exists=map.has(item.id);
   if(item.hasLocalCopy&&!exists){missing.push(item.id);patches.push({id:item.id,hasLocalCopy:false});}
   else if(!item.hasLocalCopy&&exists){unmarked.push(item.id);patches.push({id:item.id,hasLocalCopy:true});}
  }
  for(const id of map.keys())if(!ids.has(id))orphans.push(id);
  for(const id of thumbIds)if(!ids.has(id))orphanThumbnails.push(id);
  return {totalItems:items.length,totalMedia:media.length,bytes,missing,unmarked,orphans,orphanThumbnails,patches};
 }
 function repaired(items,report){
  const patches=new Map(report.patches.map(x=>[x.id,x.hasLocalCopy]));
  return items.filter(x=>patches.has(x.id)).map(x=>({...x,hasLocalCopy:patches.get(x.id)}));
 }
 return {inspect,repaired};
});
