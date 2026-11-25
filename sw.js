// Service worker per Web Push e notifiche locali.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// La pagina esistente registra già sw.js. Per evitare di sostituire a mano
// l'ampio index.html, il worker aggiunge il client push alle navigazioni HTML.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    const response = await fetch(event.request);
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('text/html')) return response;
    const html = await response.text();
    if (html.includes('push-client.js')) return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    const script = `<script defer src="${new URL('push-client.js', self.registration.scope).href}"></script>`;
    const updated = html.includes('</body>')
      ? html.replace('</body>', `${script}</body>`)
      : `${html}${script}`;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(updated, { status: response.status, statusText: response.statusText, headers });
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Turni in biblioteca', {
    body: data.body || 'Il tuo turno in fila sta per iniziare. Riattiva il cellulare o riapri la pagina.',
    tag: data.tag || 'queue-turn-warning',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300],
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) {
      if ('focus' in client) return client.focus().then(() => client.navigate ? client.navigate(target) : undefined);
    }
    return self.clients.openWindow(target);
  }));
});
