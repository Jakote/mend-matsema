var TARGET = 'https://platforms.mendgroup.co.za/matsema/';

/* ===========================================================================
   THE TOMBSTONE WORKER — served at sw.js on the four retired subdomains.

   Those origins each ran a real service worker that precached the app shell.
   When the apps moved to one origin, the subdomains were given a redirect page
   — and it did not work on the visit that mattered. The installed worker
   answers the navigation from ITS OWN CACHE before the redirect page is ever
   fetched, so a returning visitor got the old, pre-fix app, on a separate
   localStorage island. The third tester reproduced it: visit one is the old
   build with MEND.claimed undefined, visit two is clean.

   Deleting sw.js does not fix that. A 404 does eventually make the browser
   discard the registration, but only AFTER the stale navigation has been
   served, which is exactly one visit too late.

   So the file stays, and becomes a worker whose only job is to die and take
   its caches with it. The browser fetches sw.js on navigation as an update
   check — that request does not go through the old worker — sees a different
   script, installs this, and because it skips waiting and claims the page, it
   is in charge immediately. Then it empties every cache, unregisters itself,
   and sends every open tab to the new address.
   =========================================================================== */

self.addEventListener('install', function () {
  // Do not wait for the old worker's clients to close. The whole point is to
  // take over the tab that is open right now.
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    // ORDER MATTERS, and it was wrong. This used to empty every cache first and
    // navigate last. Emptying a cache is disk work; on a cheap phone it is not
    // instant, and every millisecond of it is a millisecond longer that the
    // person is sitting on the retired origin looking at the old app. The
    // teardown is for the browser's benefit and the redirect is for the
    // person's, so the person goes first.
    //
    // Measured on the harness in this repo's own reproduction: with the old
    // cache-first worker already installed, the visit-1 tab still rendered the
    // pre-fix app before this handler could move it. Nothing a server can send
    // prevents that — see the note at the foot of this file — but the window
    // is made as short as it can be.

    // 1. Take control of any page already open on this origin.
    await self.clients.claim();

    // 2. Send them all to where the app actually lives, FIRST. Carry the hash:
    //    it is the app's route, so dropping it lands a person on the front page
    //    of a site they were already deep inside.
    const clients = await self.clients.matchAll({ type: 'window' });
    await Promise.all(clients.map(function (c) {
      try {
        const here = new URL(c.url);
        return c.navigate(TARGET + here.hash);
      } catch (err) {
        return c.navigate(TARGET);
      }
    }));

    // 3. Only now, with the person already on their way, empty every cache on
    //    this origin — not just the one this script knows about, since the name
    //    carries a build hash and there may be several.
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return caches.delete(k); }));

    // 4. And remove this registration, so the next visit is an ordinary one
    //    with no worker in the way at all.
    await self.registration.unregister();
  })());
});

/* Until it is gone, never answer from a cache: there is no longer anything on
   this origin worth serving. Let every request reach the network, where the
   redirect page is waiting. */
self.addEventListener('fetch', function (e) {
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(
      '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="refresh" content="0; url=' + TARGET + '">' +
      '<p>Moved to <a href="' + TARGET + '">' + TARGET + '</a></p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});

/* ===========================================================================
   THE LIMIT OF THIS FILE, measured rather than assumed.

   Reproduced offline against the same sw-template and the same redirect page,
   driving a real headless Chrome over CDP with a fresh profile each run:

     installed worker = the PRE-FIX cache-first sw-template (git 52eb9b4^)
       sw.js 404      → return visit 1 shows OLD APP, MEND.claimed undefined
       sw.js tombstone→ return visit 1 STILL renders OLD APP briefly, then the
                        tab is navigated to the new origin and the caches and
                        the registration are gone

     installed worker = the CURRENT network-first sw-template
       sw.js tombstone→ return visit 1 lands on the new origin with no old
                        frame shown at all

   So the fix is complete for any origin retired from now on, and incomplete
   for a device that still carries a pre-12-Sept worker from one of the four
   subdomains retired before the template was changed. That is not a bug in
   this file: a cache-first worker answers the navigation from its own cache
   before any response from the server exists, and the browser's update check
   for sw.js runs alongside that request, not in front of it. No bytes the
   server can send arrive early enough. The window is now as short as it can be
   made, and it is one visit, once, per device.
   =========================================================================== */
