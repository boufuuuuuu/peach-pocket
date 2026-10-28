/* 桃息吐息: privacy-preserving native-media stage diagnostics.
 * Tracks milestones and NON-SENSITIVE URL structure only:
 * NEVER stores full stream URLs, headers, keys, or media bytes.
 * A stage observation narrows failure timing; it does not prove its root cause.
 */
(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.PeachRouteDiagnostics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const LABELS=Object.freeze({master:'マスター',variant:'画質別',directHls:'直接HLS',directFile:'動画ファイル'});
 const EVENTS=new Set(['loadstart','loadedmetadata','loadeddata','canplay','playing','waiting','stalled','progress']);
 const MAX_ATTEMPTS=8;
 // Never include path contents, query values, fragment, userinfo, or signed media
 // URL in routine reports. The hostname is useful for checking shared origin.
 function summary(raw){
  if(typeof raw!=='string')return null;
  try{
   const url=new URL(raw);
   if(url.protocol!=='https:'||url.username||url.password)return null;
   const path=url.pathname.toLowerCase();
   const format=path.endsWith('.m3u8')?'HLS (.m3u8)':
    /\.(mp4|m4v|mov|webm)$/.test(path)?'動画ファイル':
    '拡張子から判定不可';
   return Object.freeze({host:url.hostname.slice(0,253),format,hasQuery:Boolean(url.search)});
  }catch{return null;}
 }

 function session(){
  let attempts=[],current=null;
  function begin(kind,sourceURL){
   if(attempts.length>=MAX_ATTEMPTS)return false;
   current={kind:Object.prototype.hasOwnProperty.call(LABELS,kind)?kind:'directHls',
    urlInfo:summary(sourceURL),events:new Set(),error:null,progressed:false};
   attempts.push(current);return true;
  }
  function observed(event){
   if(current&&EVENTS.has(event))current.events.add(event);
  }
  function advanced(){if(current)current.progressed=true;}
  function failed(code){if(current)current.error=Number.isInteger(code)&&code>=1&&code<=4?code:0;}
  function entries(){
   return attempts.map((a,i)=>({
    order:i+1,kind:a.kind,urlInfo:a.urlInfo,
    loadstart:a.events.has('loadstart'),
    metadata:a.events.has('loadedmetadata'),
    canplay:a.events.has('canplay'),
    playing:a.events.has('playing'),
    progressed:a.progressed,
    interrupted:a.events.has('waiting')||a.events.has('stalled'),
    error:a.error
   }));
  }
  function label(a){
   const stage=a.progressed?'再生位置進行あり':
    a.playing?'playing到達（時間進行未確認）':
    a.canplay?'canplay到達（再生未確認）':
    a.metadata?'メタデータ取得済み':
    a.loadstart?'メタデータ取得前':'読み込み開始未確認';
   const error=a.error===null?'エラー未記録':`MediaError ${a.error}`;
   const u=a.urlInfo;
   const urlNote=u?` / 設定URL概要: ${u.host}・${u.format}・クエリ${u.hasQuery?'あり':'なし'}`:'';
   return `候補${a.order}（${LABELS[a.kind]||LABELS.directHls}）: ${stage} / ${error}${a.interrupted?' / 待機・停滞あり':''}${urlNote}`;
  }
  function report(appVersion){
   const list=entries();
   // This label is supplied by the current app footer: no duplicated version constant.
   const version=typeof appVersion==='string'&&/^v\d+\.\d+\.\d+$/.test(appVersion.trim())
    ?' '+appVersion.trim():'';
   return ['桃息吐息'+version+'・再生経路診断（URL概要のみ・機密値なし）',
    `試行候補: ${list.length}件`,...list.map(label),
    'URL概要はSafariに設定したURLのホスト・形式・クエリ有無のみ。リダイレクト先やセグメントURLは未確認。',
    '判定: この記録はSafariの読み込み段階のみ。HTTP拒否・CORS・HLS構造・セグメント・コーデックの原因は確定できません。',
    '比較: 標準HLSが成功していても外部配信での再生成功は保証されません。'].join('\n');
  }
  function reset(){attempts=[];current=null;}
  return Object.freeze({begin,observed,advanced,failed,entries,report,reset});
 }
 return Object.freeze({session,summary});
});
