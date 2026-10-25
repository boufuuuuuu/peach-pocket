(function(root,factory){const s=factory();if(typeof module==='object'&&module.exports)module.exports=s;else root.PeachStats=s;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function compute(items){const rows=Array.isArray(items)?items:[];return {
   count:rows.length,favorites:rows.filter(r=>r.isFavorite).length,watched:rows.filter(r=>r.isWatched).length,
   plays:rows.reduce((t,r)=>t+Math.max(0,Number(r.watchCount)||0),0),
   watchHours:(rows.reduce((t,r)=>t+Math.max(0,Number(r.watchedSeconds)||0),0)/3600).toFixed(1)
 };}
 return {compute};
});
