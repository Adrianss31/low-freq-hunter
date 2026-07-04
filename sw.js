// Service worker: cache dell'app shell per uso offline / PWA installata.
// Alza CACHE_VERSION a ogni deploy per invalidare la cache.
'use strict';

const CACHE_VERSION = 'lfh-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/config.js',
  './js/db.js',
  './js/audio.js',
  './js/ui.js',
  './js/live.js',
  './js/night.js',
  './js/nightui.js',
  './js/sessions.js',
  './js/report.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first con fallback alla cache: aggiornamenti immediati quando c'è
// rete, funzionamento pieno quando non c'è.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
