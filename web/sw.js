// Service worker de RR Piloto: permite instalar la app, abrirla sin conexión
// (con la última versión descargada) y recibir notificaciones.
const CACHE = 'rr-piloto-v1';
const SHELL = ['/', '/campos.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero la red, para que cada despliegue llegue al instante; la caché solo
// responde si no hay conexión. La API y el panel nunca se guardan.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? '/' : e.request)),
  );
});

// Notificaciones push: el envío desde el servidor se configurará más adelante.
// Se espera un JSON { title, body, url }.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'RR Piloto', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
      const w = ws.find((c) => new URL(c.url).origin === location.origin);
      return w ? w.focus().then(() => w.navigate(url)) : self.clients.openWindow(url);
    }),
  );
});
