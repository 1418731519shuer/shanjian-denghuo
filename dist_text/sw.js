// 自动生成，请勿手改 —— python tools/build.py
const CACHE = 'wenyou-1786105873';
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./ai_gen.js",
  "./assets/manifest.json",
  "./assets/bg/bamboo.webp",
  "./assets/bg/bamboo_night.webp",
  "./assets/bg/bridge_sunset.webp",
  "./assets/bg/cafe_afternoon.webp",
  "./assets/bg/cafe_rainy.webp",
  "./assets/bg/city_lights.webp",
  "./assets/bg/ferry_night.webp",
  "./assets/bg/festival_night.webp",
  "./assets/bg/lantern_shop.webp",
  "./assets/bg/law_firm_dusk.webp",
  "./assets/bg/law_firm_office.webp",
  "./assets/bg/restaurant_evening.webp",
  "./assets/bg/street_night.webp",
  "./assets/bg/taxi_night.webp",
  "./assets/bg/teashelter.webp",
  "./assets/bg/teashelter_night.webp",
  "./assets/bg/town_day.webp",
  "./assets/bgm/bamboo_wind.mp3",
  "./assets/bgm/ending.mp3",
  "./assets/bgm/festival.mp3",
  "./assets/bgm/rain_night.mp3",
  "./assets/bgm/shop_warm.mp3",
  "./assets/bgm/teashelter.mp3",
  "./assets/bgm/tense.mp3",
  "./assets/bgm/town_day.mp3",
  "./assets/cg/sword_light.webp",
  "./assets/cg/teacup.webp",
  "./assets/chars/mo_angry.webp",
  "./assets/chars/mo_normal.webp",
  "./assets/chars/mo_sad.webp",
  "./assets/chars/mo_shy.webp",
  "./assets/chars/mo_smile.webp",
  "./assets/chars/mo_surprise.webp",
  "./assets/chars/shen_angry.chroma.webp",
  "./assets/chars/shen_angry.webp",
  "./assets/chars/shen_normal.chroma.webp",
  "./assets/chars/shen_normal.webp",
  "./assets/chars/shen_sad.chroma.webp",
  "./assets/chars/shen_sad.webp",
  "./assets/chars/shen_smile.chroma.webp",
  "./assets/chars/shen_smile.webp",
  "./assets/chars/shen_surprise.chroma.webp",
  "./assets/chars/shen_surprise.webp",
  "./assets/chars/su_angry.chroma.webp",
  "./assets/chars/su_angry.webp",
  "./assets/chars/su_normal.chroma.webp",
  "./assets/chars/su_normal.webp",
  "./assets/chars/su_sad.chroma.webp",
  "./assets/chars/su_sad.webp",
  "./assets/chars/su_smile.chroma.webp",
  "./assets/chars/su_smile.webp",
  "./assets/chars/su_surprise.chroma.webp",
  "./assets/chars/su_surprise.webp",
  "./assets/chars/tang_angry.chroma.webp",
  "./assets/chars/tang_angry.webp",
  "./assets/chars/tang_normal.chroma.webp",
  "./assets/chars/tang_normal.webp",
  "./assets/chars/tang_sad.chroma.webp",
  "./assets/chars/tang_sad.webp",
  "./assets/chars/tang_smile.chroma.webp",
  "./assets/chars/tang_smile.webp",
  "./assets/chars/tang_surprise.chroma.webp",
  "./assets/chars/tang_surprise.webp",
  "./assets/chars/wan_angry.webp",
  "./assets/chars/wan_normal.webp",
  "./assets/chars/wan_sad.webp",
  "./assets/chars/wan_smile.webp",
  "./assets/chars/wan_surprise.webp",
  "./assets/sfx/bamboo_rustle.wav",
  "./assets/sfx/boat_creak.wav",
  "./assets/sfx/crowd_cheer.wav",
  "./assets/sfx/door.wav",
  "./assets/sfx/footsteps.wav",
  "./assets/sfx/market_noise.wav",
  "./assets/sfx/paper.wav",
  "./assets/sfx/rain_loop.wav",
  "./assets/sfx/rain_on_roof.wav",
  "./assets/sfx/sword_whoosh.wav",
  "./assets/sfx/wind_chime.wav"
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  /* 导航请求（index.html）：网络优先、失败回退缓存 —— 保证新版本能及时生效 */
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(r => r || caches.match('./index.html'))));
    return;
  }
  /* 静态资源：缓存优先，回源后写入缓存 */
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r ||
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    })));
});
