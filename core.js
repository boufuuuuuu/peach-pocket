/* Peach Pocket core: framework-free, safe for local-only execution. */
(function(root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.PeachCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROVIDERS = Object.freeze({local:'端末内',licensed:'許可済みURL',peach:'Peach',missav:'MISSAV',javdb:'JavDB',jable:'Jable'});
  const HOSTS = Object.freeze({missav:['missav.ws','missav.ai'],javdb:['javdb.com'],jable:['jable.tv']});
  const clean = (v, max=300) => String(v ?? '').slice(0, max).trim();
  const norm = v => clean(v, 64).toUpperCase().replace(/[^A-Z0-9]/g, '');
  function isPublicHost(h) {
    h = String(h||'').toLowerCase().replace(/\.$/, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.test')) return false;
    if (/^(\d+\.){3}\d+$/.test(h)) {
      const p=h.split('.').map(Number);
      if (p.some(n=>n>255)) return false;
      return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===192&&p[1]===0||p[0]===198&&p[1]>=18&&p[1]<=19);
    }
    if (h.includes(':') || h.startsWith('[')) return false; // conservative: reject IPv6 literals
    return /^[a-z0-9.-]+$/.test(h) && h.includes('.');
  }
  function safeURL(raw, provider) {
    if (!raw) return '';
    try {
      const u=new URL(clean(raw, 2048));
      if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !isPublicHost(u.hostname)) return '';
      const hosts=HOSTS[provider];
      if (hosts && !hosts.some(h=>u.hostname.toLowerCase()===h || u.hostname.toLowerCase()===`www.${h}`)) return '';
      u.hash='';
      return u.href;
    } catch {return '';}
  }
  function performersFor(src) {
    const p = src.performers ?? src.actors ?? src.actresses ?? src.cast ?? [];
    return (Array.isArray(p)?p:clean(p,400).split(/[,、，]/)).slice(0,25).map(x=>clean(typeof x==='object' ? (x.name||''):x,80)).filter(Boolean);
  }
  function canonical(src={}, genId) {
    if (!src || typeof src !== 'object') throw Error('作品データが不正です');
    const provider=Object.prototype.hasOwnProperty.call(PROVIDERS, src.provider) ? src.provider : 'local';
    const duration=Number(src.duration) || 0;
    const lastPosition=Number(src.lastPosition ?? src.last_position ?? 0)||0;
    const makeId=genId || (()=>globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return {
      id:clean(src.id,90)||makeId(),title:clean(src.title || src.name || src.video_title)||'名称未設定',
      code:clean(src.code || src.product_code || src.number || '',64), performers:performersFor(src),provider,
      referenceURL:safeURL(src.referenceURL||src.reference_url||src.url||'',provider),
      coverURL:safeURL(src.coverURL||src.cover_url||src.poster||'','licensed'),
      // Catalog rights are a claim from the explicitly configured source;
      // verify the allowed media origin again immediately before each play.
      rightsConfirmed:src.rightsConfirmed===true,
      playbackURL:src.rightsConfirmed===true?safeURL(src.playbackURL||'','licensed'):'',
      publishedAt:/^\d{4}-\d{2}-\d{2}$/.test(String(src.publishedAt||''))?src.publishedAt:'',

      isFavorite:Boolean(src.isFavorite ?? src.favorite ?? false), isWatched:Boolean(src.isWatched ?? src.watched ?? false),
      lastPosition:Math.max(0,Math.min(1e10,Number.isFinite(lastPosition)?lastPosition:0)),
      duration:Math.max(0,Math.min(1e10,Number.isFinite(duration)?duration:0)),
      progressPercent:Math.min(100,Math.max(0,Number(src.progressPercent ?? src.progress ?? 0)||0)),
      updatedAt: /^\d{4}-\d\d-\d\dT/.test(String(src.updatedAt||''))?clean(src.updatedAt,40):new Date().toISOString(),
      needsFile:Boolean(src.needsFile || provider==='local'),
      hasLocalCopy:Boolean(src.hasLocalCopy),
      fileFingerprint:/^sha256-sampled-v1:[a-f0-9]{64}:[0-9]{1,13}$/.test(String(src.fileFingerprint||''))?src.fileFingerprint:'',
      watchCount:Math.max(0,Math.min(1000000,Number(src.watchCount)||0)),
      watchedSeconds:Math.max(0,Math.min(1e10,Number(src.watchedSeconds)||0)),
      lastPlayedAt:/^\d{4}-\d\d-\d\dT/.test(String(src.lastPlayedAt||''))?clean(src.lastPlayedAt,40):''
    };
  }
  function duplicateGroups(items) {
    const groups = new Map();
    for (const r of items) {
      const id=norm(r.code);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id,[]);
      groups.get(id).push(r);
    }
    return [...groups.entries()].filter(([,g])=>g.length>1).sort((a,b)=>b[1].length-a[1].length);
  }
  function crossProviderGroups(items) {return duplicateGroups(items).filter(([,g]) => new Set(g.map(r=>r.provider)).size>1);}
  function fileDuplicateGroups(items) {
    const groups=new Map();
    for(const row of items){
      if(row.provider!=='local'||!/^sha256-sampled-v1:[a-f0-9]{64}:[0-9]{1,13}$/.test(row.fileFingerprint||''))continue;
      if(!groups.has(row.fileFingerprint))groups.set(row.fileFingerprint,[]);
      groups.get(row.fileFingerprint).push(row);
    }
    return [...groups.values()].filter(rows=>rows.length>1).sort((a,b)=>b.length-a.length);
  }

  function importRows(raw, existing, genId) {
    const rows=Array.isArray(raw)?raw:(raw?.items ?? raw?.works ?? raw?.records ?? null);
    if (!Array.isArray(rows) || rows.length>10000) throw Error('作品配列（最大10,000件）が必要です');
    const merged=new Map(existing.map(r=>[r.id,r]));
    const bySource=new Map(existing.filter(r=>norm(r.code)).map(r=>[`${r.provider}:${norm(r.code)}`,r.id]));
    let imported=0;
    for (const entry of rows) {
      if (!entry || typeof entry!=='object'||Array.isArray(entry))continue;
      const rawTitle=entry.title||entry.name||entry.video_title;
      if (!rawTitle && !(entry.code||entry.product_code||entry.number))continue;
      const next=canonical(entry,genId),key=norm(next.code)?`${next.provider}:${norm(next.code)}`:'';
      const oldId=key&&bySource.get(key);
      if (oldId) {
        const old=merged.get(oldId);
        merged.set(oldId,{...old,title:next.title==='名称未設定'?old.title:next.title,performers:next.performers.length?next.performers:old.performers,referenceURL:next.referenceURL||old.referenceURL,updatedAt:new Date().toISOString()});
      } else {
        if (merged.has(next.id)) next.id=(genId||(()=>`import-${Math.random()}`))();
        merged.set(next.id,next);
        if(key)bySource.set(key,next.id);
      }
      imported++;
    }
    return {items:[...merged.values()],imported};
  }
  return {PROVIDERS,HOSTS,clean,norm,safeURL,canonical,duplicateGroups,crossProviderGroups,fileDuplicateGroups,importRows,isPublicHost};
});
