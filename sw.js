const CACHE_NAME = 'voterscan-v1'

const STATIC_ASSETS = [
  '/logo.png',
  '/bg.png',
  '/bgg.png',
  '/notifications.js'
]

// ── HTML pages — always fetch fresh from network
const HTML_PAGES = [
  '/',
  '/qr.html',
  '/index.html',
  '/admin.html',
  '/publish.html',
  '/blink.html',
  '/home.html',
  '/result.html',
]

// ── INSTALL: only cache true static assets (no HTML)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS)
    })
  )
  self.skipWaiting()
})

// ── ACTIVATE: clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// ── FETCH
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // 1. Always network for API calls
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request))
    return
  }

  // 2. Network-first for ALL HTML documents
  //    (catches both explicit HTML paths and document navigations)
  const isHTMLPage = HTML_PAGES.includes(url.pathname)
  const isDocument = event.request.destination === 'document'

  if (isHTMLPage || isDocument) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => {
          // Offline fallback — serve cached version if available
          return caches.match(event.request)
            || caches.match('/qr.html')
        })
    )
    return
  }

  // 3. Cache-first for true static assets (images, JS, fonts, etc.)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        if (
          event.request.method === 'GET' &&
          response &&
          response.status === 200 &&
          response.type !== 'opaque'
        ) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      }).catch(() => {
        if (isDocument) return caches.match('/qr.html')
      })
    })
  )
})