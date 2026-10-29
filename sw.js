const CACHE='momoiki-pwa-v1.10.14';
const ASSETS=['./','./index.html','./styles.css','./app.js','./backup.js','./core.js','./media-store.js','./stats.js','./provider-live.js','./catalog-model.js','./catalog-import.js','./catalog-harvest.js','./missav-compat.js','./library-health.js','./full-backup.js','./cloud-sync.js','./external-history.js','./media-download.js','./hls-support.js','./playback-session.js','./playback-route-diagnostics.js','./javinfo.js','./api-key-vault.js','./stream-diagnostics.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./sample.mp4'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('momoiki-pwa-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch', e => {
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  // Offline demo: satisfy byte-range requests. Safari may issue Range: bytes=0-1.
  if(url.href===new URL('./sample.mp4',self.location.href).href){
    e.respondWith((async()=>{
      const cached=await caches.match('./sample.mp4');
      if(!cached)return fetch(e.request);
      const range=e.request.headers.get('range');
      if(!range)return cached;
      const match=/^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if(!match)return new Response(null,{status:416,headers:{'Accept-Ranges':'bytes'}});
      const data=await cached.arrayBuffer(),size=data.byteLength;
      let first=match[1]===''?Math.max(0,size-Number(match[2])):Number(match[1]);
      let last=match[1]===''?size-1:(match[2]===''?size-1:Math.min(size-1,Number(match[2])));
      if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first>=size||last<first)
        return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`,'Accept-Ranges':'bytes'}});
      const bytes=data.slice(first,last+1);
      const headers=new Headers(cached.headers);
      headers.set('Content-Type','video/mp4');
      headers.set('Content-Range',`bytes ${first}-${last}/${size}`);
      headers.set('Accept-Ranges','bytes');
      headers.set('Content-Length',String(bytes.byteLength));
      return new Response(bytes,{status:206,headers});
    })());
    return;
  }
  // Navigation uses network first: updates arrive promptly; offline retains the shell.
  if(e.request.mode==='navigate') {
    e.respondWith(fetch(e.request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put('./index.html',copy)).catch(()=>{});}
      return response;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
});
