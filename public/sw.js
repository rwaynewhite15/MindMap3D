/* MindMapShare service worker — Web Push delivery.
   Its only job is to show OS notifications for chat/comment alerts pushed by the
   server and to focus (or open) the app on the right map when one is clicked. */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* keep {} */ }
  const title = data.title || 'MindMapShare';
  const options = {
    body: data.body || '',
    tag: data.tag || 'mindmapshare',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  };
  // Some browsers reject showNotification without an icon that resolves; the
  // icon fields degrade gracefully if the asset is missing.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      // Reuse an already-open app tab: point it at the target and focus it.
      if ('focus' in client) {
        try { if ('navigate' in client) await client.navigate(url); } catch { /* cross-origin guard */ }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
