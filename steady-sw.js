/* =============================================================
   STEADY v3.3.0-block9 Service Worker（物理ファイル・AL011 F1 採用）
   - 旧 Blob URL ベース SW（steady.html L3266-3299）を完全置換
   - 3 HTML（steady-core / steady-game / steady-ear）共通の同一 scope SW
   - precache 上限 50MB 厳守（実測 < 1MB）
   - runtime fetch 戦略：navigation = network-first → cache-fallback
                       static = cache-first → network → cache-store
                       audio sample = stale-while-revalidate（B15a で本格化）
   - localStorage は SW スコープ外（クライアント側）

   precache 実測（本ファイル更新時に AL011 が再検証）：
     steady-core.html       B8 Run 2 後 ~50KB（IIFE 分割で 4,373行 → 1,211行）
     steady-game.html       骨格 ~6KB（B0時点）→ B0-B14 で 2,500行 ≈ 130KB 想定
     steady-ear.html        骨格 ~3KB（B0時点）→ B15a で 500行 ≈ 30KB 想定
     steady-emolab-shared.js ~12KB（B8 Run 2 / T-04 で新設）
     steady-emolab-p1p4.js   ~60KB（B8 Run 2 / T-04 で新設）
     steady-emolab-p5p8.js   ~60KB（B8 Run 2 / T-04 で新設）
     steady-shared.css      ~5KB
     steady-shared.js       ~12KB
     manifest.webmanifest   ~1KB
     vendor/tone.js         ~346KB
     vendor/chart.js        ~204KB
     steady-sw.js           ~6KB（自身は precache 対象外・install 経由でブラウザが保持）
   合計（B8 Run 2 時点）：~750KB ≪ 50MB 上限。Phase 1 完了時点（全 patterns 実装後）でも < 5MB 想定。
   ============================================================= */

'use strict';

// VERSION tag: 'block9-h1'（v3.3.0 phase 0：妖怪 50 体拡張＋週替り＋装備 3-5＋プレステ敵強化＋分解→星＋HP scale・AL007 / 2026-05-07）
const VERSION = 'steady-v3.3.0-block9-h1';
const CACHE_STATIC = VERSION + '-static';
const CACHE_RUNTIME = VERSION + '-runtime';

// DEBUG_FLAG（SW 内ローカル定義・self.STEADY_DEBUG はクライアント側 window と独立）
// production では false。SW デバッグ時のみ手動で true に切替
const STEADY_DEBUG = false;

// precache 対象（HTML 3つ＋shared 系＋vendor＋manifest＋icon）
const PRECACHE_URLS = [
  './',
  './steady-core.html',
  './steady-game.html',
  './steady-ear.html',
  './steady-shared.css',
  './steady-shared.js',
  './steady-game.js',
  './steady-emolab-shared.js',
  './steady-emolab-p1p4.js',
  './steady-emolab-p5p8.js',
  './steady-midi-loops.js',
  './steady-use-log.js',
  './steady-recorder.js',
  './steady-stagnation.js',
  './steady-beat-wheel.js',
  './steady-ear-trainer.js',
  './manifest.webmanifest',
  './steady-icon.svg',
  './404.html',
  './vendor/tone.js',
  './vendor/chart.js'
];

// 旧 cache（v3.0/v3.1/旧 r2 試作）を一掃する prefix
const OLD_CACHE_PREFIXES = ['steady-v3.0', 'steady-v3.1', 'steady-v3.2.0r2-block0', 'steady-v3.2.0r2-block1', 'steady-v3.2.0r2-block2', 'steady-v3.2.0r2-block3', 'steady-v3.2.0r2-block4', 'steady-v3.2.0r2-block5', 'steady-v3.2.0r2-block6', 'steady-v3.2.0r2-block7', 'steady-v3.2.0r2-block8-h1', 'steady-v3.2.0r2-block8-h2', 'steady-v3.2.0r2-block8-h3', 'steady-v3.2.0r2-block8-h4', 'steady-v3.2.0r2-block8-h5', 'steady-v3.2.0r2-block8-h6'];

// -------------------------------------------------------------
// install: 静的 precache
// -------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => {
      // 個別 add で失敗した URL は無視（部分成功 OK）
      return Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) => {
            if (STEADY_DEBUG) console.warn('[sw] precache miss:', url, err.message);
          })
        )
      );
    })
  );
  self.skipWaiting();
});

// -------------------------------------------------------------
// activate: 旧 cache 一掃 + claim
// -------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => {
            // 当バージョン以外で steady- 始まり or OLD_CACHE_PREFIXES に該当するものを削除
            const isCurrent = k === CACHE_STATIC || k === CACHE_RUNTIME;
            if (isCurrent) return Promise.resolve();
            const isOld =
              OLD_CACHE_PREFIXES.some((p) => k.indexOf(p) === 0) ||
              (k.indexOf('steady-') === 0 && k !== CACHE_STATIC && k !== CACHE_RUNTIME);
            if (isOld) return caches.delete(k).catch(() => {});
            return Promise.resolve();
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// -------------------------------------------------------------
// fetch: ルーティング
//   - GET 以外スルー
//   - same-origin のみ介入
//   - navigation: network-first（オフライン時 cache 経由）
//   - static asset: cache-first → network → cache-store
//   - audio sample (steady-ear-samples/*): stale-while-revalidate（B15a で本格化）
// -------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部 origin は介入しない

  // 1. ナビゲーション（HTML ページ遷移）
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // 2. 音声サンプル（B15a で 30-50 ペア・runtime cache）
  if (url.pathname.indexOf('/steady-ear-samples/') !== -1) {
    event.respondWith(staleWhileRevalidate(req, CACHE_RUNTIME));
    return;
  }

  // 3. 静的アセット（precache 対象 or vendor/）
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(req, CACHE_STATIC));
    return;
  }

  // 4. その他（デフォルトは network-first・短期 runtime cache）
  event.respondWith(networkFirstWithRuntime(req, CACHE_RUNTIME));
});

// -------------------------------------------------------------
// 戦略：navigation
// -------------------------------------------------------------
function handleNavigation(req) {
  return fetch(req)
    .then((res) => {
      // 成功したら runtime に保存（オフライン時の救済）
      const clone = res.clone();
      caches.open(CACHE_RUNTIME).then((c) => c.put(req, clone)).catch(() => {});
      return res;
    })
    .catch(() =>
      caches.match(req).then((cached) => {
        if (cached) return cached;
        // UX-12 fallback：404.html を返す（PWA shell 不在時の最終救済）
        return caches.match('./404.html').then((notfound) => {
          if (notfound) return notfound;
          // 404.html すらない場合は core を返す（旧来 shell フォールバック）
          return caches.match('./steady-core.html').then((shell) => {
            return shell || new Response('<h1>STEADY: offline</h1>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          });
        });
      })
    );
}

// -------------------------------------------------------------
// 戦略：cache-first
// -------------------------------------------------------------
function cacheFirst(req, cacheName) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(cacheName).then((c) => c.put(req, clone)).catch(() => {});
      }
      return res;
    });
  });
}

// -------------------------------------------------------------
// 戦略：network-first with runtime cache
// -------------------------------------------------------------
function networkFirstWithRuntime(req, cacheName) {
  return fetch(req)
    .then((res) => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(cacheName).then((c) => c.put(req, clone)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(req));
}

// -------------------------------------------------------------
// 戦略：stale-while-revalidate（B15a 音声サンプル用）
// -------------------------------------------------------------
function staleWhileRevalidate(req, cacheName) {
  return caches.match(req).then((cached) => {
    const fetchPromise = fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(cacheName).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => cached); // network 失敗時は cached（あれば）
    return cached || fetchPromise;
  });
}

// -------------------------------------------------------------
// helper
// -------------------------------------------------------------
function isStaticAsset(pathname) {
  if (pathname.indexOf('/vendor/') !== -1) return true;
  if (pathname.endsWith('.css')) return true;
  if (pathname.endsWith('.js')) return true;
  if (pathname.endsWith('.webmanifest')) return true;
  if (pathname.endsWith('.png') || pathname.endsWith('.jpg') || pathname.endsWith('.svg')) return true;
  if (pathname.endsWith('.html') && PRECACHE_URLS.some((u) => pathname.endsWith(u.replace('./', '/')))) return true;
  return false;
}

// -------------------------------------------------------------
// クライアントからの message（手動 cache cleanup 等）
// -------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'CLEAR_RUNTIME') {
    caches.delete(CACHE_RUNTIME).then(() => {
      event.ports && event.ports[0] && event.ports[0].postMessage({ ok: true });
    });
  } else if (event.data.type === 'PRECACHE_SIZE') {
    // 実測サイズ問い合わせ（AL011 検証用）
    caches.open(CACHE_STATIC).then((c) =>
      c.keys().then((keys) =>
        Promise.all(keys.map((req) => c.match(req).then((res) => res ? res.clone().arrayBuffer() : new ArrayBuffer(0))))
          .then((bufs) => {
            const total = bufs.reduce((sum, b) => sum + b.byteLength, 0);
            event.ports && event.ports[0] && event.ports[0].postMessage({ ok: true, total: total, count: keys.length });
          })
      )
    );
  }
});
