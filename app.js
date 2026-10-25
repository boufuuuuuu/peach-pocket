'use strict';
// All library records remain in this browser's IndexedDB; video files are NEVER uploaded.
const {PROVIDERS,clean,norm,safeURL,canonical,duplicateGroups,crossProviderGroups,fileDuplicateGroups,importRows} = PeachCore;
const {encrypt, decrypt, isEncrypted, passOK} = PeachBackup;
const Media = PeachMedia;
const Live = PeachLive;
const Catalog = PeachCatalog;
const DATABASE='peach-pocket-db1';
const $=id=>document.getElementById(id);
const objUrls=new Map();
const thumbnailURLs=new Map();
const thumbnailJobs=new Map();
const thumbnailFailed=new Set();
let db,records=[],activeId=null,currentId=null,selectedFileItem=null,lastSavedAt=0,loading=false,installation=null;
let lastRecordedPosition=null, followNames=[], subtitleObjectURL=null, playingUrl=null;
let liveSettings={api:{missav:'',javdb:'',jable:'',ro85:''},mediaOrigins:[],coverOrigins:[],autoSearch:true};
let liveCatalogRows=[],autoSearchTimer=null,followCheckBusy=false;
let liveSearchRun=0;
const uid=()=>globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const elem=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n;};
function toast(message){const n=$('toast');n.textContent=message;n.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>n.classList.remove('show'),3400);}
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DATABASE,4);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('items'))req.result.createObjectStore('items',{keyPath:'id'});if(!req.result.objectStoreNames.contains('meta'))req.result.createObjectStore('meta',{keyPath:'key'});if(!req.result.objectStoreNames.contains('media'))req.result.createObjectStore('media',{keyPath:'id'});if(!req.result.objectStoreNames.contains('thumbnails'))req.result.createObjectStore('thumbnails',{keyPath:'id'});};req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
function readMeta(key){return new Promise((resolve,reject)=>{const req=db.transaction('meta').objectStore('meta').get(key);req.onsuccess=()=>resolve(req.result?.value);req.onerror=()=>reject(req.error);});}
function writeMeta(key,value){return new Promise((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put({key,value});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
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
 if(!url)return null;try{if(!liveSettings.coverOrigins.includes(new URL(url).origin))return null;}catch{return null;}
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
 } else actions.append(elem('small','','本編の直接再生：許可済み配信元なし'));
 card.append(actions);
 const links=elem('div','live-result-actions');for(const source of group.sources){
  if(!source.referenceURL)continue;
  const a=elem('a','',`${PROVIDERS[source.provider]}の元ページ`);a.href=source.referenceURL;a.target='_blank';a.rel='noopener noreferrer';a.referrerPolicy='no-referrer';links.append(a);
 }card.append(links);return card;
}
function renderLiveGroups(){
 const box=$('liveResults');box.replaceChildren();
 const groups=Catalog.aggregate(liveCatalogRows,records);
 for(const group of groups)box.append(renderLiveGroup(group));
 if(!groups.length)box.append(elem('p','note','一致作品なし。利用可能な検索APIがない場合は外部検索リンクを利用してください。'));
 $('liveCount').textContent=`統合作品 ${groups.length} 件 / 登録元 ${liveCatalogRows.length} 件`;
 return groups;
}
async function runLiveSearch(queryOverride=null,{quiet=false}={}){
 const q=typeof queryOverride==='string'?queryOverride.trim():$('search').value.trim();
 if(q.length<2){if(!quiet)toast('検索語は2文字以上入力してください');return [];} // no automatic empty-term harvest
 const button=$('liveSearchBtn'),status=$('liveStatus');
 const providers=Live.IDS.filter(p=>liveSettings.api[p]);
 if(!providers.length){if(!quiet)status.textContent='検索APIは未設定です。外部4サイトの作品を直接読み取ることはできません。';return [];}
 const run=++liveSearchRun;button.disabled=true;if(!quiet)status.textContent=`${providers.length}件の許可済みカタログを照会中…`;
 try{
  const outcomes=await Promise.all(providers.map(async provider=>{
   try{return {provider,rows:await Live.search(provider,q,liveSettings.api[provider],liveSettings.mediaOrigins,fetch,liveSettings.coverOrigins)};}
   catch(err){return {provider,error:err.message};}
  }));
  if(run!==liveSearchRun)return [];
  const rows=outcomes.flatMap(x=>x.rows||[]);
  const errors=outcomes.filter(x=>x.error).map(x=>`${PROVIDERS[x.provider]}: ${x.error}`);
  if(!quiet){liveCatalogRows=rows;const groups=renderLiveGroups();status.textContent=`${groups.length}作品を統合${errors.length?' / 接続失敗: '+errors.join(' | '):''}。未認可のサイトからの自動取得は行いません。`;}
  return rows;
 }finally{if(run===liveSearchRun)button.disabled=false;}
}
function scheduleAutoSearch(){
 clearTimeout(autoSearchTimer);
 if(!liveSettings.autoSearch||!Live.IDS.some(x=>liveSettings.api[x]))return;
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
function readAll(){return new Promise((resolve,reject)=>{const req=db.transaction('items').objectStore('items').getAll();req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});}
function writeAll(next){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite'),store=tx.objectStore('items');for(const item of next)store.put(item);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function saveOne(item){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite');tx.objectStore('items').put(item);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
function deleteOne(id){return new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite');tx.objectStore('items').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
async function reload(){records=(await readAll()).map(row=>canonical(row,uid)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));render();}
async function store(item){const r=canonical({...item,updatedAt:new Date().toISOString()},uid);await saveOne(r);await reload();}
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
function allVisible(){const q=$('search').value.trim().toLowerCase(),codeQ=norm(q),provider=$('provider').value;return records.filter(r=>(!provider||r.provider===provider)&&(!q||[r.title,r.code,...r.performers].join(' ').toLowerCase().includes(q)||(codeQ&&norm(r.code).includes(codeQ))));}
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
 if(record.provider!=='local')return;
 const img=elem('img','cover-image');img.alt=`${record.title} の動画サムネイル`;img.loading='lazy';
 thumbnailURLFor(record).then(url=>{if(url && cover.isConnected){img.src=url;cover.prepend(img);}}).catch(()=>{});
}
function renderCards(id,list){const parent=$(id);parent.replaceChildren();if(!list.length){const none=elem('div','empty','作品がありません。右上の＋で登録、または「動画を追加」から始められます。');parent.append(none);return;}
 for(const r of list){const card=elem('article','item');const cover=elem('div','cover');const thumb=imageFor(r.coverURL,r.title);if(thumb)cover.append(thumb);else cover.append(elem('span','film','▶'));bindThumbnail(cover,r);cover.append(elem('span','provider',PROVIDERS[r.provider]));card.append(cover);const body=elem('div','item-body');body.append(elem('div','item-title',r.title),elem('div','code',r.code||r.performers.join('・')||'作品情報'));
 const bar=elem('div','progress');const fill=elem('div');fill.style.width=`${Math.min(100,r.duration?Math.max(0,r.lastPosition/r.duration*100):r.progressPercent)}%`;bar.append(fill);body.append(bar);
 const controls=elem('div','controls');const action=elem('button','play',r.provider==='local'?(r.hasLocalCopy?'▶ 保存動画を再生':objUrls.has(r.id)?'▶ 再生':'動画を選ぶ'):r.provider==='licensed'||Catalog.safePlayable(r,liveSettings.mediaOrigins)?'▶ アプリ内で再生':'参照ページ');action.addEventListener('click',()=>start(r));const fav=elem('button',`heart${r.isFavorite?' on':''}`,r.isFavorite?'♥ 保存済み':'♡ 保存');fav.addEventListener('click',()=>syncGroupState(r,{isFavorite:!r.isFavorite}).catch(e=>toast(e.message)));controls.append(action,fav);body.append(controls);
 const small=elem('div','secondary-controls');const edit=elem('button','', '編集');edit.addEventListener('click',()=>editItem(r));const watched=elem('button','',r.isWatched?'未視聴へ':'視聴済み');watched.addEventListener('click',()=>syncGroupState(r,{isWatched:!r.isWatched}).catch(e=>toast(e.message)));small.append(edit,watched);body.append(small);card.append(body);parent.append(card);
 }}
function render(){const rows=allVisible();$('count').textContent=`${rows.length} 件`;renderCards('library',rows);renderCards('favorites',rows.filter(r=>r.isFavorite));renderCards('continues',rows.filter(r=>r.lastPosition>0&&!r.isWatched));const d=duplicateGroups(rows),fdups=fileDuplicateGroups(rows);$('duplicateCount').textContent=`同じ品番 ${d.length}組 / 同一動画候補 ${fdups.length}組 / 複数提供元 ${crossProviderGroups(rows).length}組`;
 const area=$('duplicates');area.replaceChildren();if(!d.length&&!fdups.length)area.append(elem('p','note','重複候補はまだありません。'));
 for(const group of fdups){const n=elem('div','duplicate-row');n.append(elem('strong','','動画内容が一致する可能性'),elem('span','',group.map(x=>x.title).join(' / ')));area.append(n);}
 const stats=PeachStats.compute(records);$('statsSummary').textContent=`保存動画 ${records.filter(x=>x.hasLocalCopy).length}本 · 視聴済み ${stats.watched}件 · お気に入り ${stats.favorites}件 · 再生回数 ${stats.plays}回 · 累計 ${stats.watchHours}時間`;
 const followed=records.filter(r=>r.performers.some(n=>followNames.includes(n)));
 $('followedWorks').replaceChildren();for(const r of followed.slice(0,15)){$('followedWorks').append(elem('div','following-result',`${r.code||r.title} · ${r.performers.filter(n=>followNames.includes(n)).join('・')}`));}
 if(!followed.length)$('followedWorks').append(elem('p','note','フォロー中の出演者に一致する登録作品はまだありません（自動ネット取得ではありません）。'));
 $('followList').replaceChildren();for(const name of followNames){const n=elem('div','follow-row');n.append(elem('span','',name));const b=elem('button','','解除');b.onclick=async()=>{followNames=followNames.filter(x=>x!==name);await writeMeta('follows',followNames);render()};n.append(b);$('followList').append(n);}
 for(const [key,group] of d.slice(0,30)){const n=elem('div','duplicate-row');n.append(elem('strong','',key),elem('span','',group.map(x=>PROVIDERS[x.provider]).join(' · ')));area.append(n);}
}
function setView(name){for(const id of ['home','favorites','continue','duplicates','settings'])$(id+'View').hidden=id!==name;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('searchPanel').hidden=name==='settings';}
function editItem(item){activeId=item?.id||null;const f=$('editForm');f.reset();$('dialogTitle').textContent=item?'作品を編集':'作品を追加';if(item){for(const field of ['title','code','provider','referenceURL'])f.elements[field].value=item[field]||'';f.elements.performers.value=item.performers.join('、');}$('deleteBtn').hidden=!item;$('editDialog').showModal();}
async function start(item){
 currentId=item.id;
 if(item.provider==='local'){
   try{
     if(item.hasLocalCopy){const stored=await Media.get(db,item.id);if(stored?.blob){const url=URL.createObjectURL(stored.blob);playingUrl=url;return play(item,url);}}
     if(objUrls.has(item.id))return play(item,objUrls.get(item.id));
   }catch(e){toast(`保存済み動画を開けません: ${e.message}`);}
   selectedFileItem=item.id;$('videoFile').value='';$('videoFile').click();return;
 }
 const stream=Catalog.safePlayable(item,liveSettings.mediaOrigins);
 if(stream){play(item,stream);return;}
 if(item.provider==='licensed'&&item.referenceURL){
  try{const url=new URL(item.referenceURL);
    if(liveSettings.mediaOrigins.includes(url.origin)&&/\.(mp4|m4v|mov|webm|m3u8)$/i.test(url.pathname)){play(item,url.href);return;}
  }catch{}
  toast('許可済み動画URLではないため、元ページを開きます');window.open(item.referenceURL,'_blank','noopener,noreferrer');return;
 }
 if(item.referenceURL){window.open(item.referenceURL,'_blank','noopener,noreferrer');return;}
 toast('参照URLを登録してください');
}
function play(item,url){const now=new Date().toISOString();store({...item,watchCount:item.watchCount+1,lastPlayedAt:now}).catch(()=>{});const video=$('player');video.pause();video.removeAttribute('src');video.load();currentId=item.id;lastRecordedPosition=null;video.src=url;$('playerTitle').textContent=item.title;$('playerHelp').textContent=item.provider==='local'?'動画はサーバーへ送信されません。端末に保存した動画は再起動後も再生できますが、iOS側の容量制限・削除対象となります。':'配信元がブラウザ再生を許可し、iPhoneが形式に対応する場合のみ再生できます。';$('playerDialog').showModal();video.addEventListener('loadedmetadata',function loaded(){video.removeEventListener('loadedmetadata',loaded);if(item.lastPosition>1&&video.duration>item.lastPosition+5)video.currentTime=item.lastPosition;},{once:true});video.play().catch(()=>toast('再生ボタンを押してください'));}
async function savePosition(){if(loading||!currentId)return;const video=$('player'),time=Number(video.currentTime);if(!Number.isFinite(time)||time<0)return;const record=records.find(r=>r.id===currentId);if(!record)return;const length=Number.isFinite(video.duration)?video.duration:record.duration;
 const delta=lastRecordedPosition===null?0:time-lastRecordedPosition;
 lastRecordedPosition=time;
 const updated=canonical({...record,lastPosition:time,duration:length,
 watchedSeconds:record.watchedSeconds+(delta>0&&delta<=30?delta:0),
 progressPercent:length?Math.floor(100*time/length):record.progressPercent,
 isWatched:record.isWatched||(length>0&&time/length>=.95),updatedAt:new Date().toISOString()},uid);const siblings=Catalog.linkedStateUpdates(updated,records,{lastPosition:updated.lastPosition,duration:updated.duration,progressPercent:updated.progressPercent,isWatched:updated.isWatched}).filter(r=>r.id!==updated.id);
 await writeAll([updated,...siblings]);const i=records.findIndex(r=>r.id===currentId);if(i>=0)records[i]=updated;for(const sibling of siblings){const j=records.findIndex(r=>r.id===sibling.id);if(j>=0)records[j]=sibling;}}
async function closeVideo(){const video=$('player');video.pause();try{await savePosition();}catch(err){toast('再生位置を保存できませんでした');}video.removeAttribute('src');video.load();if(playingUrl){URL.revokeObjectURL(playingUrl);playingUrl=null;}if(subtitleObjectURL){URL.revokeObjectURL(subtitleObjectURL);subtitleObjectURL=null;}const tr=$('subtitleTrack');tr.removeAttribute('src');tr.hidden=true;lastRecordedPosition=null;currentId=null;if($('playerDialog').open)$('playerDialog').close();render();}
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
  await writeAll(result.items);await reload();toast(`${result.imported}件の作品を読み込みました`);
}

async function init(){db=await openDB();await initDevice();await initLiveSettings();await reload();await backfillLegacyFingerprints();$('addBtn').onclick=()=>editItem();$('addVideoBtn').onclick=()=>{selectedFileItem=null;$('videoFile').value='';$('videoFile').click();};$('search').oninput=()=>{render();renderSiteLinks();scheduleAutoSearch();};$('liveSearchBtn').onclick=()=>runLiveSearch().catch(e=>toast('ライブ検索失敗: '+e.message));$('saveLiveSettings').onclick=()=>saveLiveSettings().catch(e=>toast('設定保存失敗: '+e.message));$('checkFollows').onclick=checkFollowedReleases;$('provider').onchange=render;document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
 $('editForm').addEventListener('submit',async ev=>{ev.preventDefault();const f=ev.currentTarget,provider=f.elements.provider.value,url=f.elements.referenceURL.value.trim();if(url&&!safeURL(url,provider)){toast('提供元に合うHTTPS URLを登録してください');return;}
 try{await store({...records.find(r=>r.id===activeId),id:activeId||uid(),title:f.elements.title.value,code:f.elements.code.value,performers:f.elements.performers.value,provider,referenceURL:url});$('editDialog').close();toast('保存しました');}catch(e){toast(`保存エラー: ${e.message}`);}});
 $('deleteBtn').onclick=async()=>{if(!activeId||!confirm('この作品情報を削除しますか？'))return;try{await Media.removeWithRecord(db,activeId);}catch(err){toast(`作品を削除できません: ${err.message}`);return;}const tu=thumbnailURLs.get(activeId);if(tu){URL.revokeObjectURL(tu);thumbnailURLs.delete(activeId);}thumbnailFailed.delete(activeId);const u=objUrls.get(activeId);if(u)URL.revokeObjectURL(u);objUrls.delete(activeId);$('editDialog').close();await reload();toast('登録を削除しました');};
 $('videoFile').addEventListener('change',async ev=>{try{await importVideoBatch(ev.target.files);}catch(err){toast(`動画の読込に失敗: ${err.message}`);}finally{ev.target.value='';}});
 $('saveDeviceLabel').onclick=async()=>{
   const label=clean($('deviceLabel').value,35)||'自分のiPhone';
   installation={...installation,label};await writeMeta('installation',installation);$('deviceLabel').value=label;toast('端末名を保存しました。他の端末には送信されません');
 };
 $('exportBtn').onclick=exportEncrypted;$('importBtn').onclick=()=>$('backupFile').click();$('backupFile').addEventListener('change',async ev=>{try{if(ev.target.files?.[0])await importJSON(ev.target.files[0]);}catch(err){toast(`取込失敗: ${err.message}`);}finally{ev.target.value='';$('backupPassword').value='';}});
 $('playerClose').onclick=()=>closeVideo();$('playerDialog').addEventListener('cancel',ev=>{ev.preventDefault();closeVideo();});$('playerDialog').addEventListener('close',()=>{$('player').pause();});
 $('rewind').onclick=()=>{$('player').currentTime=Math.max(0,($('player').currentTime||0)-10);};$('forward').onclick=()=>{$('player').currentTime=Math.min(Number.isFinite($('player').duration)?$('player').duration:Infinity,($('player').currentTime||0)+10);};
 const speedValues=[1,1.25,1.5,2,0.75];$('speed').onclick=()=>{const video=$('player'),i=speedValues.indexOf(video.playbackRate);video.playbackRate=speedValues[(i+1)%speedValues.length];$('speed').textContent=`${video.playbackRate}倍`;};
 $('fullScreen').onclick=()=>{const video=$('player');if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();else video.requestFullscreen?.();};
 $('pip').onclick=async()=>{const video=$('player');try{if(video.webkitSetPresentationMode){video.webkitSetPresentationMode('picture-in-picture');}else if(document.pictureInPictureEnabled)await video.requestPictureInPicture();else toast('この環境ではPiPを使えません');}catch{toast('PiPを開始できませんでした');}};
 $('player').addEventListener('timeupdate',()=>{if(Date.now()-lastSavedAt>8000){lastSavedAt=Date.now();savePosition().catch(()=>{});}});$('player').addEventListener('pause',()=>savePosition().catch(()=>{}));$('player').addEventListener('ended',()=>savePosition().then(render).catch(()=>{}));$('player').addEventListener('error',()=>{if($('player').src)toast('この動画を再生できません。形式や配信元の許可をご確認ください');});
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
   for(const id of all){await Media.remove(db,id);const u=objUrls.get(id);if(u)URL.revokeObjectURL(u);objUrls.delete(id);const r=records.find(x=>x.id===id);if(r)await saveOne({...r,hasLocalCopy:false});}
   await reload();toast('端末内の動画を削除しました');
 };

 if('serviceWorker'in navigator&&location.protocol==='https:'){
   let controlled=Boolean(navigator.serviceWorker.controller);
   navigator.serviceWorker.addEventListener('controllerchange',()=>{if(controlled)$('updateNotice').hidden=false;controlled=true;});
   navigator.serviceWorker.register('./sw.js').then(reg=>{if(reg.waiting)$('updateNotice').hidden=false;}).catch(()=>{});
 }
}
init().catch(err=>{console.error(err);toast('初期化に失敗しました。プライベートブラウズや空き容量を確認してください。');});
