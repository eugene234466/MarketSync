const CACHE_NAME = 'marketsync-v3';
const STATIC_ASSETS = [
    '/static/css/style.css',
    '/static/js/main.js',
    '/static/images/logo.png',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

// Install — cache static assets only
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate — clean old caches immediately
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch — bypass cache for all page navigations and non-static assets
self.addEventListener('fetch', event => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // Never cache page navigations or auth routes (login, logout, register, etc.)
    if (event.request.mode === 'navigate') return;

    const url = new URL(event.request.url);

    // Only cache static resources (CSS, JS, images, CDN fonts/libraries)
    const isStatic = url.pathname.startsWith('/static/') ||
                     url.hostname.includes('cdn.jsdelivr.net') ||
                     url.hostname.includes('cdnjs.cloudflare.com') ||
                     url.hostname.includes('fonts.googleapis.com') ||
                     url.hostname.includes('fonts.gstatic.com');

    if (!isStatic) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            });
        }).catch(() => fetch(event.request))
    );
});