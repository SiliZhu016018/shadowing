/* Shadowing English Service Worker — 缓存策略 v5
 *
 * 设计目标：数据永远新鲜 + 新代码自动生效 + 零手动清缓存
 *  - Supabase 数据与鉴权请求：一律走网络，绝不缓存 → 上传即时可见
 *  - 导航请求（HTML）：不拦截，交给浏览器原生加载 → 避免 Safari 重定向崩溃，且 HTML 永远取最新
 *  - 同源子资源（JS/CSS/图片）：network-first + 离线兜底 → 新代码下次导航自动生效，无需清缓存
 *  - CDN 静态库（jsdelivr 等带版本号）：cache-first → 加速，内容不可变
 */
const CACHE = "shadowing-v5";

// 仅预缓存真正静态、不可变的跨域库。同源页面资源走 network-first，不强缓存。
const CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
];

// Supabase 数据与鉴权请求：绝对不能缓存，否则空列表/旧数据会被永久缓存
function isApiRequest(url) {
  const p = url.pathname;
  // 模型文件（静态不变）：允许缓存
  if (p.indexOf("/whisper-models/") !== -1) return false;
  if (url.hostname.endsWith("supabase.co")) {
    // 数据/鉴权 API：绝不缓存
    if (p.indexOf("/rest/v1/") !== -1
     || p.indexOf("/auth/v1/") !== -1
     || p.indexOf("/realtime/") !== -1
     || p.indexOf("/functions/v1/") !== -1) return true;
    // 存储桶中的非模型文件：也不缓存（用户上传的音频等）
    if (p.indexOf("/storage/v1/") !== -1) return true;
  }
  return false;
}

self.addEventListener("install", function (e) {
  // 新版本立即激活，无需用户关闭标签页
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // CDN 库：尽力而为预缓存，失败不影响安装
      return Promise.allSettled(CDN.map(function (u) {
        return fetch(u).then(function (r) { return c.put(u, r.clone()); }).catch(function () {});
      }));
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        // 清掉旧版本缓存（v4 及以前）
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;
  // 音频/模型的分段请求直接放行（模型由 transformers.js 自己的 Cache API 管理）
  if (req.headers.get("range")) return;

  const url = new URL(req.url);

  // 1) 数据/鉴权 API：永远走网络，绝不缓存
  if (isApiRequest(url)) return;

  // 2) 导航（HTML 页面）：不拦截，交给浏览器原生加载
  //    Cloudflare 已对 HTML 设 no-cache（见 _headers），保证每次都取最新页面
  if (req.mode === "navigate") return;

  // 3) 同源子资源：network-first + 离线兜底
  //    cache: "no-cache" 强制绕过浏览器/边缘缓存，确保拿到最新文件；
  //    网络失败时用 SW 缓存兜底（离线可用）。
  if (url.origin === self.location.origin) {
    e.respondWith(
      (async function () {
        try {
          const res = await fetch(req, { cache: "no-cache" });
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req.url, copy); }).catch(function () {});
          return res;
        } catch (err) {
          const cached = await caches.match(req);
          if (cached) return cached;
          // 连缓存都没有（首次离线访问）：返回空响应避免挂起
          return new Response("", { status: 504, statusText: "offline" });
        }
      })()
    );
    return;
  }

  // 4) 跨域静态库（jsdelivr 等）：cache-first（URL 带版本号，内容不可变）
  e.respondWith(
    caches.match(req).then(function (m) {
      if (m) return m;
      return fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req.url, copy); }).catch(function () {});
        return res;
      }).catch(function () { return m || Response.error(); });
    })
  );
});
