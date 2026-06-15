// ============================================================
// GodHealth Service Worker
// Versie ophogen bij elke nieuwe release om cache te verversen
// ============================================================

const CACHE_NAME = 'godhealth-v1';

const PRECACHE = [
  '/',
  '/index.html',
  '/godhealth-tracker.html',
  '/godhealth-21days.html',
  '/godhealth-meals-plan.html',
  '/godhealth-prayer.html',
  '/godhealth-tribe.html',
  '/godhealth-training.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// Install: cache alle kernbestanden
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: verwijder oude caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first voor API, cache-first voor assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase API calls altijd via netwerk (nooit cachen)
  if (url.hostname.includes('supabase.co')) return;

  // Voor HTML-pagina's: network-first (altijd meest recente versie)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Voor overige assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200) return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return res;
      });
    })
  );
});
