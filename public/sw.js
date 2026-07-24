// Exists only to satisfy Chrome's desktop install criterion. No caching: the server
// is always local, so a cache could only ever serve stale vault data.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
