/* Margin service worker — offline shell + Android share target */

/* ⚠️ BUMP THIS ON EVERY DEPLOY.
   Chrome decides whether to update a service worker by byte-comparing this file.
   If sw.js is unchanged, the browser never re-installs it and everyone keeps
   running the previously cached app.js/app.css — a silent stale deploy. Changing
   VERSION changes the bytes, which both triggers the update and names a fresh
   cache, so the old shell is discarded on activate. */
var VERSION = 'margin-v2-2026-08-25';
var SHARE = 'margin-share';
var SHELL = [
  './',
  './index.html',
  './assets/app.css',
  './assets/app.js',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k !== SHARE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function shareUrl() {
  return new URL('shared-file', self.registration.scope).href;
}

/* Lets the page display which build is actually cached, for deploy verification. */
self.addEventListener('message', function (e) {
  if (e.data && e.data.q === 'version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION });
  }
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);

  /* Web Share Target: a file shared from Android lands here as a POST. */
  if (req.method === 'POST' && url.pathname.indexOf('share-target') > -1) {
    e.respondWith((async function () {
      var name = 'shared.md', body = '';
      try {
        var fd = await req.formData();
        var f = fd.get('file') || fd.get('files');
        if (f && typeof f !== 'string') {
          name = f.name || name;
          body = await f.text();
        } else {
          body = fd.get('text') || '';
          name = (fd.get('title') || 'shared') + '.md';
        }
      } catch (err) { /* fall through with empty body */ }
      var c = await caches.open(SHARE);
      await c.put(shareUrl(), new Response(body, {
        headers: { 'content-type': 'text/plain;charset=utf-8', 'x-name': encodeURIComponent(name) }
      }));
      return Response.redirect(new URL('./?share=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;

  /* App shell for navigations, so the app opens with no network. */
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(function (hit) {
        return hit || fetch(req).catch(function () { return caches.match('./'); });
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
