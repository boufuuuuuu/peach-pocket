'use strict';
// All library records remain in this browser's IndexedDB; video files are NEVER uploaded.
const {PROVIDERS,clean,norm,safeURL,canonical,duplicateGroups,crossProviderGroups,fileDuplicateGroups,importRows} = PeachCore;
const {encrypt, decrypt, isEncrypted, passOK} = PeachBackup;
const Media = PeachMedia;
const Live = PeachLive;
const Catalog = PeachCatalog;
const CatalogImport = PeachCatalogImport;
const Harvest = PeachHarvest;
const MissavCompat = PeachMissavCompat;
const Javinfo = PeachJavinfo;
const KeyVault = PeachKeyVault;
const Health = PeachHealth;
const FullBackup = PeachFullBackup;
const CloudSync = PeachCloudSync;
const External = PeachExternal;
const Download = PeachDownload;
const StreamDiagnostics = PeachStreamDiagnostics;
const Hls = PeachHls;
const Playback = PeachPlayback;
const Route = PeachRouteDiagnostics;
let cloudSession=null,cloudBusy=false;
const DATABASE='peach-pocket-db1';
const $=id=>document.getElementById(id);
const objUrls=new Map();
const volatileFiles=new Map();
const thumbnailURLs=new Map();
const thumbnailJobs=new Map();
const thumbnailFailed=new Set();
let db,records=[],activeId=null,currentId=null,selectedFileItem=null,lastSavedAt=0,loading=false,installation=null;
let followNames=[], subtitleObjectURL=null, playingUrl=null;
let liveSettings={api:{missav:'',javdb:'',jable:'',ro85:''},mediaOrigins:[],coverOrigins:[],autoSearch:true};
let liveCatalogRows=[],offlineCatalogRows=[],autoSearchTimer=null,followCheckBusy=false,healthReport=null;
let liveSearchRun=0,harvestBusy=false,embedPlaying=false,embeddedCurrentId=null;
let saveTargetId=null, directDownloadAbort=null;
// Only volatile: never save API-provided signed HLS URLs to IndexedDB or backups.
let activeHlsCandidates=[],activeHlsIndex=0,playbackClock=Playback.session(),demoPlayback=false;
let playbackWriteQueue=Promise.resolve();
let routeTrace=Route.session(),activeHlsKinds=[],routeReport='';
// Public demonstration HLS streams published for interoperability testing.
// Unlike locally bundled MP4, these require network access; never store them.
const HLS_BASELINE=Object.freeze({
 ts:{label:'標準HLS（MPEG-TS）',url:'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8'},
 fmp4:{label:'標準HLS（fMP4）',url:'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8'}
});
let playbackTestKind='',activePlayerItem=null;
function setHlsBaselineStatus(kind,text){$(kind==='ts'?'hlsTsStatus':'hlsFmp4Status').textContent=text;}
function playHlsBaseline(kind){
 const source=HLS_BASELINE[kind];
 if(!source)return;
 setHlsBaselineStatus(kind,`${source.label}：読込み中。映像の時間が進むまで成功とは判定しません。`);
 const sample={id:'__peach_hls_baseline__',title:source.label+' 再生テスト',provider:'local',lastPosition:0,hasLocalCopy:false};
 play(sample,source.url,{demo:true,testKind:kind});
}

let javinfoResults=[],javinfoBusy=false,javinfoPage=1,javinfoTerm="",javinfoLastProvider="missav",javinfoPageSize=12,javinfoMore=false,playSession=0,playbackBegan=false;
const uid=()=>globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const elem=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n;};
function toast(message){const n=$('toast');n.textContent=message;n.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>n.classList.remove('show'),3400);}
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DATABASE,4);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('items'))req.result.createObjectStore('items',{keyPath:'id'});if(!req.result.objectStoreNames.contains('meta'))req.result.createObjectStore('meta',{keyPath:'key'});if(!req.result.objectStoreNames.contains('media'))req.result.createObjectStore('media',{keyPath:'id'});if(!req.result.objectStoreNames.contains('thumbnails'))req.result.createObjectStore('thumbnails',{keyPath:'id'});};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
function readMeta(key){return new Promise((resolve,reject)=>{const req=db.transaction('meta').objectStore('meta').get(key);req.onsuccess=()=>resolve(req.result?.value);req.onerror=()=>reject(req.error);});}
function writeMeta(key,value){return new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({key,value});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
// javinfo API credentials are optionally encrypted and stored in this device's IndexedDB.
// This is strictly opt-in, never transmitted to GitHub, backup exports or cloud sync.
// As with every client-side secret, malicious same-origin scripts could still access it.
function javinfoCredentials(){return Javinfo.apiKey($('javinfoKey').value);}
function javinfoStatus(message){$('javinfoStatus').textContent=message;}
// In-memory diagnostics only. Do not retain media URLs, query strings, or API keys.
function clearPlaybackDiagnostic(){
 $('playbackDiagnosticStatus').textContent='この起動中に記録された再生エラーはありません。';
 $('viewPlaybackDiagnostic').hidden=true;
}
function classifyPlaybackFailure(code,online,format,src){
 const c=Number(code)||0;
 let origin='';
 try{origin=new URL(src).origin;}catch{}
 const out={kind:'不明',detail:'',hint:''};
 if(!online){out.kind='オフライン';out.detail='iPhoneがネットワークに接続していません。';out.hint='Wi-Fi／モバイル通信を確認してください。';}
 else if(c===1){out.kind='読み込み中断';out.detail='動画の読み込みが中断されました。';}
 else if(c===2){
   out.kind='ネットワーク／配信拒否';
   if(src&&looksEphemeralURL(src)){out.detail='URLの有効期限切れの可能性が高いです。';out.hint='期限付きURLの場合は、URLを再取得して再登録してください。';}
   else{out.detail='配信元が通信を拒否したか、CORS・回線の問題の可能性があります。';out.hint='配信元がブラウザ直接再生を許可していない場合があります。参照URLから元サイトで確認してください。';}
 }
 else if(c===3){out.kind='デコード失敗';out.detail='Safariが動画データを解釈できませんでした。非標準のHLSセグメント形式の可能性があります。';out.hint='配信形式の問題のため、同じURLでの再試行は効果が薄い場合があります。';}
 else if(c===4){
   out.kind='形式・URL非対応';
   if(format==='hls'){out.detail='HLSの読込みが成立しませんでした。';out.hint='URL・アクセス制限・プレイリスト・セグメント・コーデックのいずれが原因かは未確定です。';}
   else{out.detail='このiPhoneで再生できない形式の可能性があります。';out.hint='配信元が認める形式でURLを再取得してください。';}
 }
 else{out.kind='不明なエラー';out.detail='動画の読み込みに失敗しました。';}
 if(origin)out.detail+=`（配信元: ${origin}）`;
 return out;
}
function reportPlaybackDiagnostic(code, online, format, src){
 const mediaCode=Number.isInteger(code)?code:0;
 const cls=classifyPlaybackFailure(mediaCode,online,format,src||'');
 const time=new Date().toLocaleString('ja-JP');
 $('playbackDiagnosticStatus').textContent=`最終診断：${time} ／ ${cls.kind}（MediaError ${mediaCode}） ／ 接続：${online?'オンライン':'オフライン'} ／ 形式：${format==='hls'?'HLS':'動画ファイル'}。${cls.detail} ${cls.hint} これだけでは配信側の制限理由を断定できません。再生URL全文・APIキーは診断文に記録しません。`;
 $('viewPlaybackDiagnostic').hidden=false;
 return cls;
}
function openApiSettings(){setView('settings');$('apiSettingsCard').scrollIntoView({block:'start'});$('javinfoKey').focus({preventScroll:true});}
function openPlaybackDiagnostics(){closeVideo().then(()=>{setView('settings');$('playbackDiagnosticsCard').scrollIntoView({block:'start'});}).catch(()=>{setView('settings');});}

async function initJavinfoKey(){
 try{const secret=await KeyVault.load(db);if(secret){$('javinfoKey').value=secret;$('javinfoKeyStatus').textContent='この端末に暗号化保存したAPIキーを読み込みました。共有端末では「保存を削除」を押してください。';}}
 catch{$('javinfoKeyStatus').textContent='保存したAPIキーを読み込めませんでした。入力し直してください。';}
}
async function saveJavinfoKey(){
 const key=javinfoCredentials();await KeyVault.save(db,key);
 $('javinfoKeyStatus').textContent='このiPhoneにAPIキーを暗号化保存しました。次回起動時も使用できます。バックアップ・同期の対象外です。';toast('APIキーを保存しました');
}
async function clearJavinfoKey(){
 await KeyVault.clear(db);$('javinfoKey').value='';
 $('javinfoKeyStatus').textContent='保存したAPIキーを削除しました。次回使用する場合は入力してください。';toast('APIキーを削除しました');
}
function renderJavinfoPages(){
 const bar=$('javinfoPages');bar.hidden=!javinfoTerm;
 $('javinfoPageLabel').textContent=`${javinfoPage}ページ`;
 $('javinfoPrev').disabled=javinfoBusy||javinfoPage<=1;
 $('javinfoNext').disabled=javinfoBusy||!javinfoMore||javinfoPage>=50;
}
async function saveJavinfoItem(info){
  const found=records.find(r=>r.provider===info.provider&&norm(r.code)===norm(info.code));
  if(found){
    const row={...found,title:found.title==='名称未設定'?info.title:found.title,
      performers:found.performers?.length?found.performers:info.performers,
      referenceURL:found.referenceURL||info.referenceURL,
      coverURL:found.coverURL||info.coverURL,publishedAt:found.publishedAt||info.publishedAt,
      duration:found.duration||info.duration||0};
    await store(row);return records.find(r=>r.id===found.id)||row;
  }
  // Preserve linked favorites and watched flags from a previously registered
  // source of the same DVD id without duplicating its playback-count statistics.
  const linked=records.find(r=>r.code&&norm(r.code)===norm(info.code));
  await store({...info,id:uid(),isFavorite:Boolean(linked?.isFavorite),isWatched:Boolean(linked?.isWatched),
    lastPosition:linked?.lastPosition||0,progressPercent:linked?.progressPercent||0});
  return records.find(r=>r.provider===info.provider&&norm(r.code)===norm(info.code));
}
function renderJavinfoResults(){
  const parent=$('javinfoResults');parent.replaceChildren();
  if(!javinfoResults.length)return;
  for(const entry of javinfoResults){
    const card=elem('article','live-result');
    const header=elem('div','live-result-heading');
    const meta=elem('div','live-info');
    meta.append(elem('strong','',entry.title),elem('small','',PROVIDERS[entry.provider]+' · '+(entry.code||'品番なし')));
    if(entry.performers?.length)meta.append(elem('small','',entry.performers.join('・')));
    if(entry.publishedAt)meta.append(elem('small','',entry.publishedAt));
    if(entry.coverURL && PeachCore.safeURL(entry.coverURL,'licensed')){
      const img=elem('img','javinfo-thumb');img.src=entry.coverURL;img.alt=entry.title+' のジャケット';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();header.append(img);
    }
    header.append(meta);card.append(header);
    const actions=elem('div','javinfo-result-actions');
    const save=elem('button','','作品を保存');
    save.onclick=async()=>{try{await saveJavinfoItem(entry);toast('ライブラリに保存しました');}
      catch(e){javinfoStatus('保存に失敗: '+e.message);}};actions.append(save);
    const fav=elem('button','','♡ お気に入り');
    fav.onclick=async()=>{try{const row=await saveJavinfoItem(entry);await syncGroupState(row,{isFavorite:true});toast('お気に入りに登録しました');}
      catch(e){javinfoStatus('お気に入り登録に失敗: '+e.message);}};actions.append(fav);
    const canHaveHls=['missav','sextb'].includes(entry.provider);
    const playBtn=elem('button','javinfo-play',canHaveHls?'▶ 再生':'作品詳細');
    playBtn.disabled=!entry.code;
    playBtn.onclick=()=>playJavinfoMovie(entry).catch(e=>javinfoStatus('再生準備に失敗: '+e.message));
    actions.append(playBtn);
    const original=originalWatchLink(entry,'↗ 元サイトで再生');if(original)actions.append(original);
    card.append(actions);parent.append(card);
  }
}
async function runJavinfoSearch(page=1){
  if(javinfoBusy)return;
  const key=javinfoCredentials(),term=Javinfo.queryText($('javinfoSearch').value);
  const provider=Javinfo.providerId($('javinfoProvider').value);
  if(term!==javinfoTerm||provider!==javinfoLastProvider)page=1;
  const target=Javinfo.pageNumber(page);
  javinfoBusy=true;$('javinfoSearchBtn').disabled=true;
  javinfoStatus(`${PROVIDERS[provider]}で検索中…（${target}ページ・APIへ1回リクエスト）`);
  try{
    const result=await Javinfo.search(term,key,{page:target,provider});
    javinfoResults=Javinfo.uniqueResults(result);javinfoPage=target;javinfoTerm=term;javinfoLastProvider=provider;
    javinfoMore=result.length>=javinfoPageSize;
    renderJavinfoResults();
    javinfoStatus(result.length?`${target}ページ：${javinfoResults.length}件を表示。次ページが存在する場合は下のボタンから移動できます。`:'このページに作品はありません。前のページへ戻るか検索語を変えてください。');
  }catch(e){javinfoStatus('検索できません：'+e.message);}
  finally{javinfoBusy=false;$('javinfoSearchBtn').disabled=false;renderJavinfoPages();}
}
async function playJavinfoMovie(item){
  if(javinfoBusy)return;
   const key=javinfoCredentials();
  const code=Javinfo.dvdCode(item.code);
  javinfoBusy=true;$('javinfoSearchBtn').disabled=true;
  javinfoStatus(`${code} の詳細と再生URLを確認中…（APIへ1回リクエスト）`);
  toast('再生URLを取得中…');
  try{
    const provider=Javinfo.providerId(item.provider||$('javinfoProvider').value);
    const detail=await Javinfo.movie(code,key,{provider});
    if(!detail){javinfoStatus('作品詳細がありません');toast('作品詳細を取得できませんでした');return;}
    const row=await saveJavinfoItem({...item,...detail.metadata,
      // Keep a known permitted watch-page URL for fallback even if the detail API omits one.
      referenceURL:detail.metadata.referenceURL||item.referenceURL||''});
    if(!detail.hls){
      javinfoStatus(`${code}: ${PROVIDERS[provider]}から再生用HLSが提供されていません。作品情報は保存しました。`);
      toast('この作品には再生用HLSがありません。元サイトを確認してください');
      return;
    }
    // A URL in API metadata alone is not proof of unrestricted access. We make
    // Native Safari HLS: try the API's master first, then its distinct
    // variants only if the current candidate fails before actual playback.
    play(row,detail.hls,{hlsCandidates:detail.hlsCandidates,hlsCandidateKinds:detail.hlsCandidateKinds});
    javinfoStatus(`${code}: ${PROVIDERS[provider]}のHLS候補の再生を試行中。実際の再生開始を確認した場合だけ履歴に記録します。`);
  }finally{javinfoBusy=false;$('javinfoSearchBtn').disabled=false;}
}
// Expiring/signed stream URLs carry their credentials in parameter names or
// path segments. Plain query params like ?quality=720p are NOT treated as expiring.
const EPHEMERAL_URL_PARAMS=new Set(['token','access_token','auth_token','expires','expiry','exp','signature','sig','auth','deadline','validuntil','valid_until','policy','key-pair-id','x-amz-expires','x-amz-signature','x-amz-credential','x-amz-security-token','x-amz-date','x-goog-expires','x-goog-signature']);
function looksEphemeralURL(raw){
  try{
    const u=new URL(raw);
    for(const name of u.searchParams.keys()){
      const n=name.toLowerCase();
      if(EPHEMERAL_URL_PARAMS.has(n)||n.includes('token')||n.includes('expir'))return true;
    }
    return /(^|\/)(token|expire[sd]?|signed|auth)(s|d)?(\/|$)/i.test(u.pathname);
  }catch{return false;}
}
function formatSupportNote(raw){
  try{
    const path=new URL(raw).pathname.toLowerCase();
    if(/\.m3u8$/.test(path))return ''; // iOS Safari (WebKit) plays HLS natively
    const probe=document.createElement('video');
    const type=/\.webm$/.test(path)?'video/webm':/\.mov$/.test(path)?'video/quicktime':'video/mp4';
    return probe.canPlayType(type)?'':'このiPhoneでは再生できない形式の可能性があります';
  }catch{return '';}
}
async function allowMediaOrigin(raw){
  let origin='';
  try{origin=new URL(raw).origin;}catch{return '';}
  if(!/^https:\/\/[^/]+$/.test(origin))return '';
  if(!liveSettings.mediaOrigins.includes(origin)){
    const next=[...liveSettings.mediaOrigins,origin];
    if(next.length>15)throw Error('再生許可オリジンが15個の上限を超えています。設定画面で整理してください');
    liveSettings={...liveSettings,mediaOrigins:next};
    await writeMeta('liveCatalogSettings',liveSettings);
    if($('allowedMediaOrigins'))$('allowedMediaOrigins').value=next.join('\n');
  }
  return origin;
}
// Stream-URL integrity: detect, never silently delete. Records whose provider
// is not "licensed" but carry stream data are classified by positive evidence:
//  - "broken":   playbackURL exists but its origin is not allowlisted (or the
//                URL is invalid) -> cannot play in-app, safe repair candidate.
//  - "flagonly": rightsConfirmed is set but there is no playbackURL at all.
//  - "ambiguous": playbackURL exists and its origin IS allowlisted. This may be
//                legitimate catalog data, so it is only listed for manual review
//                and never auto-flagged as broken.
function streamIssueKind(r){
  const url=(r.playbackURL||'').trim();
  if(url){
    let origin='';
    try{origin=new URL(url).origin;}catch{}
    if(origin&&liveSettings.mediaOrigins.includes(origin))return 'ambiguous';
    return 'broken';
  }
  return r.rightsConfirmed===true?'flagonly':'';
}
function suspectStreamRecords(){
  return records.filter(r=>r.provider!=='licensed'&&streamIssueKind(r));
}
async function notifyRestoredStreamIssues(){
 try{await writeMeta('streamIssueNoticeV1',null);await notifyStreamIssuesOnce();}catch(e){console.warn('restored-stream diagnostic notice skipped',e);}
}
async function notifyStreamIssuesOnce(){
  if(await readMeta('streamIssueNoticeV1'))return 0;
  const rows=suspectStreamRecords();
  await writeMeta('streamIssueNoticeV1',new Date().toISOString());
  if(rows.length>0)toast(`再生URLの不整合候補が${rows.length}件あります。設定→「不整合チェック」で確認できます`);
  return rows.length;
}
function renderStreamIntegrity(){
  const box=$('streamIntegrityResults');if(!box)return;box.replaceChildren();
  const rows=suspectStreamRecords();
  if(!rows.length){box.append(elem('p','note','不整合の疑いがある作品はありません。'));return;}
  const groups={broken:[],flagonly:[],ambiguous:[]};
  for(const r of rows)groups[streamIssueKind(r)].push(r);
  const desc={
    broken:'【修復推奨】再生できないURL（配信元が許可リストにない等）',
    flagonly:'【修復推奨】再生URLがないのに再生許可フラグだけ残っています',
    ambiguous:'【要確認】正常なカタログデータの可能性もあるため自動判定しません。心当たりのないものだけクリアしてください'
  };
  for(const key of ['broken','flagonly','ambiguous']){
    const list=groups[key];
    if(!list.length)continue;
    box.append(elem('p','note',`${desc[key]}：${list.length}件`));
    for(const r of list){
      const label=elem('label','javinfo-consent');
      const cb=document.createElement('input');cb.type='checkbox';cb.checked=false;cb.dataset.id=r.id;
      label.append(cb);
      let origin='';
      try{origin=new URL(r.playbackURL).origin;}catch{}
      label.append(elem('span','',`${r.title||'名称未設定'}（${PROVIDERS[r.provider]||r.provider}${origin?'・'+origin:''}）`));
      box.append(label);
    }
  }
  box.append(elem('p','note','安全のため全候補は未選択です。確認した項目だけ選び、明示的に削除してください。'));
  const clear=elem('button','','選択した作品の再生URLをクリア');
  clear.addEventListener('click',async()=>{
    const ids=[...box.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.dataset.id);
    if(!ids.length){toast('選択されていません');return;}
    if(!confirm(`${ids.length}件の再生URLと再生許可をクリアします。よろしいですか？`))return;
    const next=records.map(x=>ids.includes(x.id)?{...x,playbackURL:'',rightsConfirmed:false}:x);
    await writeAll(next);await reload();renderStreamIntegrity();
    toast(`${ids.length}件の再生URLをクリアしました`);
  });
  box.append(clear);
}
// 再生エラー後の通信診断。HTTP応答ヘッダーだけを確認し、本体は取得しない。
// JavaScriptのCORS可否とSafariのネイティブHLS再生可否を混同しない。
async function diagnoseStreamURL(raw,options={}){
 return StreamDiagnostics.probe(raw,options);
}
async function playManualStream(){
   const url=Javinfo.directMediaURL($('manualStreamURL').value);
  if(!url)throw Error('HTTPSの直接動画URL（MP4・MOV・WebM・m3u8）を指定してください。サイトのページURLは利用できません。');
  const title=clean($('manualStreamTitle').value,200)||'許可済みストリーム';
  const code=clean($('manualStreamCode').value,64);
  const key=norm(code);
  let item=key?records.find(r=>r.provider==='licensed'&&norm(r.code)===key):null;
  if(!item){const next=canonical({id:uid(),title,code,provider:'licensed',hasLocalCopy:false},uid);await store(next);item=records.find(r=>r.id===next.id)||next;}
  if($('manualStreamSave')?.checked){
    try{
      await allowMediaOrigin(url);
      await store({...item,playbackURL:url,rightsConfirmed:true});
      item=records.find(r=>r.id===item.id)||item;
      let note='URLを保存しました。次回以降はライブラリの「▶ アプリ内で再生」から再生できます。';
      if(looksEphemeralURL(url))note+=' URLに有効期限が含まれている可能性があるため、期限切れの場合は再登録してください。';
      const fmt=formatSupportNote(url);
      if(fmt)note+=' '+fmt+'。';
      $('manualStreamStatus').textContent=note;
      toast('動画URLをライブラリに保存しました');
    }catch(e){toast('URL保存に失敗: '+e.message);}
  }else{
    // The media URL is intentionally ephemeral (signed links might include secrets).
    // Never put the URL in IndexedDB, backups or sync data.
    $('manualStreamStatus').textContent='再生を試しています。再生開始した場合にのみ履歴を記録。URL自体は保存しません。';
  }
  play(item,url);
}
function renderCatalogStatus(){
 $('offlineCatalogStatus').textContent=`端末内カタログ ${offlineCatalogRows.length} 件（動画本体なし・再生許可なし）`;
}
async function initOfflineCatalog(){
 const raw=await readMeta('offlineCatalogRows');
 offlineCatalogRows=Array.isArray(raw)?CatalogImport.merge([],raw):[];
 renderCatalogStatus();
}
async function importOfflineCatalog(file){
 if(!file||file.size>CatalogImport.MAX_FILE_BYTES)throw Error('2MB以下のJSONファイルを選択してください');
 const parsed=CatalogImport.parse(JSON.parse(await file.text()),liveSettings.coverOrigins);
 if(!parsed.length)throw Error('登録できる作品情報がありません');
 const next=CatalogImport.merge(offlineCatalogRows,parsed);
 if(!confirm(`作品情報 ${parsed.length}件を読み込み、端末内カタログを合計${next.length}件にします。既存ライブラリと動画は変更しません。続けますか？`))return;
 await writeMeta('offlineCatalogRows',next);
 offlineCatalogRows=next;renderCatalogStatus();
 toast(`作品情報を${parsed.length}件取り込みました`);
 if($('search').value.trim().length>=2)await runLiveSearch(null,{quiet:false});
}
async function saveMissavCompatibility(payload){
 const parsed=MissavCompat.parse(payload,liveSettings.coverOrigins);
 const merged=CatalogImport.merge(offlineCatalogRows,parsed);
 if(!confirm(`MISSAV作品情報 ${parsed.length}件を追加します。端末内カタログ合計${merged.length}件。保存動画・お気に入り・視聴履歴は変更しません。続けますか？`))return 0;
 await writeMeta('offlineCatalogRows',merged);
 offlineCatalogRows=merged;
 renderCatalogStatus();renderLiveGroups();
 $('missavCompatStatus').textContent=`MISSAV作品情報${parsed.length}件を取り込みました。端末内カタログ合計${merged.length}件。`;
 toast(`MISSAV作品情報${parsed.length}件を登録しました`);
 if($('search').value.trim().length>=2)await runLiveSearch(null,{quiet:false});
 return parsed.length;
}
async function importMissavFile(file){
 if(!file||file.size>MissavCompat.MAX_BYTES)throw Error('2MB以下のJSONファイルを選択してください');
 return saveMissavCompatibility(JSON.parse(await file.text()));
}
async function fetchMissavCompatibility(){
 const button=$('missavCompatFetchBtn');button.disabled=true;
 const label=$('missavCompatStatus');label.textContent='HTTPS APIへ接続しています…';
 try{
  // auth-key is read only at invocation time. Never persist this secret in IndexedDB.
  const data=await MissavCompat.request($('missavCompatAPI').value,{authKey:$('missavCompatAuth').value});
  await saveMissavCompatibility(data);
 }catch(err){label.textContent=`取得できません: ${err.message}。CORS・アクセス権限・JSON形式を確認してください。`;}
 finally{$('missavCompatAuth').value='';button.disabled=false;}
}
async function inspectLibrary(){
 const [media,thumbs]=await Promise.all([Media.mediaMetadata(db),Media.thumbnailKeys(db)]);
 healthReport=Health.inspect(records,media,thumbs);
 const h=healthReport;
 $('healthStatus').textContent=`作品${h.totalItems}件 / 保存動画${h.totalMedia}件 / 約${Media.prettyBytes(h.bytes)}。保存情報の不一致 ${h.patches.length}件、参照のない動画 ${h.orphans.length}件、参照のない画像 ${h.orphanThumbnails.length}件。診断では削除しません。`;
 $('repairCopiesBtn').hidden=!h.patches.length;
 return h;
}
async function repairCopies(){
 const report=await inspectLibrary();
 if(!report.patches.length){toast('修復する不一致はありません');return;}
 if(!confirm(`保存済み表示の不一致${report.patches.length}件を修復しますか？動画・作品情報の削除は行いません。`))return;
 // Re-read before writing; never overwrite unrelated fields with stale UI state.
 const latest=await readAll();
 const media=await Media.mediaMetadata(db);
 const fresh=Health.inspect(latest,media);
 await writeAll(Health.repaired(latest,fresh));
 await reload();await inspectLibrary();toast('保存済み表示のみ修復しました');
}
async function initLiveSettings(){
 const stored=await readMeta('liveCatalogSettings');
 if(stored&&typeof stored==='object'){
  for(const provider of Live.IDS){
   const endpoint=Live.endpointURL(stored.api?.[provider]);
   if(endpoint)liveSettings.api[provider]=endpoint.href;
  }
  try{liveSettings.mediaOrigins=Live.parseOrigins((stored.mediaOrigins||[]).join(' '));}catch{}
  try{liveSettings.coverOrigins=Live.parseOrigins((stored.coverOrigins||[]).join(' '));}catch{}
  liveSettings.autoSearch=stored.autoSearch!==false;
 }
 for(const provider of Live.IDS){$('api'+provider[0].toUpperCase()+provider.slice(1)).value=liveSettings.api[provider];}
 $('allowedMediaOrigins').value=liveSettings.mediaOrigins.join('\n');
 $('allowedCoverOrigins').value=liveSettings.coverOrigins.join('\n');
 $('autoLiveSearch').checked=liveSettings.autoSearch;
 renderSiteLinks();
}
function renderSiteLinks(){
 const wrap=$('liveSiteLinks');if(!wrap)return;wrap.replaceChildren();
 const q=$('search').value.trim();
 for(const provider of Live.IDS){
  const deep=Live.supportsDeepSearch(provider);
  const a=elem('a','',deep?PROVIDERS[provider]:`${PROVIDERS[provider]}（サイト内検索）`);
  a.href=q?Live.siteSearchURL(provider,q):Live.siteHomepage(provider);
  a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';
  a.title=deep?`${PROVIDERS[provider]}の外部検索ページを開く`:`${PROVIDERS[provider]}の日本語トップを開き、サイト内の検索欄を使う`;
  wrap.append(a);
  if(!deep && q){
   const copy=elem('button','site-copy','検索語をコピー');copy.type='button';copy.title='検索語をコピーして85roのサイト内検索欄に貼り付ける';
   copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(q);toast('検索語をコピーしました。85roで貼り付けて検索してください');}catch{toast('検索語のコピーに失敗しました。入力欄の文字列を手動コピーしてください');}});
   wrap.append(copy);
  }
 }
}
function imageFor(url,alt){
 if(!url || !PeachCore.safeURL(url,'licensed'))return null;
 const img=elem('img','cover-image');img.src=url;img.alt=alt||'作品ジャケット';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();return img;
}
async function syncGroupState(record,patch){
 const rows=Catalog.linkedStateUpdates(record,records,patch);
 if(!rows.length)return;await writeAll(rows);await reload();
}
async function saveCatalogRow(result){
 const saved=Catalog.mergeWithExisting(result,records,uid);
 await store(saved);
 return records.find(r=>r.id===saved.id)||saved;
}
function renderLiveGroup(group){
 const card=elem('article','live-result');
 const hdr=elem('div','live-result-heading');
 const img=imageFor(group.coverURL,group.title);if(img)hdr.append(img);
 const info=elem('div','live-info');info.append(elem('strong','',group.title),elem('small','',`${group.code||'品番なし'} · ${group.performers.join('・')||'出演者不明'}`));
 if(group.publishedAt)info.append(elem('small','',`公開情報: ${group.publishedAt}`));
 hdr.append(info);card.append(hdr);
 const tags=elem('div','live-tags');for(const source of group.sources){
  const tag=elem('span','source-tag',PROVIDERS[source.provider]);tags.append(tag);
 }
 if(group.saved.length)tags.append(elem('span','source-tag','ライブラリ登録済み'));
 if(group.isFavorite)tags.append(elem('span','source-tag','♥ お気に入り'));
 card.append(tags);
 const actions=elem('div','live-result-actions');
 const register=elem('button','','作品情報を保存');register.onclick=async()=>{
  try{for(const source of group.sources)await saveCatalogRow(source);toast('登録元を保持し、既存の視聴履歴を引き継ぎました');renderLiveGroups();}
  catch(e){toast('登録エラー: '+e.message);}
 };actions.append(register);
 const fav=elem('button','',group.isFavorite?'♥ お気に入り解除':'♡ お気に入り');fav.onclick=async()=>{
  try{const row=group.saved[0]||await saveCatalogRow(group.sources[0]);await syncGroupState(row,{isFavorite:!group.isFavorite});renderLiveGroups();}
  catch(e){toast('更新できません: '+e.message);}
 };actions.append(fav);
 if(group.playable){
  const playButton=elem('button','licensed-play','▶ ここで再生');
  playButton.onclick=async()=>{
   const url=Catalog.safePlayable(group.playable,liveSettings.mediaOrigins);
   if(!url){toast('配信元の許可設定が無効です');return;}
   try{const row=await saveCatalogRow(group.playable);play(row,url);renderLiveGroups();}
   catch(e){toast('再生を開始できません: '+e.message);}
  };actions.append(playButton);
 } else if(group.embedPlayable){
  const embedButton=elem('button','licensed-play','▶ 許可済み埋め込み');
  embedButton.onclick=async()=>{
   const url=Catalog.safeEmbed(group.embedPlayable,liveSettings.mediaOrigins);
   if(!url){toast('埋め込みの権限確認または配信元設定がありません');return;}
   try{const row=await saveCatalogRow(group.embedPlayable);playEmbedded(row,url);renderLiveGroups();}
   catch(e){toast('埋め込み再生を開始できません: '+e.message);}
  };actions.append(embedButton);
 } else actions.append(elem('small','','直接再生：提供元の埋め込み・配信許可が必要'));
 card.append(actions);
 const links=elem('div','live-result-actions');for(const source of group.sources){
  if(!source.referenceURL)continue;
  const a=elem('a','',`${PROVIDERS[source.provider]}の元ページ（開いた履歴に記録）`);a.href=source.referenceURL;a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';
  a.addEventListener('click',()=>{void markExternalOpen(source).catch(e=>toast('履歴の保存に失敗: '+e.message));});links.append(a);
 }card.append(links);return card;
}
function renderLiveGroups(){
 const box=$('liveResults');box.replaceChildren();
 const groups=Catalog.aggregate([...liveCatalogRows,...CatalogImport.search(offlineCatalogRows,$('search').value)],records);
 for(const group of groups)box.append(renderLiveGroup(group));
 if(!groups.length)box.append(elem('p','note','一致作品なし。利用可能な検索APIがない場合は外部検索リンクを利用してください。'));
 $('liveCount').textContent=`統合作品 ${groups.length} 件 / 登録元 ${liveCatalogRows.length} 件`;
 return groups;
}
async function harvestCatalog(){
 if(harvestBusy)return;
 const sources=Live.IDS.filter(p=>liveSettings.api[p]);
 if(!sources.length){toast('無設定での外部サイト全件取得には対応していません。許可済みのカタログAPIが必要です');return;}
 if(!confirm(`権限のあるカタログAPI ${sources.length}件を順次照会します。最大各10ページ・端末内保存は合計400件まで。動画本体は取得しません。続けますか？`))return;
 harvestBusy=true;$('harvestBtn').disabled=true;
 const progress=$('harvestStatus');let merged=offlineCatalogRows.slice(),done=0,errors=[];
 try{
  for(const provider of sources){
   if(merged.length>=CatalogImport.MAX_ROWS){errors.push('保存上限400件に到達');break;}
   progress.textContent=`${PROVIDERS[provider]}を取得中（${done+1}/${sources.length}）…`;
   try{
    const result=await Harvest.scan(provider,liveSettings.api[provider],{
     allowedOrigins:liveSettings.mediaOrigins,coverOrigins:liveSettings.coverOrigins,
     onPage:({page,total})=>{progress.textContent=`${PROVIDERS[provider]}：${page}ページ取得、${total}件（保存上限400件）`;}
    });
    // A fetched API response is not automatically a trustworthy reusable license.
    const sanitized=result.rows.map(r=>({...r,playbackURL:'',embedURL:'',rightsConfirmed:false}));
    let added=0;
    for(const r of sanitized){
     try{merged=CatalogImport.merge(merged,[r]);added++;}
     catch(e){if(merged.length>=CatalogImport.MAX_ROWS){errors.push('保存上限400件に到達');break;}throw e;}
    }
    done++;if(result.incomplete)errors.push(`${PROVIDERS[provider]}：続きのページあり（取得上限）`);
    progress.textContent=`${PROVIDERS[provider]}：${added}件確認、端末内${merged.length}件`;
   }catch(e){errors.push(`${PROVIDERS[provider]}：${e.message}`);}
  }
  await writeMeta('offlineCatalogRows',merged);offlineCatalogRows=merged;
  renderCatalogStatus();renderLiveGroups();
  progress.textContent=`取得完了：${done}/${sources.length}提供元、端末内${merged.length}件。${errors.length?errors.join(' / '):'上限内で正常終了'}。これは外部サイト全作品の取得保証ではありません。`;
 }finally{harvestBusy=false;$('harvestBtn').disabled=false;}
}
async function runLiveSearch(queryOverride=null,{quiet=false}={}){
 const q=typeof queryOverride==='string'?queryOverride.trim():$('search').value.trim();
 if(q.length<2){if(!quiet)toast('検索語は2文字以上入力してください');return [];} // no automatic empty-term harvest
 const button=$('liveSearchBtn'),status=$('liveStatus');
 const providers=Live.IDS.filter(p=>liveSettings.api[p]);
 if(!providers.length){
   if(!quiet){liveCatalogRows=[];const groups=renderLiveGroups();status.textContent=`取込済み作品情報から${groups.length}件を表示。ライブ検索APIは未設定です。`;}
   return CatalogImport.search(offlineCatalogRows,q);
 }
 const run=++liveSearchRun;button.disabled=true;if(!quiet)status.textContent=`${providers.length}件の許可済みカタログを照会中…`;
 try{
  const outcomes=await Promise.all(providers.map(async provider=>{
   try{return {provider,rows:await Live.search(provider,q,liveSettings.api[provider],liveSettings.mediaOrigins,fetch,liveSettings.coverOrigins)};}
   catch(err){return {provider,error:err.message};}
  }));
  if(run!==liveSearchRun)return [];
  const rows=outcomes.flatMap(x=>x.rows||[]);
  const errors=outcomes.filter(x=>x.error).map(x=>`${PROVIDERS[x.provider]}: ${x.error}`);
  if(!quiet){liveCatalogRows=rows;const groups=renderLiveGroups();status.textContent=`${groups.length}作品を統合（ライブ・端末取込）${errors.length?' / 接続失敗: '+errors.join(' | '):''}。未認可のサイトからの自動取得は行いません。`;}
  return rows;
 }finally{if(run===liveSearchRun)button.disabled=false;}
}
function scheduleAutoSearch(){
 clearTimeout(autoSearchTimer);
 if(!liveSettings.autoSearch||(!Live.IDS.some(x=>liveSettings.api[x])&&!offlineCatalogRows.length))return;
 if($('search').value.trim().length<2)return;
 autoSearchTimer=setTimeout(()=>runLiveSearch(null).catch(e=>toast('自動検索エラー: '+e.message)),750);
}
async function checkFollowedReleases(){
 if(followCheckBusy)return;
 const providers=Live.IDS.filter(p=>liveSettings.api[p]);
 if(!providers.length){toast('新着チェックには許可済みの検索APIが必要です');return;}
 const follows=followNames.slice(0,10);if(!follows.length){toast('先に出演者をフォローしてください');return;}
 followCheckBusy=true;$('checkFollows').disabled=true;
 try{
  const rows=[];let errors=0;
  for(const term of follows){
   for(const p of providers){try{rows.push(...await Live.search(p,term,liveSettings.api[p],liveSettings.mediaOrigins,fetch,liveSettings.coverOrigins));}catch{errors++;}}
  }
  const groups=Catalog.aggregate(rows,records),seen=await readMeta('seenFollows');
  const fresh=Catalog.newFollowed(groups,follows,Array.isArray(seen)?seen:[]);
  const summary=$('followNewResults');summary.replaceChildren();
  for(const g of fresh.slice(0,25))summary.append(renderLiveGroup(g));
  if(!fresh.length)summary.append(elem('p','note','新着候補は見つかりませんでした。'));
  await writeMeta('seenFollows',[...new Set([...(Array.isArray(seen)?seen:[]),...groups.map(g=>g.key)])].slice(-2500));
  $('followStatus').textContent=`新着候補 ${fresh.length}件 / 検索 ${follows.length}人 / エラー ${errors}件（取得先の公開日・更新内容を確認してください）`;
 }catch(e){toast('新着チェックに失敗: '+e.message);}
 finally{followCheckBusy=false;$('checkFollows').disabled=false;}
}
async function saveLiveSettings(){
 const api={};
 for(const p of Live.IDS){
  const raw=$('api'+p[0].toUpperCase()+p.slice(1)).value.trim();
  if(raw&&!Live.endpointURL(raw)){toast(`${PROVIDERS[p]}のAPIは秘密鍵のない公開HTTPS URLだけ使用できます`);return;}
  api[p]=raw?Live.endpointURL(raw).href:'';
 }
 let mediaOrigins;
 try{mediaOrigins=Live.parseOrigins($('allowedMediaOrigins').value);}catch(err){toast(err.message);return;}
 let coverOrigins;try{coverOrigins=Live.parseOrigins($('allowedCoverOrigins').value);}catch(err){toast(err.message);return;}
 const next={api,mediaOrigins,coverOrigins,autoSearch:$('autoLiveSearch').checked};await writeMeta('liveCatalogSettings',next);liveSettings=next;
 scheduleAutoSearch();
 toast('設定を端末内に保存しました。APIの利用許諾・CORS対応は別途必要です');
}
async function initDevice(){
  installation=await readMeta('installation');
  if(!installation){installation={id:uid(),label:'自分のiPhone',createdAt:new Date().toISOString()};await writeMeta('installation',installation);}
  $('deviceLabel').value=installation.label;
  $('deviceId').textContent=`この端末のID: ${installation.id.slice(0,8)}（他の端末とは同期されません）`;
  followNames=await readMeta('follows')||[];
  await updateBackupStatus();
}
async function updateBackupStatus(){
  const last=await readMeta('lastBackup');
  $('backupStatus').textContent=last?`最後のバックアップ: ${new Date(last).toLocaleString('ja-JP')}（動画は含まれません）`:'まだバックアップがありません。定期的に保存してください。';
}
function download(blob,filename){const url=URL.createObjectURL(blob),a=elem('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
function backupPassword(){return $('backupPassword').value;}
async function exportEncrypted(){
  const password=backupPassword();if(!passOK(password)){toast('合言葉は12文字以上にしてください');return;}
  const btn=$('exportBtn');btn.disabled=true;
  try {
    const data={schemaVersion:2,exportedAt:new Date().toISOString(),sourceDevice:installation?.label||'',items:records.map(r=>({...r,hasLocalCopy:false}))};
    const sealed=await encrypt(data,password);
    const now=new Date().toISOString().slice(0,10);
    download(new Blob([JSON.stringify(sealed)],{type:'application/json'}),`peach-pocket-encrypted-${now}.json`);
    await writeMeta('lastBackup',new Date().toISOString());await updateBackupStatus();
    toast('暗号化バックアップを保存しました。合言葉とJSONファイルを保管してください');
  }catch(e){toast(`保存エラー: ${e.message}`);}finally{btn.disabled=false;$('backupPassword').value='';}
}
// Full archive is local-only and encrypted; the existing JSON backup remains available.
async function exportFullBackup(){
 const password=backupPassword();if(!passOK(password))throw Error('設定画面のバックアップ合言葉を12文字以上で入力してください');
 const btn=$('fullExportBtn');btn.disabled=true;
 const label=$('fullBackupStatus');label.textContent='動画・画像を確認中…';
 try{
  const assets=[];
  for(const id of await Media.keys(db)){
   const item=await Media.get(db,id);
   if(item?.blob)assets.push({type:'media',id,name:item.name||'video',blob:item.blob});
  }
  for(const id of await Media.thumbnailKeys(db)){
   const row=await Media.getThumbnail(db,id);
   if(row?.blob)assets.push({type:'thumbnail',id,blob:row.blob,name:'thumbnail.jpg'});
  }
  const bytes=assets.reduce((n,a)=>n+a.blob.size,0);
  if(!confirm(`保存動画・画像 ${assets.length}ファイル／${Media.prettyBytes(bytes)}を暗号化して出力します。iPhoneの空き容量が不足すると失敗する場合があります。続けますか？`))return;
  const archive=await FullBackup.create({items:await readAll(),assets,meta:{follows:followNames,offlineCatalogRows,liveCatalogSettings:await readMeta('liveCatalogSettings')}},password,(done,total)=>{label.textContent=`暗号化しています ${Media.prettyBytes(done)} / ${Media.prettyBytes(total)}`;});
  download(archive,`momoiki-backup-${new Date().toISOString().slice(0,10)}.momobak`);
  await writeMeta('lastFullBackup',new Date().toISOString());
  label.textContent=`完全バックアップ作成：作品${records.length}件、保存ファイル${assets.length}件、合計${Media.prettyBytes(archive.size)}。ファイルが「ファイル」に保存されたことを確認してください。`;
 }finally{btn.disabled=false;$('backupPassword').value='';}
}
async function importFullBackup(file){
 const password=backupPassword();if(!passOK(password))throw Error('設定画面のバックアップ合言葉を12文字以上で入力してください');
 const btn=$('fullImportBtn');btn.disabled=true;const label=$('fullBackupStatus');
 try{
  const restored=await FullBackup.parse(file,password,(done,total)=>{label.textContent=`復号・検査中 ${Media.prettyBytes(done)} / ${Media.prettyBytes(total)} （まだデータ変更はありません）`;});
  const originals=await readAll(),mediaKeys=new Set(await Media.keys(db)),thumbKeys=new Set(await Media.thumbnailKeys(db));
  const mediaFromArchive=new Set(restored.assets.filter(a=>a.type==='media').map(a=>a.id));
  const updated=CloudSync.merge(originals,restored.items.map(row=>canonical(row,uid)));
  for(const row of updated){row.hasLocalCopy=mediaKeys.has(row.id)||mediaFromArchive.has(row.id);}
  if(!confirm(`作品 ${restored.items.length}件・動画 ${mediaFromArchive.size}件を復元します。既存の作品と動画は消さず、同じIDの保存済み動画も上書きしません。続けますか？`))return;
  // One transaction: any quota/validation failure aborts the entire restoration.
  await new Promise((resolve,reject)=>{
   let tx;try{
    tx=db.transaction(['items','media','thumbnails','meta'],'readwrite');
    const itemStore=tx.objectStore('items'),mediaStore=tx.objectStore('media'),thumbStore=tx.objectStore('thumbnails'),metaStore=tx.objectStore('meta');
    for(const row of updated)itemStore.put(canonical(row,uid));
    for(const a of restored.assets){
     if(a.type==='media'&&!mediaKeys.has(a.id))mediaStore.put({id:a.id,blob:a.blob,name:a.name||'video',size:a.blob.size,type:a.blob.type,storedAt:new Date().toISOString()});
     if(a.type==='thumbnail'&&!thumbKeys.has(a.id))thumbStore.put({id:a.id,blob:a.blob,createdAt:new Date().toISOString()});
    }
    const follows=[...new Set([...followNames,...(Array.isArray(restored.meta?.follows)?restored.meta.follows:[])])].filter(x=>typeof x==='string').slice(0,100);
    metaStore.put({key:'follows',value:follows});
    // User-supplied allowlisted catalog endpoints only; keep this device's settings if already configured.
    if(restored.meta?.liveCatalogSettings && !Object.keys(liveSettings.api).some(k=>liveSettings.api[k])){
     metaStore.put({key:'liveCatalogSettings',value:restored.meta.liveCatalogSettings});
    }
    // Never replace existing catalog: merge only if valid, otherwise keep current list.
    if(Array.isArray(restored.meta?.offlineCatalogRows)){
     try{metaStore.put({key:'offlineCatalogRows',value:CatalogImport.merge(offlineCatalogRows,restored.meta.offlineCatalogRows)});}catch{}
    }
   }catch(e){try{tx?.abort();}catch{}reject(e);return;}
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||Error('保存領域の容量が足りません'));tx.onabort=()=>reject(tx.error||Error('復元が中断されました。元データは変更されていません'));
  });
  followNames=await readMeta('follows')||[];await initOfflineCatalog();await initLiveSettings();await reload();
  label.textContent=`復元成功：作品${restored.items.length}件、保存動画${mediaFromArchive.size}件。動画を再選択せず再生できるか確認してください。`;
  await notifyRestoredStreamIssues();
 }finally{btn.disabled=false;$('backupPassword').value='';}
}
async function performCloudSync(){
 if(!cloudSession||cloudBusy||document.hidden)return;
 cloudBusy=true;const status=$('syncStatus');status.textContent='暗号化した作品情報を同期中…';
 try{
  const current=await readAll();
  const synced=await CloudSync.exchange({
   ...cloudSession,local:{items:current,follows:followNames},encrypt,decrypt
  });
  const localNow=await readAll();
  const merged=CloudSync.merge(localNow,synced.items.map(x=>canonical(x,uid)));
  await writeAll(merged);
  followNames=[...new Set([...followNames,...synced.follows])].slice(0,100);
  await writeMeta('follows',followNames);await reload();
  status.textContent=`同期成功：${new Date().toLocaleTimeString('ja-JP')}、作品${merged.length}件。動画本体は同期対象外です。`;
 }catch(e){status.textContent=`同期失敗：${e.message}`;}
 finally{cloudBusy=false;}
}
async function startCloudSync(){
 const endpoint=CloudSync.validEndpoint($('syncEndpoint').value.trim());
 if(!endpoint)throw Error('WebDAVのHTTPSファイルURLが不正です');
 if(!passOK($('syncPassphrase').value))throw Error('同期用の暗号化合言葉を12文字以上で入力してください');
 if(!$('syncUser').value||!$('syncPassword').value)throw Error('WebDAVのログイン情報を入力してください');
 cloudSession={endpoint,user:$('syncUser').value,password:$('syncPassword').value,passphrase:$('syncPassphrase').value};
 await writeMeta('cloudSyncEndpoint',endpoint); // Save URL only, never password/credentials.
 $('syncUser').value='';$('syncPassword').value='';$('syncPassphrase').value='';
 await performCloudSync();
}
function readAll(){return new Promise((resolve,reject)=>{const req=db.transaction('items').objectStore('items').getAll();req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
function writeAll(next){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite'),store=tx.objectStore('items');for(const item of next)store.put(item);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function saveOne(item){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite');tx.objectStore('items').put(item);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function deleteOne(id){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite');tx.objectStore('items').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function reload(){records=(await readAll()).map(row=>canonical(row,uid)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));render();}
async function store(item){const r=canonical({...item,updatedAt:new Date().toISOString()},uid);await saveOne(r);await reload();}
// A first-party watch page is an external visit, never a verified playback.
// This link is created synchronously from a user gesture: Safari may block
// a window opened only after async IndexedDB work.
function originalWatchLink(source,label='↗ 元サイトで再生'){
  const url=safeURL(source?.referenceURL,source?.provider);
  if(!url)return null; // Never synthesize a player URL or guess an embed path.
  const link=elem('a','original-watch-link',label);
  link.href=url;link.target='_blank';link.rel='noopener noreferrer';
  link.referrerPolicy='no-referrer';
  link.addEventListener('click',()=>{
    void markExternalOpen(source).catch(()=>toast('外部訪問履歴を保存できませんでした'));
  });
  return link;
}
// Never count external page navigation as a confirmed playback or watched time.
async function markExternalOpen(source){
 const url=safeURL(source.referenceURL,source.provider);if(!url)throw Error('有効な参照URLがありません');
 const found=records.find(r=>r.provider===source.provider&&r.referenceURL===url);
 const row=found||Catalog.mergeWithExisting(source,records,uid);
 await store(External.markOpened({...row,referenceURL:url}));
}
async function saveManualExternal(ev){
 ev.preventDefault();const urlRaw=$('externalURL').value.trim();const provider=External.providerFromURL(urlRaw),url=safeURL(urlRaw,provider);
 if(!url){toast('公開HTTPSの作品ページURLを入力してください');return;}
 const found=records.find(r=>r.provider===provider&&r.referenceURL===url);
 const title=clean($('externalTitle').value,300)||External.suggestedTitle(url);
 const code=clean($('externalCode').value,64);
 const row=found?{...found,title:found.title==='名称未設定'?title:found.title,code:found.code||code}:
    {id:uid(),provider,referenceURL:url,title,code,isFavorite:$('externalFavorite').checked};
 await store(row);$('externalQuickForm').reset();$('externalQuickPanel').open=false;
 toast(found?'登録済みリンクを確認しました':'外部作品を登録しました。カードからサイトを開けます');
}
async function backfillLegacyFingerprints(limit=12){
 let count=0;
 for(const r of records){
   if(count>=limit)break;
   if(r.provider!=='local'||!r.hasLocalCopy||r.fileFingerprint)continue;
   count++;
   try{
     const copy=await Media.get(db,r.id);
     if(!copy?.blob)continue;
     const fp=await Media.fingerprint(copy.blob);
     await saveOne({...r,fileFingerprint:fp});
     r.fileFingerprint=fp;
   }catch{} // Existing v1.4 files must remain usable even when hashing fails.
 }
 if(count)render();
}
function distinctVisible(items){
 const sorted=[...items].sort((a,b)=>Number(Boolean(b.hasLocalCopy))-Number(Boolean(a.hasLocalCopy)) || String(b.lastPlayedAt||b.updatedAt||'').localeCompare(String(a.lastPlayedAt||a.updatedAt||'')));
 const known=new Set(),out=[];
 for(const r of sorted){
  const fingerprint=r.fileFingerprint||'';
  const normalized=norm(r.code||'');
  const key=/^sha256-sampled-v1:/.test(fingerprint)?'file:'+fingerprint:normalized?'code:'+normalized:r.referenceURL?'url:'+r.referenceURL.toLowerCase():`id:${r.id}`;
  if(known.has(key))continue;known.add(key);out.push(r);
 }
 return out.sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}
function allVisible(){const q=$('search').value.trim().toLowerCase(),codeQ=norm(q),provider=$('provider').value;return distinctVisible(records.filter(r=>(!provider||r.provider===provider)&&(!q||[r.title,r.code,...r.performers].join(' ').toLowerCase().includes(q)||(codeQ&&norm(r.code).includes(codeQ)))));}
async function thumbnailURLFor(record){
 if(thumbnailURLs.has(record.id))return thumbnailURLs.get(record.id);
 if(thumbnailFailed.has(record.id))return '';
 if(thumbnailJobs.has(record.id))return thumbnailJobs.get(record.id);
 const task=(async()=>{
   try{
     let row=await Media.getThumbnail(db,record.id);
     if(!row?.blob && record.hasLocalCopy){
       const original=await Media.get(db,record.id);
       if(original?.blob){const thumb=await Media.captureThumbnail(original.blob);if(thumb){await Media.putThumbnail(db,record.id,thumb);row={blob:thumb};}}
     }
     if(!row?.blob){thumbnailFailed.add(record.id);return '';}
     const url=URL.createObjectURL(row.blob);thumbnailURLs.set(record.id,url);return url;
   }catch{thumbnailFailed.add(record.id);return '';}
   finally{thumbnailJobs.delete(record.id);}
 })();thumbnailJobs.set(record.id,task);return task;
}
function bindThumbnail(cover,record){
 if(!record.hasLocalCopy)return;
 const img=elem('img','cover-image');img.alt=`${record.title} の動画サムネイル`;img.loading='lazy';
 thumbnailURLFor(record).then(url=>{if(url && cover.isConnected){img.src=url;cover.prepend(img);}}).catch(()=>{});
}
function renderCards(id,list){const parent=$(id);parent.replaceChildren();if(!list.length){const none=elem('div','empty','作品がありません。右上の＋で登録、または「動画を追加」から始められます。');parent.append(none);return;}
 for(const r of list){const card=elem('article','item');const cover=elem('div','cover');const thumb=imageFor(r.coverURL,r.title);if(thumb)cover.append(thumb);else cover.append(elem('span','film','▶'));bindThumbnail(cover,r);cover.append(elem('span','provider',PROVIDERS[r.provider]));card.append(cover);const body=elem('div','item-body');body.append(elem('div','item-title',r.title),elem('div','code',r.code||r.performers.join('・')||'作品情報'));
 if(id==='visits'){const when=External.latestAt(r);const label=r.lastExternalOpenedAt===when?'外部ページを開いた（再生確認なし）':'アプリ内で再生';const date=new Date(when);body.append(elem('div','external-visit-label',`${label} · ${Number.isNaN(date.getTime())?'':date.toLocaleString('ja-JP')}`));}
 const bar=elem('div','progress');const fill=elem('div');fill.style.width=`${Math.min(100,r.duration?Math.max(0,r.lastPosition/r.duration*100):r.progressPercent)}%`;bar.append(fill);body.append(bar);
 const controls=elem('div','controls');const action=elem('button','play',r.hasLocalCopy?'▶ 保存動画を再生':r.provider==='local'?(objUrls.has(r.id)?'▶ 再生':'動画を選ぶ'):Catalog.safePlayable(r,liveSettings.mediaOrigins)||Catalog.safeEmbed(r,liveSettings.mediaOrigins)?'▶ アプリ内で再生':Javinfo.PROVIDERS.includes(r.provider)&&r.code?(r.provider==='missav'?'▶ アプリ内を試す':'▶ 再生'):'↗ 元サイト');action.addEventListener('click',()=>start(r));const fav=elem('button',`heart${r.isFavorite?' on':''}`,r.isFavorite?'♥ 保存済み':'♡ 保存');fav.addEventListener('click',()=>syncGroupState(r,{isFavorite:!r.isFavorite}).catch(e=>toast(e.message)));controls.append(action,fav);body.append(controls);
 const small=elem('div','secondary-controls');const edit=elem('button','', '編集');edit.addEventListener('click',()=>editItem(r));const watched=elem('button','',r.isWatched?'未視聴へ':'視聴済み');watched.addEventListener('click',()=>syncGroupState(r,{isWatched:!r.isWatched}).catch(e=>toast(e.message)));small.append(edit,watched);const local=elem('button','',r.hasLocalCopy?'⇩ ファイルへ書出':'↓ 動画を保存');local.addEventListener('click',()=>r.hasLocalCopy?exportMediaFile(r).catch(e=>toast('書出に失敗: '+e.message)):openSaveMedia(r));small.append(local);const originalLink=originalWatchLink(r);if(originalLink)small.prepend(originalLink);body.append(small);card.append(body);parent.append(card);
 }}
function updateQuickResume(){
 const candidates=records.filter(r=>r.hasLocalCopy||objUrls.has(r.id)||
   Boolean(Catalog.safePlayable(r,liveSettings.mediaOrigins)));
 const button=$('quickResume');
 if(!button)return;
 if(!candidates.length){button.hidden=true;button.removeAttribute('data-id');return;}
 candidates.sort((a,b)=>String(b.lastPlayedAt||b.updatedAt||'').localeCompare(String(a.lastPlayedAt||a.updatedAt||'')));
 const latest=candidates[0];
 button.hidden=false;button.dataset.id=latest.id;
 button.textContent=`▶ ${Number(latest.lastPosition)>1?'続きから':'すぐ再生'}：${String(latest.title||'保存済み動画').slice(0,32)}`;
}
function render(){updateQuickResume();const rows=allVisible();$('count').textContent=`${rows.length} 件`;renderCards('library',rows);renderCards('favorites',rows.filter(r=>r.isFavorite));renderCards('continues',rows.filter(r=>r.lastPosition>0&&!r.isWatched));renderCards('visits',External.recent(rows));const d=duplicateGroups(records),fdups=fileDuplicateGroups(records);$('duplicateCount').textContent=`同じ品番 ${d.length}組 / 同一動画候補 ${fdups.length}組 / 複数提供元 ${crossProviderGroups(rows).length}組`;
 const area=$('duplicates');area.replaceChildren();if(!d.length&&!fdups.length)area.append(elem('p','note','重複候補はまだありません。'));
 for(const group of fdups){const n=elem('div','duplicate-row');n.append(elem('strong','','動画内容が一致する可能性'),elem('span','',group.map(x=>x.title).join(' / ')));area.append(n);}
 const stats=PeachStats.compute(records);$('statsSummary').textContent=`保存動画 ${records.filter(x=>x.hasLocalCopy).length}本 · 視聴済み ${stats.watched}件 · お気に入り ${stats.favorites}件 · アプリ内再生 ${stats.plays}回 · 外部ページ訪問 ${records.reduce((t,r)=>t+(r.externalOpenCount||0),0)}回 · 累計 ${stats.watchHours}時間`;
 const followed=records.filter(r=>r.performers.some(n=>followNames.includes(n)));
 $('followedWorks').replaceChildren();for(const r of followed.slice(0,15)){$('followedWorks').append(elem('div','following-result',`${r.code||r.title} · ${r.performers.filter(n=>followNames.includes(n)).join('・')}`));}
 if(!followed.length)$('followedWorks').append(elem('p','note','フォロー中の出演者に一致する登録作品はまだありません（自動ネット取得ではありません）。'));
 $('followList').replaceChildren();for(const name of followNames){const n=elem('div','follow-row');n.append(elem('span','',name));const b=elem('button','','解除');b.onclick=async()=>{followNames=followNames.filter(x=>x!==name);await writeMeta('follows',followNames);render()};n.append(b);$('followList').append(n);}
 for(const [key,group] of d.slice(0,30)){const n=elem('div','duplicate-row');n.append(elem('strong','',key),elem('span','',group.map(x=>PROVIDERS[x.provider]).join(' · ')));area.append(n);}
}
async function clearAllHistory(){
 if(!confirm('再生履歴と外部サイトを開いた履歴だけを削除しますか？保存動画・お気に入り・作品情報は残します。'))return;
 const next=records.map(r=>({...r,watchCount:0,watchedSeconds:0,lastPlayedAt:'',lastPosition:0,progressPercent:0,lastExternalOpenedAt:'',externalOpenCount:0}));
 await writeAll(next);await reload();toast('履歴を削除しました（保存動画は残っています）');
}
function setView(name){for(const id of ['home','favorites','continue','duplicates','settings'])$(id+'View').hidden=id!==name;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('searchPanel').hidden=name==='settings';}
function toggleLicensedFields(){
  const f=$('editForm');if(!f)return;
  const licensed=f.elements.provider.value==='licensed';
  $('licensedFields').hidden=!licensed;
  if(licensed)updateLicensedWarning();
}
function updateLicensedWarning(){
  const f=$('editForm');if(!f)return;
  const raw=f.elements.playbackURL.value.trim();
  const warn=$('licensedUrlWarning');
  if(!raw){warn.hidden=true;return;}
  const msgs=[];
  if(looksEphemeralURL(raw))msgs.push('有効期限や認証情報が含まれている可能性があります。期限切れの場合は再登録が必要です。');
  const fmt=formatSupportNote(raw);
  if(fmt)msgs.push(fmt+'。');
  warn.textContent=msgs.join(' ');
  warn.hidden=!msgs.length;
}
function editItem(item){activeId=item?.id||null;const f=$('editForm');f.reset();$('dialogTitle').textContent=item?'作品を編集':'作品を追加';if(item){for(const field of ['title','code','provider','referenceURL'])f.elements[field].value=item[field]||'';f.elements.performers.value=item.performers.join('、');f.elements.playbackURL.value=item.playbackURL||'';}$('deleteBtn').hidden=!item;toggleLicensedFields();$('editDialog').showModal();}
async function start(item){
 // External navigation must not assign the HTMLVideoElement playback record.
 try{
   if(item.hasLocalCopy){const stored=await Media.get(db,item.id);if(stored?.blob){const url=URL.createObjectURL(stored.blob);playingUrl=url;return play(item,url);}}
   if(objUrls.has(item.id))return play(item,objUrls.get(item.id));
 }catch(e){toast(`保存済み動画を開けません: ${e.message}`);}
 // Directly licensed URLs work without an API even on MISSAV provider records.
 const stream=Catalog.safePlayable(item,liveSettings.mediaOrigins);
 if(stream){play(item,stream);return;}
 const embed=Catalog.safeEmbed(item,liveSettings.mediaOrigins);
 if(embed){playEmbedded(item,embed);return;}
 if(Javinfo.PROVIDERS.includes(item.provider) && item.code){
   // One tap: use the saved API key without a separate permission-checkbox gate.
   // A stream URL is not authorization to bypass a provider's access controls.
   if($('javinfoKey').value.trim()){
     try{return await playJavinfoMovie(item);}catch(e){
       javinfoStatus('再生準備に失敗: '+e.message);
       toast('再生URLを取得できませんでした。設定のAPIキーを確認してください');
       return;
     }
   }
   // No key + no direct playable URL: go to the original page when available.
   // This is an external visit, never a confirmed in-app playback.
   const source=safeURL(item.referenceURL,item.provider);
   if(source){
     window.open(source,'_blank','noopener,noreferrer');
     void markExternalOpen(item).catch(e=>toast('外部訪問の保存に失敗: '+e.message));
     toast('元サイトを開きました（アプリ内再生履歴には加算しません）');
     return;
   }
   $('manualStreamTitle').value=item.title||'';
   $('manualStreamCode').value=item.code||'';
   $('manualStreamPanel').open=true;
   $('manualStreamPanel').scrollIntoView({block:'start',behavior:'smooth'});
   toast('再生URLがありません。端末動画か直接動画URLを指定してください');
   return;
 }
 if(item.provider==='local'){selectedFileItem=item.id;$('videoFile').value='';$('videoFile').click();return;}
 if(item.provider==='licensed'&&item.referenceURL){
  try{const url=new URL(item.referenceURL);
    if(liveSettings.mediaOrigins.includes(url.origin)&&/\.(mp4|m4v|mov|webm|m3u8)$/i.test(url.pathname)){play(item,url.href);return;}
  }catch{}
  toast('元ページを開きます。開いた履歴を保存します');window.open(item.referenceURL,'_blank','noopener,noreferrer');void markExternalOpen(item).catch(e=>toast('履歴の保存に失敗: '+e.message));return;
 }
 if(item.referenceURL){window.open(item.referenceURL,'_blank','noopener,noreferrer');void markExternalOpen(item).catch(e=>toast('履歴の保存に失敗: '+e.message));return;}
 toast('参照URLを登録してください');
}
// Prefer the legitimate original site when the embedded/direct stream cannot play.
function showPlaybackSourceLink(item){
 const safe=item?.referenceURL?safeURL(item.referenceURL,item.provider):'';
 const link=$('embeddedSourceLink');
 if(safe){link.href=safe;link.hidden=false;}
 else{link.hidden=true;link.removeAttribute('href');}
 return Boolean(safe);
}
function playEmbedded(item,url){
 const safe=Catalog.safeEmbed(item,liveSettings.mediaOrigins);
 if(!safe||safe!==url){toast('埋め込みURLを許可できません');return;}
 // Cross-origin frame is opaque: playback progress and controls are not accessible.
 const video=$('player');video.pause();video.removeAttribute('src');video.load();video.hidden=true;$('playerStart').hidden=true;
 document.querySelector('.player-actions').hidden=true;
 currentId=null;embedPlaying=true;embeddedCurrentId=item.id;resetRouteDiagnostic();
 const frame=$('embeddedPlayer');frame.hidden=false;frame.src=safe;
 const source=$('embeddedSourceLink');source.hidden=!item.referenceURL;if(item.referenceURL)source.href=item.referenceURL;else source.removeAttribute('href');
 $('playerTitle').textContent=item.title;
 $('playerSaveLocal').hidden=true;$('playerExportFile').hidden=true;$('playerHelp').textContent='配信元がiframe埋め込みを許可した場合にのみ表示されます。ブロック・ログイン要求・再生失敗時は元ページを開いてください。埋め込みプレイヤーでは再生位置を取得できません。';
 $('playerDialog').showModal();
}
function resetPlaybackAccounting(){
 playbackClock=Playback.session();lastSavedAt=0;playbackBegan=false;
}
// Routine diagnostics include safe URL structure, never full signed URLs.
function startRouteAttempt(kind,sourceURL){routeTrace.begin(kind,sourceURL);}
function hidePrivatePlaybackURLs(){
 const node=$('privatePlaybackUrls'),btn=$('revealPlaybackUrls');
 node.textContent='';node.hidden=true;
 btn.textContent='🔒 完全URLを端末上で一時表示（共有注意）';
 btn.setAttribute('aria-expanded','false');
}
function resetRouteDiagnostic(){
 routeTrace=Route.session();routeReport='';
 $('playbackRouteSummary').hidden=true;$('playbackRouteSummary').textContent='';
 $('copyPlaybackRoute').hidden=true;
 $('revealPlaybackUrls').hidden=true;hidePrivatePlaybackURLs();
}
function showRouteDiagnostic(){
 routeReport=routeTrace.report();
 $('playbackRouteSummary').textContent=routeReport;
 $('playbackRouteSummary').hidden=false;
 $('copyPlaybackRoute').hidden=false;
 // The URLs are only already-in-memory active playback sources.
 // No requests, IndexedDB writes, localStorage, or automatic copying.
 $('revealPlaybackUrls').hidden=demoPlayback||embedPlaying||!currentId;
}
function togglePrivatePlaybackURLs(){
 const node=$('privatePlaybackUrls'),btn=$('revealPlaybackUrls');
 if(!node.hidden){hidePrivatePlaybackURLs();return;}
 if(demoPlayback||embedPlaying||!currentId)return;
 const count=routeTrace.entries().length;
 const raw=activeHlsCandidates.length?activeHlsCandidates.slice(0,count):
  [$('player').getAttribute('src')||''];
 const valid=raw.filter(url=>{
  try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password;}
  catch{return false;}
 });
 if(!valid.length){
  node.textContent='HTTPSの外部動画URLは取得できませんでした。';
 }else{
  node.textContent='⚠️ 以下はSafariに設定したURLです（最終転送先ではありません）。\n'
   +'署名・認証情報が含まれる可能性があります。SNSやチャットに貼らないでください。\n\n'
   +valid.map((url,i)=>`候補${i+1}: ${url}`).join('\n\n');
 }
 node.hidden=false;
 btn.textContent='🔒 完全URLの表示を消す';
 btn.setAttribute('aria-expanded','true');
}

function playSampleVideo(){
 const sample={id:'__peach_internal_demo__',title:'iPhone再生テスト（6秒）',
    provider:'local',lastPosition:0,hasLocalCopy:false};
 $('quickPlayStatus').textContent='同梱MP4を読み込み中。再生位置が進むまで成功とは判定しません。';
 play(sample,'./sample.mp4',{demo:true,testKind:'mp4'});
}
function play(item,url,options={}){
 demoPlayback=options.demo===true;
 playbackTestKind=demoPlayback?(options.testKind||'mp4'):'';
 activePlayerItem=item;
 $('viewPlaybackDiagnostic').hidden=true;embedPlaying=false;
 $('embeddedSourceLink').hidden=true;$('embeddedSourceLink').removeAttribute('href');
 const frame=$('embeddedPlayer');frame.hidden=true;frame.removeAttribute('src');
 const video=$('player');video.hidden=false;$('playerStart').hidden=true;document.querySelector('.player-actions').hidden=false;
 playSession++;video.pause();video.removeAttribute('src');video.load();
 currentId=item.id;resetPlaybackAccounting();
 activeHlsCandidates=Array.isArray(options.hlsCandidates)?
   options.hlsCandidates.filter(v=>typeof v==='string'&&v===Javinfo.streamURL(v)).slice(0,8):[];
 if(activeHlsCandidates.length && !activeHlsCandidates.includes(url))activeHlsCandidates=[];
 activeHlsIndex=activeHlsCandidates.indexOf(url);
 activeHlsKinds=Array.isArray(options.hlsCandidateKinds)?
   options.hlsCandidateKinds.filter(k=>k==='master'||k==='variant').slice(0,8):[];
 resetRouteDiagnostic();
 if(!demoPlayback){
  const isHls=(()=>{try{return /\.m3u8$/i.test(new URL(url).pathname);}catch{return false;}})();
  startRouteAttempt(isHls?(activeHlsKinds[activeHlsIndex]||'directHls'):'directFile',url);
 }
 $('playerSaveLocal').hidden=demoPlayback||Boolean(item.hasLocalCopy);
 $('playerExportFile').hidden=demoPlayback||!item.hasLocalCopy;
 // Do not set crossOrigin: Safari's native HLS fetch is separate from JS CORS.
 video.removeAttribute('crossorigin');video.src=url;
 $('playerTitle').textContent=item.title;
 // The permitted original watch page is always an explicit user option.
 if(!demoPlayback)showPlaybackSourceLink(item);
 $('playerHelp').textContent=demoPlayback?
  (playbackTestKind==='mp4'?'同梱MP4（H.264/AAC）。通信不要。履歴には登録しません。':
   'Apple公開の標準HLSをSafariネイティブで検証中。通信が必要です。履歴には登録しません。'):item.provider==='local'?
  '動画はサーバーへ送信されません。iOSのストレージ制限に備えバックアップを保管してください。':
  'Safariネイティブ再生中。配信元が許可し、HLS・コーデックが対応する場合のみ再生できます。';
 if(!$('playerDialog').open)$('playerDialog').showModal();
 const session=playSession;
 video.addEventListener('loadedmetadata',function loaded(){
  if(session!==playSession)return;
  if(item.lastPosition>1 && Number.isFinite(video.duration)&&video.duration>item.lastPosition+5)
   try{video.currentTime=item.lastPosition;}catch{}
 },{once:true});
 video.play().catch(err=>{
   if(session!==playSession||!$('playerDialog').open)return;
   if(err?.name==='NotAllowedError'){
    $('playerStart').hidden=false;
    $('playerHelp').textContent+=' Safariが自動再生を許可しませんでした。「▶ 再生を開始」を押してください。';
   } // Other failures are handled by the media error event, without mislabelling as autoplay.
 });
}
function tryNextHlsCandidate(){
 if(playbackBegan||activeHlsIndex<0||activeHlsIndex+1>=activeHlsCandidates.length)return false;
 activeHlsIndex++;playSession++;resetPlaybackAccounting();
 startRouteAttempt(activeHlsKinds[activeHlsIndex]||'variant',activeHlsCandidates[activeHlsIndex]);
 const video=$('player'),url=activeHlsCandidates[activeHlsIndex];$('playerStart').hidden=true;
 video.pause();video.removeAttribute('src');video.load();
 video.removeAttribute('crossorigin');video.src=url;
 const activeSession=playSession,record=records.find(r=>r.id===currentId);
 video.addEventListener('loadedmetadata',function(){
  if(activeSession===playSession&&record?.lastPosition>1&&
    Number.isFinite(video.duration)&&video.duration>record.lastPosition+5)
   try{video.currentTime=record.lastPosition;}catch{}
 },{once:true});
 $('playerHelp').textContent=`前のHLS候補は再生できませんでした。API提供の別画質候補 ${activeHlsIndex+1}/${activeHlsCandidates.length} をSafariで再試行中です。`;
 // iOS can require an explicit user tap after an asynchronous fallback.
 video.play().catch(()=>{
   if(activeSession!==playSession||!$('playerDialog').open)return;
   $('playerStart').hidden=false;
   $('playerHelp').textContent+=' 「▶ 再生を開始」を押してください。';
 });
 return true;
}
// Serialize read/modify/write at the authoritative IndexedDB store.
// Never overwrite favorites or concurrent local-copy updates from a stale UI row.
function persistPlayback(id,change){
 const task=()=>new Promise((resolve,reject)=>{
  const tx=db.transaction('items','readwrite'),store=tx.objectStore('items');
  let saved=null,updates=[];
  tx.onerror=()=>reject(tx.error||Error('視聴履歴の保存に失敗'));
  tx.onabort=()=>reject(tx.error||Error('視聴履歴の更新が中断'));
  tx.oncomplete=()=>{
   if(saved){const i=records.findIndex(r=>r.id===id);if(i>=0)records[i]=saved;
    for(const row of updates){const j=records.findIndex(r=>r.id===row.id);if(j>=0)records[j]=row;}
    render();
   }
   resolve();
  };
  const req=store.get(id);
  req.onsuccess=()=>{
   const old=req.result;if(!old)return;
   const position=Number.isFinite(change.position)&&change.position>=0?change.position:null;
   const duration=Number.isFinite(change.duration)&&change.duration>0?change.duration:Number(old.duration)||0;
   const patch={
    watchCount:Math.min(1000000,(Number(old.watchCount)||0)+(change.started?1:0)),
    watchedSeconds:Math.min(1e10,(Number(old.watchedSeconds)||0)+Math.max(0,Number(change.seconds)||0)),
    lastPlayedAt:change.started?new Date().toISOString():old.lastPlayedAt,
    updatedAt:new Date().toISOString()
   };
   if(position!==null){
    patch.lastPosition=position;patch.duration=duration;
    patch.progressPercent=duration?Math.min(100,Math.floor(100*position/duration)):old.progressPercent;
    patch.isWatched=Boolean(old.isWatched)||(duration>0&&position/duration>=.95);
   }
   saved=canonical({...old,...patch},uid);store.put(saved);
   if(position!==null){
    const key=Catalog.identity(saved);
    if(key)for(const sibling of records){
     if(sibling.id===id||Catalog.identity(sibling)!==key)continue;
     const r=store.get(sibling.id);
     r.onsuccess=()=>{
      if(!r.result)return;
      const fresh=r.result;
      const next=canonical({...fresh,lastPosition:saved.lastPosition,duration:saved.duration,
       progressPercent:saved.progressPercent,isWatched:Boolean(fresh.isWatched)||saved.isWatched},uid);
      store.put(next);updates.push(next);
     };
    }
   }
  };
 });
 const pending=playbackWriteQueue.catch(()=>{}).then(task);
 playbackWriteQueue=pending;return pending;
}
function recordNativePlaying(){
 const video=$('player');
 $('playerStart').hidden=true;
 if(!currentId||embedPlaying||video.paused||video.readyState<2)return;
 // 'playing' means ready to advance; actual media-time progression is required
 // before we declare a confirmed play or increment any watch history.
 routeTrace.observed('playing');
 playbackClock.start(Number(video.currentTime)||0,performance.now());
}
function collectPlaybackTime(stop=false){
 const video=$('player');if(!currentId||!playbackClock.hasStarted())return;
 const viewed=stop?
  playbackClock.hold(video.currentTime,performance.now(),video.playbackRate):
  !video.seeking?playbackClock.tick(video.currentTime,performance.now(),video.playbackRate):0;
 if(demoPlayback){
   if(!playbackBegan&&viewed>0.04){
     playbackBegan=true;
     if(playbackTestKind==='mp4'){
      $('quickPlayStatus').textContent='✓ 同梱MP4の再生位置が進みました。Safari基本再生は成功。MISSAV配信の可否は別判定です。';
     }else if(HLS_BASELINE[playbackTestKind]){
      const label=HLS_BASELINE[playbackTestKind].label;
      setHlsBaselineStatus(playbackTestKind,`✅ ${label}：実再生成功（再生位置の進行を確認）。MISSAV固有の配信条件は未判定です。`);
     }
   }
   return;
 }
 if(viewed>0.04)routeTrace.advanced();
 if(!playbackBegan&&viewed>0.04){
  playbackBegan=true;
  const id=currentId;
  persistPlayback(id,{started:true}).catch(()=>toast('再生開始履歴を保存できませんでした'));
 }
}
async function savePosition(){
 if(loading||!currentId||!playbackBegan||demoPlayback)return;
 const id=currentId,clock=playbackClock,video=$('player');
 collectPlaybackTime();
 const pos=Number(video.currentTime);
 if(!Number.isFinite(pos)||pos<0)return;
 const seconds=clock.take();
 const length=Number.isFinite(video.duration)&&video.duration>0?video.duration:0;
 try{await persistPlayback(id,{position:pos,duration:length,seconds});}
 catch(e){clock.restore(seconds);throw e;}
}
async function closeVideo(){
 $('embeddedSourceLink').hidden=true;$('embeddedSourceLink').removeAttribute('href');
 const frame=$('embeddedPlayer');frame.removeAttribute('src');frame.hidden=true;
 embedPlaying=false;embeddedCurrentId=null;
 $('playerSaveLocal').hidden=false;$('playerExportFile').hidden=false;
 document.querySelector('.player-actions').hidden=false;$('player').hidden=false;
 const video=$('player');
 $('playerStart').hidden=true;
 collectPlaybackTime(true);video.pause();
 try{await savePosition();}catch{toast('再生位置を保存できませんでした');}
 // Finish pending DB writes before changing the session.
 await playbackWriteQueue.catch(()=>{});
 playSession++;activeHlsCandidates=[];activeHlsKinds=[];activeHlsIndex=0;
 resetRouteDiagnostic();
 video.removeAttribute('src');video.load();
 if(playingUrl){URL.revokeObjectURL(playingUrl);playingUrl=null;}
 if(subtitleObjectURL){URL.revokeObjectURL(subtitleObjectURL);subtitleObjectURL=null;}
 const tr=$('subtitleTrack');tr.removeAttribute('src');tr.hidden=true;
 currentId=null;demoPlayback=false;playbackTestKind='';activePlayerItem=null;resetPlaybackAccounting();
 if($('playerDialog').open)$('playerDialog').close();
 render();
}
function openSaveMedia(row=null){
 saveTargetId=row?.id||null;
 $('saveMediaTarget').textContent=row?`保存先：${row.title}（お気に入り・履歴を維持）`:'保存先：新規作品として登録';
 $('directMediaStatus').textContent='保存が許可された直接動画ファイル（256MB以下）か、iPhoneのファイルを選択してください。';
 $('saveMediaPanel').open=true;$('saveMediaPanel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function attachVideoToRecord(file,id){
 if(!file) return;
 if(!Media.isVideo(file))throw Error('動画ファイル（1GB以下）を選択してください');
 // Preserve the original provider, original page link, favorites and watch history.
 const old=records.find(r=>r.id===id);
 if(old?.hasLocalCopy && (await Media.get(db,old.id))?.blob)throw Error('既に動画が保存されています。上書きは行いません');
 const fp=await Media.fingerprint(file);
 const other=await Media.matchExisting(db,file,fp,records);
 if(other&&other.id!==id&&other.hasLocalCopy){toast('同じ動画が別作品に保存されています。既存動画を削除せず、指定作品にも保存します');}
 const meta=Media.fileNameToMeta(file.name);
 const next=canonical(old?{...old,fileFingerprint:fp,hasLocalCopy:true}:{id:uid(),...meta,provider:'local',fileFingerprint:fp,hasLocalCopy:true},uid);
 await Media.putWithRecord(db,next,file,fp);
 await reload();
 try{const thumb=await Media.captureThumbnail(file);if(thumb){await Media.putThumbnail(db,next.id,thumb);thumbnailFailed.delete(next.id);const prior=thumbnailURLs.get(next.id);if(prior)URL.revokeObjectURL(prior);thumbnailURLs.delete(next.id);}}catch{}
 render();return next;
}
async function downloadSave(){
 if(directDownloadAbort)return;
 if(!$('mediaSaveRights').checked){toast('保存が許可されていることを確認してください');return;}
 const raw=$('directMediaUrl').value.trim();let url;
 try{url=Download.validatedUrl(raw);}catch(e){$('directMediaStatus').textContent=e.message;return;}
 const old=records.find(r=>r.id===saveTargetId);
 if(old?.hasLocalCopy && (await Media.get(db,old.id))?.blob){toast('既に端末に保存済みです。上書きしません');return;}
 const ctrl=new AbortController();directDownloadAbort=ctrl;
 $('saveDirectMedia').disabled=true;$('cancelDirectMedia').hidden=false;
 $('directMediaStatus').textContent='動画を取得しています…アプリを閉じないでください';
 try{
  const file=await Download.fetchVideo(url,{signal:ctrl.signal,onProgress:(done,total)=>{$('directMediaStatus').textContent=`取得中 ${Media.prettyBytes(done)}${total?' / '+Media.prettyBytes(total):''}（保存前の検証中）`;}});
  const saved=await attachVideoToRecord(file,old?.id||null);
  $('directMediaStatus').textContent=`端末保存完了：${saved.title}（${Media.prettyBytes(file.size)}）。オフライン再生できます。`;
  toast('動画を端末内に保存しました');
 }catch(e){$('directMediaStatus').textContent='保存できません：'+e.message;}
 finally{directDownloadAbort=null;$('saveDirectMedia').disabled=false;$('cancelDirectMedia').hidden=true;}
}
async function exportMediaFile(row){
 const saved=await Media.get(db,row.id);if(!saved?.blob)throw Error('端末保存した動画がありません');
 const filename=Download.safeFilename(saved.name||'', 'movie.mp4');
 const file=new File([saved.blob],filename,{type:saved.blob.type||'video/mp4'});
 if(navigator.share&&navigator.canShare?.({files:[file]})){
  try{await navigator.share({files:[file],title:row.title});return;}catch(e){if(e?.name==='AbortError')return;}
 }
 const url=URL.createObjectURL(file);try{const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();toast('Safariのダウンロード先を確認してください');}finally{setTimeout(()=>URL.revokeObjectURL(url),60_000);}
}
async function savePlayingMedia(){
 const row=records.find(r=>r.id===currentId);
 if(!row){toast('再生中の動画がありません');return;}
 if(row.hasLocalCopy){toast('すでに端末保存済みです');return;}
 const src=$('player').currentSrc||$('player').src;
 if(src.startsWith('blob:')){
  const copy=await Media.get(db,row.id);
  if(copy?.blob){await store({...row,hasLocalCopy:true});toast('端末に保存済みです');return;}
  const staged=volatileFiles.get(row.id);if(staged){await attachVideoToRecord(staged,row.id);volatileFiles.delete(row.id);$('playerSaveLocal').hidden=true;$('playerExportFile').hidden=false;toast('再生中の動画を端末に保存しました');return;}
  await closeVideo();toast('この動画はファイルを選択して保存してください');openSaveMedia(row);return;
 }
 try{Download.validatedUrl(src);}catch(e){await closeVideo();toast('この動画は直接保存に対応していません。ファイルから登録してください');openSaveMedia(row);return;}
 await closeVideo();openSaveMedia(row);$('directMediaUrl').value=src;toast('画面の「保存許可」を確認し、動画URLから端末に保存してください');
}
async function chooseFile(file,itemId,autoPlay=true){
 if(!file)return;
 if(!Media.isVideo(file))throw Error(file.size>Media.MAX_VIDEO_BYTES?'1ファイルは1GB以下で登録してください':'対応する動画（MP4・MOV・WebMなど）を選択してください');
 const fp=await Media.fingerprint(file);
 let record=records.find(r=>r.id===itemId);
 const duplicate=!itemId?await Media.matchExisting(db,file,fp,records):null;
 if(duplicate){
   const updated=duplicate.fileFingerprint===fp?duplicate:{...duplicate,fileFingerprint:fp};
   if(updated!==duplicate)await store(updated);
   if(duplicate.hasLocalCopy){
     if(autoPlay){const copy=await Media.get(db,duplicate.id);if(copy?.blob){playingUrl=URL.createObjectURL(copy.blob);play(duplicate,playingUrl);}}
     return {saved:true,id:duplicate.id,duplicate:true};
   }
   record=updated;
 }
 if(!record){const meta=Media.fileNameToMeta(file.name);record=canonical({id:uid(),...meta,provider:'local',needsFile:true,fileFingerprint:fp},uid);}
 else record={...record,fileFingerprint:fp};
 // Write a new record only after attempting video storage; no orphan on an invalid file.
 let saved=false;
 if($('saveVideoLocally').checked){
   try{await Media.put(db,record.id,file,fp);saved=true;record={...record,hasLocalCopy:true};}
   catch(e){toast(`動画の端末保存に失敗しました（容量・保存制限）。今回の再生は可能です: ${e.message}`);}
 }
 await store(record);
 try{const thumb=await Media.captureThumbnail(file);if(thumb){await Media.putThumbnail(db,record.id,thumb);const old=thumbnailURLs.get(record.id);if(old)URL.revokeObjectURL(old);thumbnailURLs.delete(record.id);thumbnailFailed.delete(record.id);}}
 catch{} // Thumbnail failures must not prevent playback.
 const old=objUrls.get(record.id);if(old)URL.revokeObjectURL(old);objUrls.delete(record.id);
 if(saved)volatileFiles.delete(record.id);else volatileFiles.set(record.id,file);
 if(autoPlay||!saved){const url=URL.createObjectURL(file);objUrls.set(record.id,url);if(autoPlay){const fresh=records.find(r=>r.id===record.id)||record;play(fresh,url);}}
 return {saved,id:record.id,duplicate:Boolean(duplicate)};
}
async function importVideoBatch(files){
 const valid=Array.from(files||[]);
 if(!valid.length)return;
 if(valid.length>50)throw Error('一度に追加できる動画は50本までです');
 let added=0,reused=0,stored=0,failed=[];
 for(let i=0;i<valid.length;i++){
  try{const r=await chooseFile(valid[i],selectedFileItem&&i===0?selectedFileItem:null,valid.length===1);if(r.duplicate)reused++;else added++;if(r.saved)stored++;}
  catch(e){failed.push(`${valid[i].name}: ${e.message}`);}
 }
 toast(`新規登録 ${added}件 / 重複検出 ${reused}件 / 保存済み ${stored}件 / 失敗 ${failed.length}件`);
 if(failed.length)$('importErrors').textContent=failed.slice(0,10).join(' / ');
 await reload();
}

async function importJSON(file){
  if(file.size>20*1024*1024)throw Error('バックアップは20MB以下にしてください');
  const payload=JSON.parse(await file.text());
  const parsed=isEncrypted(payload)?await decrypt(payload,backupPassword()):payload;
  if(!isEncrypted(payload)&&!confirm('暗号化されていない旧形式JSONです。信頼できるファイルの場合のみ読み込みます。続けますか？'))return;
  const sanitized=Array.isArray(parsed)?parsed.map(r=>({...r,hasLocalCopy:false})):({...parsed,items:(parsed.items||parsed.works||parsed.records||[]).map(r=>({...r,hasLocalCopy:false}))});
  const result=importRows(sanitized,records,uid);
  if(!confirm(`作品情報を ${result.imported} 件読み込みます（既存データと結合・動画ファイルは含みません）。続けますか？`))return;
  for(const row of result.items){const local=records.find(x=>x.id===row.id);if(local?.hasLocalCopy)row.hasLocalCopy=true;}
  await writeAll(result.items);await reload();await notifyRestoredStreamIssues();toast(`${result.imported}件の作品を読み込みました`);
}

async function init(){db=await openDB();await initDevice();await initLiveSettings();await initOfflineCatalog();await initJavinfoKey();await reload();try{await notifyStreamIssuesOnce();}catch(e){console.warn('stream issue notice skipped:',e);}await backfillLegacyFingerprints();$('addBtn').onclick=()=>editItem();$('externalQuickForm').addEventListener('submit',ev=>saveManualExternal(ev).catch(e=>toast('リンク登録に失敗: '+e.message)));$('attachMediaFile').onclick=()=>{$('attachVideoFile').value='';$('attachVideoFile').click();};$('attachVideoFile').addEventListener('change',async ev=>{try{if(ev.target.files?.[0]){const row=await attachVideoToRecord(ev.target.files[0],saveTargetId);$('directMediaStatus').textContent=`端末へ保存しました：${row.title}`;toast('動画ファイルを紐付けました');}}catch(e){$('directMediaStatus').textContent='保存できません：'+e.message;}finally{ev.target.value='';}});$('saveDirectMedia').onclick=()=>downloadSave();$('cancelDirectMedia').onclick=()=>directDownloadAbort?.abort();$('addVideoBtn').onclick=()=>{selectedFileItem=null;$('videoFile').value='';$('videoFile').click();};$('search').oninput=()=>{render();renderSiteLinks();scheduleAutoSearch();};
 $('quickResume').onclick=()=>{
   const item=records.find(r=>r.id===$('quickResume').dataset.id);
   if(item)start(item).catch(e=>toast('再生できません: '+e.message));
 };
 $('quickSamplePlay').onclick=playSampleVideo;
 $('quickHlsTs').onclick=()=>playHlsBaseline('ts');
 $('quickHlsFmp4').onclick=()=>playHlsBaseline('fmp4');
 $('quickLocalPlay').onclick=()=>{selectedFileItem=null;$('videoFile').value='';$('videoFile').click();};
 $('quickOpenStream').onclick=()=>{
   const panel=$('manualStreamPanel');panel.open=true;
   panel.scrollIntoView({block:'start',behavior:'smooth'});
   $('manualStreamURL').focus({preventScroll:true});
 };
 $('openApiSettings').onclick=openApiSettings;
 $('clearPlaybackDiagnostic').onclick=clearPlaybackDiagnostic;
 $('viewPlaybackDiagnostic').onclick=openPlaybackDiagnostics;
 $('javinfoKeySave').onclick=()=>saveJavinfoKey().catch(e=>{$('javinfoKeyStatus').textContent='保存失敗：'+e.message;});
 $('javinfoKeyClear').onclick=()=>clearJavinfoKey().catch(e=>{$('javinfoKeyStatus').textContent='削除失敗：'+e.message;});
 $('javinfoSearch').addEventListener('input',()=>{javinfoPage=1;javinfoTerm='';javinfoMore=false;renderJavinfoPages();});
 $('javinfoProvider').addEventListener('change',()=>{javinfoPage=1;javinfoTerm='';javinfoMore=false;javinfoResults=[];renderJavinfoResults();renderJavinfoPages();});
 $('manualStreamPlay').onclick=()=>playManualStream().catch(e=>{$('manualStreamStatus').textContent='再生できません：'+e.message;});
 $('javinfoPrev').onclick=()=>runJavinfoSearch(javinfoPage-1).catch(e=>javinfoStatus(e.message));
 $('javinfoNext').onclick=()=>runJavinfoSearch(javinfoPage+1).catch(e=>javinfoStatus(e.message));
 $('clearHistoryBtn').onclick=()=>clearAllHistory().catch(e=>toast('履歴削除に失敗：'+e.message));
 $('javinfoSearchBtn').onclick=()=>runJavinfoSearch(1).catch(e=>javinfoStatus(e.message));$('javinfoSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void runJavinfoSearch().catch(err=>javinfoStatus(err.message));}});$('liveSearchBtn').onclick=()=>runLiveSearch().catch(e=>toast('ライブ検索失敗: '+e.message));$('harvestBtn').onclick=()=>harvestCatalog().catch(e=>{$('harvestStatus').textContent='取得失敗: '+e.message;});
 $('importCatalogBtn').onclick=()=>$('catalogFile').click();
 $('missavCompatFileBtn').onclick=()=>$('missavCompatFile').click();
 $('missavCompatFile').addEventListener('change',async e=>{
  try{if(e.target.files?.[0])await importMissavFile(e.target.files[0]);}
  catch(err){$('missavCompatStatus').textContent='取込できません: '+err.message;}
  finally{e.target.value='';}
 });
 $('missavCompatPasteBtn').onclick=()=>{
  try{
   const value=$('missavCompatPaste').value;
   if(new Blob([value]).size>MissavCompat.MAX_BYTES)throw Error('JSONが2MBを超えています');
   void saveMissavCompatibility(JSON.parse(value)).catch(err=>$('missavCompatStatus').textContent='取込できません: '+err.message);
  }catch(err){$('missavCompatStatus').textContent='取込できません: '+err.message;}
 };
 $('missavCompatFetchBtn').onclick=()=>fetchMissavCompatibility();
 $('catalogFile').addEventListener('change',async ev=>{try{if(ev.target.files?.[0])await importOfflineCatalog(ev.target.files[0]);}catch(err){toast(`作品情報の取込に失敗: ${err.message}`);}finally{ev.target.value='';}});
 $('clearCatalogBtn').onclick=async()=>{if(!confirm(`端末内カタログ${offlineCatalogRows.length}件を削除しますか？マイライブラリと動画本体は削除しません。`))return;await writeMeta('offlineCatalogRows',[]);offlineCatalogRows=[];liveCatalogRows=[];renderCatalogStatus();renderLiveGroups();toast('取込カタログを消去しました');};
 $('healthBtn').onclick=()=>inspectLibrary().catch(e=>toast('診断に失敗しました: '+e.message));
 $('repairCopiesBtn').onclick=()=>repairCopies().catch(e=>toast('修復に失敗しました: '+e.message));$('saveLiveSettings').onclick=()=>saveLiveSettings().catch(e=>toast('設定保存失敗: '+e.message));$('checkFollows').onclick=checkFollowedReleases;$('provider').onchange=render;document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
 $('editForm').addEventListener('submit',async ev=>{ev.preventDefault();const f=ev.currentTarget,provider=f.elements.provider.value,url=f.elements.referenceURL.value.trim();if(url&&!safeURL(url,provider)){toast('提供元に合うHTTPS URLを登録してください');return;}
 const prev=records.find(r=>r.id===activeId);
 const providerChanged=!!prev&&prev.provider!==provider;
 const patch={...prev,id:activeId||uid(),title:f.elements.title.value,code:f.elements.code.value,performers:f.elements.performers.value,provider,referenceURL:url};
 let streamNote='';
 if(provider==='licensed'){
   const streamRaw=f.elements.playbackURL.value.trim();
   if(streamRaw){
     const ok=Javinfo.directMediaURL(streamRaw);
     if(!ok){toast('再生用URLは直接の動画ファイル（.mp4・.m3u8等）のHTTPS URLを指定してください');return;}
     if(looksEphemeralURL(ok))streamNote+=' ※期限付きURLの可能性あり：期限切れ時は再登録してください';
     const fmt=formatSupportNote(ok);
     if(fmt)streamNote+=' ※'+fmt;
     try{await allowMediaOrigin(ok);}catch(e){toast(e.message);return;}
     patch.playbackURL=ok;patch.rightsConfirmed=true;
   }else{patch.playbackURL='';patch.rightsConfirmed=false;}
 }else if(providerChanged){
   // Provider changed away from licensed: the saved stream URL and its rights
   // confirmation belonged to the previous provider, so drop them.
   patch.playbackURL='';patch.rightsConfirmed=false;
 }
 try{await store(patch);$('editDialog').close();toast('保存しました'+streamNote);}catch(e){toast(`保存エラー: ${e.message}`);}});
 $('editForm').elements.provider.addEventListener('change',toggleLicensedFields);
 $('editForm').elements.playbackURL.addEventListener('input',updateLicensedWarning);
 $('scanStreamIntegrity').onclick=()=>{try{renderStreamIntegrity();}catch(e){toast(e.message);}};
 $('deleteBtn').onclick=async()=>{if(!activeId||!confirm('この作品情報を削除しますか？'))return;try{await Media.removeWithRecord(db,activeId);}catch(err){toast(`作品を削除できません: ${err.message}`);return;}const tu=thumbnailURLs.get(activeId);if(tu){URL.revokeObjectURL(tu);thumbnailURLs.delete(activeId);}thumbnailFailed.delete(activeId);const u=objUrls.get(activeId);if(u)URL.revokeObjectURL(u);objUrls.delete(activeId);volatileFiles.delete(activeId);$('editDialog').close();await reload();toast('登録を削除しました');};
 $('videoFile').addEventListener('change',async ev=>{try{await importVideoBatch(ev.target.files);}catch(err){toast(`動画の読込に失敗: ${err.message}`);}finally{ev.target.value='';}});
 $('saveDeviceLabel').onclick=async()=>{
   const label=clean($('deviceLabel').value,35)||'自分のiPhone';
   installation={...installation,label};await writeMeta('installation',installation);$('deviceLabel').value=label;toast('端末名を保存しました。他の端末には送信されません');
 };
 $('fullExportBtn').onclick=()=>exportFullBackup().catch(err=>{$('fullBackupStatus').textContent='完全バックアップ失敗：'+err.message;});
 $('fullImportBtn').onclick=()=>$('fullBackupFile').click();
 $('fullBackupFile').addEventListener('change',async ev=>{try{if(ev.target.files?.[0])await importFullBackup(ev.target.files[0]);}catch(e){$('fullBackupStatus').textContent='復元失敗：'+e.message;}finally{ev.target.value='';$('backupPassword').value='';}});
 $('syncEndpoint').value=await readMeta('cloudSyncEndpoint')||'';
 $('syncStartBtn').onclick=()=>startCloudSync().catch(e=>{$('syncStatus').textContent='同期を開始できません：'+e.message;cloudSession=null;});
 $('syncStopBtn').onclick=()=>{cloudSession=null;$('syncStatus').textContent='同期停止。ログイン情報は保持していません。';};
 setInterval(()=>{if(cloudSession&&!document.hidden)performCloudSync().catch(()=>{});},5*60*1000);
 $('exportBtn').onclick=exportEncrypted;$('importBtn').onclick=()=>$('backupFile').click();$('backupFile').addEventListener('change',async ev=>{try{if(ev.target.files?.[0])await importJSON(ev.target.files[0]);}catch(err){toast(`取込失敗: ${err.message}`);}finally{ev.target.value='';$('backupPassword').value='';}});
 $('embeddedSourceLink').addEventListener('click',()=>{
  const row=records.find(x=>x.id===(embeddedCurrentId||currentId))||activePlayerItem;
  if(row?.referenceURL)void markExternalOpen(row).catch(()=>toast('外部訪問履歴の保存に失敗しました'));
 });$('playerSaveLocal').onclick=()=>savePlayingMedia().catch(e=>toast(e.message));$('playerExportFile').onclick=()=>{const row=records.find(r=>r.id===currentId);if(row)exportMediaFile(row).catch(e=>toast(e.message));};$('playerClose').onclick=()=>closeVideo();$('playerDialog').addEventListener('cancel',ev=>{ev.preventDefault();closeVideo();});$('playerDialog').addEventListener('close',()=>{$('player').pause();});
 $('rewind').onclick=()=>{$('player').currentTime=Math.max(0,($('player').currentTime||0)-10);};$('forward').onclick=()=>{$('player').currentTime=Math.min(Number.isFinite($('player').duration)?$('player').duration:Infinity,($('player').currentTime||0)+10);};
 const speedValues=[1,1.25,1.5,2,0.75];$('speed').onclick=()=>{const video=$('player'),i=speedValues.indexOf(video.playbackRate);video.playbackRate=speedValues[(i+1)%speedValues.length];$('speed').textContent=`${video.playbackRate}倍`;};
 $('fullScreen').onclick=()=>{const video=$('player');if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();else video.requestFullscreen?.();};
 $('pip').onclick=async()=>{const video=$('player');try{if(video.webkitSetPresentationMode){video.webkitSetPresentationMode('picture-in-picture');}else if(document.pictureInPictureEnabled)await video.requestPictureInPicture();else toast('この環境ではPiPを使えません');}catch{toast('PiPを開始できませんでした');}};
 $('playerStart').onclick=()=>{
   $('playerStart').hidden=true;
   $('player').play().catch(()=>{
     if($('playerDialog').open){$('playerStart').hidden=false;toast('再生を開始できません。配信条件を確認してください');}
   });
 };
 for(const milestone of ['loadstart','loadedmetadata','loadeddata','canplay','waiting','stalled']){
  $('player').addEventListener(milestone,()=>{if(currentId&&!demoPlayback&&!embedPlaying)routeTrace.observed(milestone);});
 }
 $('copyPlaybackRoute').onclick=async()=>{
  if(!routeReport)return;
  try{await navigator.clipboard.writeText(routeReport);toast('署名やトークンを含まない診断結果をコピーしました');}
  catch{toast('コピーが許可されませんでした。画面の診断結果を長押しで選択してください');}
 };
 $('revealPlaybackUrls').onclick=togglePrivatePlaybackURLs;
 $('player').addEventListener('playing',recordNativePlaying);
 $('player').addEventListener('timeupdate',()=>{
  collectPlaybackTime();
  if(Date.now()-lastSavedAt>8000&&playbackBegan){lastSavedAt=Date.now();savePosition().catch(()=>{});}
 });
 $('player').addEventListener('seeking',()=>{playbackClock.beginSeek();});
 $('player').addEventListener('seeked',()=>{
  const v=$('player');playbackClock.endSeek(v.currentTime,performance.now(),!v.paused&&!v.ended);
  if(playbackBegan)savePosition().catch(()=>{});
 });
 $('player').addEventListener('waiting',()=>{collectPlaybackTime(true);});
 $('player').addEventListener('pause',()=>{
  collectPlaybackTime(true);savePosition().catch(()=>{});
 });
 $('player').addEventListener('ended',()=>{
  collectPlaybackTime(true);savePosition().then(render).catch(()=>{});
 });
 $('player').addEventListener('error',()=>{
  const video=$('player');if(!video.src||!currentId)return;
  collectPlaybackTime(true);
  if(!demoPlayback)routeTrace.failed(Number(video.error?.code)||0);
  if(tryNextHlsCandidate())return;
  if(playbackBegan)savePosition().catch(()=>{});
  const item=records.find(r=>r.id===currentId);
  const src=video.currentSrc||video.src;
  const format=(()=>{try{return new URL(src).pathname.toLowerCase().endsWith('.m3u8')?'hls':'file';}catch{return 'file';}})();
  const cls=reportPlaybackDiagnostic(video.error?.code,navigator.onLine,format,src);
  if(!demoPlayback){
   showRouteDiagnostic();
   $('playbackDiagnosticStatus').textContent+='\n'+routeReport;
  }
  if(demoPlayback){
    if(playbackTestKind==='mp4'){
     $('quickPlayStatus').textContent='同梱MP4を再生できません。Safari／PWAの基本再生を確認してください。';
    }else if(HLS_BASELINE[playbackTestKind]){
     const label=HLS_BASELINE[playbackTestKind].label;
     setHlsBaselineStatus(playbackTestKind,`❌ ${label}：MediaError ${Number(video.error?.code)||0}。この標準HLSテストでは再生が成立しませんでした。原因は未確定です。`);
    }
   }
   const prefix=playbackBegan?'再生開始後にエラーが発生しました。':'再生開始前にエラーが発生しました。';
  $('playerHelp').textContent=`${prefix} ${cls.kind}: ${cls.detail} ${cls.hint}`;
  const hasSource=!demoPlayback&&showPlaybackSourceLink(item||activePlayerItem);
  toast(hasSource?'動画を再生できません。「元サイトで再生」を利用できます。':'動画を再生できません。診断情報を確認してください。');
  const session=playSession;
  if(demoPlayback)return; // Native playback events alone determine the baseline result.
  Promise.all([diagnoseStreamURL(src),format==='hls'?Hls.inspect(src):Promise.resolve({status:'skipped'})])
   .then(([net,manifest])=>{
    if(session!==playSession||!$('playerDialog').open)return;
    const note=StreamDiagnostics.describe(net)+(format==='hls'?' '+Hls.describe(manifest):'');
    $('playerHelp').textContent+=' '+note;
    $('playbackDiagnosticStatus').textContent+=' '+note;
   }).catch(()=>{});
 });
 $('storageBtn').onclick=async()=>{
   if(!navigator.storage?.estimate){toast('容量情報に対応していません');return;}
   const e=await navigator.storage.estimate();
   const persisted=await navigator.storage.persisted?.().catch(()=>false);
   $('storageStatus').textContent=`作品 ${records.length} 件・ブラウザ使用量 ${Math.round((e.usage||0)/1024/1024)} MB / 推定上限 ${Math.round((e.quota||0)/1024/1024)} MB・保存保護 ${persisted?'有効':'未保証'}。保存の永久保証はありません。`;
 };
 $('persistBtn').onclick=async()=>{
   if(!navigator.storage?.persist){toast('この環境では保存領域の保護要求に対応していません');return;}
   const ok=await navigator.storage.persist().catch(()=>false);
   toast(ok?'保存領域の保護が許可されました（完全保証ではありません）':'保存領域の保護が許可されませんでした。JSONバックアップを利用してください');
 };
 $('reloadApp').onclick=()=>location.reload();
 $('updateBtn').onclick=async()=>{
   if(!('serviceWorker'in navigator)){toast('更新検査に対応していません');return;}
   try {const reg=await navigator.serviceWorker.getRegistration();await reg?.update();toast('更新を確認しました。更新案内が出たら再読み込みしてください');}
   catch{toast('更新確認に失敗しました。通信状況を確認してください');}
 };

 $('sourceNote').textContent='作品情報と端末保存を選択した動画はこの端末のIndexedDBに保存。GitHubへ送信しません。';
 // iOS PWAs do not reliably execute background tasks. This only runs while open.
 setInterval(()=>{if(!document.hidden&&liveSettings.autoSearch&&followNames.length&&Live.IDS.some(p=>liveSettings.api[p]))checkFollowedReleases().catch(()=>{});},30*60*1000);
 $('followBtn').onclick=async()=>{
   const name=clean($('followName').value,80);
   if(!name)return toast('出演者名を入力してください');
   if(!followNames.includes(name))followNames=[...followNames,name].slice(0,100);
   await writeMeta('follows',followNames);$('followName').value='';render();toast('フォローに追加しました');
 };
 $('subtitleFile').addEventListener('change',async ev=>{
   const file=ev.target.files?.[0];if(!file)return;
   if(!/\.vtt$/i.test(file.name)||file.size>3*1024*1024){toast('WebVTT（.vtt・3MB以下）を選択してください');return;}
   if(subtitleObjectURL)URL.revokeObjectURL(subtitleObjectURL);
   subtitleObjectURL=URL.createObjectURL(file);const t=$('subtitleTrack');t.src=subtitleObjectURL;t.hidden=false;t.default=true;try{t.track.mode='showing';}catch{}toast('字幕を読み込みました');
 });
 $('loadSubtitle').onclick=()=>$('subtitleFile').click();
 $('clearMediaBtn').onclick=async()=>{
   const all=await Media.keys(db);if(!confirm(`端末に保存した動画${all.length}件を削除しますか？作品情報は残ります。`))return;
   for(const id of all){await Media.remove(db,id);const u=objUrls.get(id);if(u)URL.revokeObjectURL(u);objUrls.delete(id);volatileFiles.delete(id);const r=records.find(x=>x.id===id);if(r)await saveOne({...r,hasLocalCopy:false});}
   await reload();toast('端末内の動画を削除しました');
 };

 if('serviceWorker'in navigator&&location.protocol==='https:'){
   let controlled=Boolean(navigator.serviceWorker.controller);
   navigator.serviceWorker.addEventListener('controllerchange',()=>{if(controlled)$('updateNotice').hidden=false;controlled=true;});
   navigator.serviceWorker.register('./sw.js').then(reg=>{if(reg.waiting)$('updateNotice').hidden=false;}).catch(()=>{});
 }
}
init().catch(err=>{console.error(err);toast('初期化に失敗しました。プライベートブラウズや空き容量を確認してください。');});
