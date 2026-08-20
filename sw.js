/* Shadowing English Service Worker — 离线缓存 */
const CACHE = "shadowing-v3";
const CORE = [
  "./",
  "./index.html",
  "./vocab.html",
  "./library.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.headers.get("range")) return; // 音频/模型的分段请求直接放行（模型由 transformers.js 自己的 Cache API 管理）

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // 同源：网络优先（保证更新），离线回退缓存
    e.respondWith(
      fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match("./index.html"); });
      })
    );
    return;
  }

  // CDN（transformers.js 模块等）：缓存优先，首次联网后即可离线复用
  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (res) {
        try {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        } catch (_) {}
        return res;
      });
    })
  );
});