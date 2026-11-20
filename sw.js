/* =========================================================
   Service Worker — ₱1,000 Accessible Money Identifier
   Strategy overview
   ---------------------------------------------------------
   • App shell (HTML / CSS / JS)  → network-first, cache fallback
   • ML model + JSON assets       → cache-first (large, static)
   • Fonts, icons, everything else → stale-while-revalidate
   • Navigations fall back to ./index.html, then an offline page
   ========================================================= */

const CACHE_VERSION = "v11";
const CACHE_NAME = `accessible-money-id-${CACHE_VERSION}`;

/* Must exist for the app to boot offline. */
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.png"
];

/* Nice to have — failures here must never block installation. */
const OPTIONAL_ASSETS = [
  "./model/moneyphpbest.onnx",
  "./model/labels.json",
  "./model/speech.json",
  "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"
];

const NAV_FALLBACK = "./index.html";
const CDN_PREFIX = "https://cdn.jsdelivr.net/npm/onnxruntime-web/";

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — Money Identifier</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#05122b; color:#fff; text-align:center; padding:24px;
         font-family:Verdana,Arial,sans-serif; font-weight:700; }
  h1 { font-size:2rem; color:#ffd60a; margin:0 0 16px; }
  p  { font-size:1.3rem; line-height:1.5; margin:0; }
</style>
</head>
<body>
  <main>
    <h1>YOU ARE OFFLINE</h1>
    <p>The money identifier could not load. Check your connection and try again.</p>
  </main>
</body>
</html>`;

/* ---------------- Install ---------------- */
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // allSettled: one bad asset (e.g. a missing model) never blocks install.
    await Promise.allSettled([
      ...CORE_ASSETS.map(asset => cache.add(asset)),
      ...OPTIONAL_ASSETS.map(asset => cache.add(asset))
    ]);

    await self.skipWaiting();
  })());
});

/* ---------------- Activate ---------------- */
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    );

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) {}
    }

    await self.clients.claim();
  })());
});

/* ---------------- Update handshake ---------------- */
self.addEventListener("message", event => {
  const data = event.data;
  const type = typeof data === "string" ? data : data && data.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------------- Fetch routing ---------------- */
self.addEventListener("fetch", event => {
  const { request } = event;

  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // 1. ML model + label/speech data — big, static, cache-first.
  if (url.pathname.includes("/model/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 2. App shell — always try for the freshest version first.
  if (
    request.mode === "navigate" ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "worker"
  ) {
    event.respondWith(networkFirst(event, request));
    return;
  }

  // 3. Everything else (fonts, images) — serve fast, refresh in background.
  event.respondWith(staleWhileRevalidate(event, request));
});

/* ---------------- Strategies ---------------- */

function isCacheable(response) {
  if (!response) return false;
  if (response.status === 206) return false;      // partial content
  return response.ok || response.type === "opaque"; // opaque = cross-origin no-cors
}

async function safePut(cache, request, response) {
  if (!isCacheable(response)) return;
  try {
    await cache.put(request, response);
  } catch (_) {
    /* Quota or unsupported scheme — ignore. */
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;

  try {
    const response = await fetch(request);
    await safePut(cache, request, response.clone());
    return response;
  } catch (_) {
    return Response.error();
  }
}

async function networkFirst(event, request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const preload = event.preloadResponse ? await event.preloadResponse : null;
    const response = preload || await fetch(request);

    await safePut(cache, request, response.clone());
    return response;
  } catch (_) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (request.mode === "navigate") {
      const shell = await cache.match(NAV_FALLBACK);
      if (shell) return shell;

      return new Response(OFFLINE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return Response.error();
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkUpdate = fetch(request)
    .then(async response => {
      const isSameOrigin = request.url.startsWith(self.location.origin);
      const isTrustedCdn = request.url.startsWith(CDN_PREFIX);

      if (isSameOrigin || isTrustedCdn) {
        await safePut(cache, request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Keep the worker alive while the background refresh completes.
  event.waitUntil(networkUpdate);

  if (cached) return cached;

  const fresh = await networkUpdate;
  return fresh || Response.error();
}