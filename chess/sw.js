/* チェスのページだけの Service Worker: 同じサイトから届くページとファイルに、複数スレッドで共有メモリを使うための見出し
 *   Cross-Origin-Opener-Policy: same-origin / Cross-Origin-Embedder-Policy: credentialless
 * を足す（公開先の GitHub Pages は見出しを変えられないため。serve.py で開いたときと同じになる）。
 * 何も保存しない（キャッシュしない）。ほかのサイトへの通信（フォント・オンラインの部品）はそのまま通す
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(() => fetch(req)));
});
