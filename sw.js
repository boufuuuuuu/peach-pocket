const CACHE='momoiki-pwa-v1.10.5';
const ASSETS=['./','./index.html','./styles.css','./app.js','./backup.js','./core.js','./media-store.js','./stats.js','./provider-live.js','./catalog-model.js','./catalog-import.js','./catalog-harvest.js','./missav-compat.js','./library-health.js','./full-backup.js','./cloud-sync.js','./external-history.js','./media-download.js','./hls-support.js','./playback-session.js','./javinfo.js','./api-key-vault.js','./stream-diagnostics.js','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch', e => {
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
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
