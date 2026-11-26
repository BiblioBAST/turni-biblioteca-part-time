// Service worker: mostra gli avvisi sul telefono (anche con schermo bloccato)
// e riporta l'utente alla pagina quando tocca la notifica.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Arriva un messaggio dal server: mostra la notifica
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { /* ignora */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Turni biblioteca', {
    body: d.body || '',
    tag: 'turni',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300]
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
