// Garde la page de suivi sur le téléphone : elle s'ouvre instantanément, même avec un réseau faible
// ou sans réseau. La page est autonome (un seul fichier), il n'y a donc qu'elle à garder.
const CACHE = "suivi-v7";
const PAGE = "suivi.html";
const NET_TIMEOUT = 2500; // pour les autres pages : au-delà, on sert la copie gardée

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(PAGE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function refresh(req, key) {
  return fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key || req, copy)); }
    return res;
  });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Page de suivi : copie du téléphone tout de suite, mise à jour en arrière-plan pour la fois suivante
  if (url.pathname.endsWith("/" + PAGE)) {
    const key = new Request(PAGE);
    e.respondWith(
      caches.match(key).then((hit) => {
        const update = refresh(e.request, key).catch(() => null);
        if (hit) {
          e.waitUntil(update);
          // Nouvelle réponse sans adresse propre : Safari (iPhone) garde alors l'adresse scannée,
          // avec ?b=…&t=…, au lieu de la remplacer par celle de la copie gardée.
          return hit.blob().then((body) => new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
        }
        return update.then((r) => r || Response.error());
      })
    );
    return;
  }

  // Autres fichiers : réseau d'abord, copie gardée si le réseau traîne ou est coupé
  const network = refresh(e.request);
  const cached = caches.match(e.request, { ignoreSearch: true });
  e.respondWith(new Promise((resolve, reject) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => cached.then(finish), NET_TIMEOUT);
    network
      .then((r) => { clearTimeout(timer); finish(r); })
      .catch(() => cached.then((r) => (r ? finish(r) : !done && reject(new Error("hors ligne")))));
  }));
});
