// Service Worker cleanup and bypass
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.map(key => caches.delete(key))))
            .then(() => self.registration.unregister())
            .then(() => self.clients.claim())
    );
});

// Pass through all requests directly to the network
self.addEventListener('fetch', () => {
    return;
});
