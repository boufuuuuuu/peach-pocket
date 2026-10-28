/* Native video playback accounting: testable independently of IndexedDB.
 * Counts one start per media session only on 'playing'.
 * Watched seconds are elapsed real viewing time, bounded by media advance.
 */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.PeachPlayback=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 function session(){
  let started=false,active=false,seeking=false,lastTime=null,lastAt=null,pending=0;
  function start(time,at){
   const first=!started;started=true;active=true;seeking=false;
   lastTime=Number.isFinite(time)?time:0;lastAt=at;return first;
  }
  function tick(time,at,rate=1){
   if(!started||!active||seeking||!Number.isFinite(time)||!Number.isFinite(at))return 0;
   if(lastTime===null||lastAt===null){lastTime=time;lastAt=at;return 0;}
   const dt=Math.max(0,Math.min(30,(at-lastAt)/1000));
   const advance=time-lastTime;
   const speed=Math.max(.25,Math.min(4,Number(rate)||1));
   // Reject seeks/jumps; small 0.8s tolerance allows normal timeupdate jitter.
   const viewed=advance>0&&dt>0&&advance<=dt*speed+.8?Math.min(dt,advance/speed):0;
   lastTime=time;lastAt=at;pending+=viewed;return viewed;
  }
  function hold(time,at,rate){const viewed=tick(time,at,rate);active=false;return viewed;}
  function beginSeek(){seeking=true;active=false;}
  function endSeek(time,at,isPlaying){
   seeking=false;lastTime=Number.isFinite(time)?time:0;lastAt=at;active=Boolean(isPlaying&&started);
  }
  function take(){const n=pending;pending=0;return n;}
  function restore(n){if(Number.isFinite(n)&&n>0)pending+=n;}
  return {start,tick,hold,beginSeek,endSeek,take,restore,hasStarted:()=>started};
 }
 return Object.freeze({session});
});
