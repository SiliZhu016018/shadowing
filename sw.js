/* Shadowing English Service Worker — 离线缓存 + 导航加速 */
const CACHE = "shadowing-v4";
const CORE = [
  "./",
  "./index.html",
  "./vocab.html",
  "./library.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  // Supabase SDK（CDN）：安装时预缓存，后续页面切换不再走网络
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) {
        // 先缓存核心同源资源（必须成功）
        const local = CORE.filter(function (u) { return u.indexOf("http") !== 0; });
        const cdn = CORE.filter(function (u) { return u.indexOf("http") === 0; });
        return c.addAll(local).then(function () {
          // CDN（Supabase SDK）尽力而为：失败不影响安装
          return Promise.allSettled(cdn.map(function (u) {
            return fetch(u).then(function (r) { return c.put(u, r.clone()); });
          }));
        });
      })
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
    // 🔑 Safari 兼容：导航请求（HTML 页面加载）不拦截
    // Cloudflare Pages 导航可能产生重定向（HTTPS升级/路径规范化等），
    // Safari 对「SW 拦截的导航响应含重定向」会报错：
    //   "Response served by service worker has redirects"
    // 所以导航请求直接走网络，只缓存子资源（JS/CSS/图片/字体）
    if (req.mode === "navigate") return;

    // 同源子资源：缓存优先（stale-while-revalidate）—— 秒开 + 后台静默更新
    // 先立即返回缓存（若有），同时后台 fetch 刷新缓存，保证内容不过期
    e.respondWith(
      caches.match(req).then(function (cached) {
        const network = fetch(req).then(function (res) {
          try { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req.url, copy); }); } catch (_) {}
          return res;
        }).catch(function () { return cached; });
        // 有缓存立即返回（手机端导航不再卡网络）；无缓存等网络
        return cached || network;
      })
    );
    return;
  }

  // CDN（transformers.js 模块等）：缓存优先，首次联网后即可离线复用
  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (res) {
        try { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req.url, copy); }); } catch (_) {}
        return res;
      });
    })
  );
});