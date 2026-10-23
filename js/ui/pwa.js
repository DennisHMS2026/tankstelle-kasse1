/**
 * PWA: Service-Worker-Registrierung, kontrollierte Updates, Speicherstatus und Offline-Selbsttest.
 *
 * "Offline bereit" wird erst angezeigt, wenn der Selbsttest alle Pflichtprüfungen bestanden hat.
 * Die Prüfung läuft jedes Mal neu. Ein gespeichertes Ergebnis wird nur zur Anzeige genutzt.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const LS_KEY = 'pos.offlineReady';
  const SW_TIMEOUT_MS = 3000;

  const state = {
    supported: false,
    reason: '',
    registration: null,
    version: null,
    persisted: null,
    updateReady: false,
    lastResult: null,
  };

  const hasSW = () => 'serviceWorker' in navigator;

  /** Service Worker nur über HTTPS oder localhost. Unter file:// gibt es keinen Offline-Cache. */
  function secureContext() {
    return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  async function register() {
    if (!hasSW()) {
      state.reason = 'Dieser Browser unterstützt keine Offline-Dateien (Service Worker).';
      return;
    }
    if (!secureContext()) {
      state.reason = 'Offline-Betrieb braucht HTTPS. Unter file:// (Doppelklick) ist die Desktop-Version lauffähig, aber nicht als installierbare App.';
      return;
    }
    try {
      state.registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      state.supported = true;
    } catch (err) {
      state.reason = 'Service Worker konnte nicht registriert werden: ' + err.message;
      return;
    }
    const reg = state.registration;
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
      });
    });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate();

    // Neuladen erst, nachdem der Nutzer das Update ausdrücklich bestätigt hat
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    reg.update().catch(() => {});
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }

  function showUpdate() {
    state.updateReady = true;
    const banner = document.getElementById('update-banner');
    if (banner) banner.hidden = false;
    POS.App && POS.App.render && POS.App.render();
  }

  /** Update übernehmen. Vorher Zustand sichern und warnen, wenn gerade getankt wird. */
  async function applyUpdate() {
    const app = POS.App;
    const running = app.S && app.S.pumps.some((p) => p.status === 'TANKT');
    if (running && !(await POS.Ui.confirmDialog('Tankvorgang läuft', 'An einer Zapfsäule wird gerade getankt. Die Aktualisierung unterbricht den Vorgang nicht, er wird aber beim Neustart mit dem letzten Stand abgeschlossen. Jetzt aktualisieren?', 'Jetzt aktualisieren', true))) {
      return;
    }
    await app.flush();
    const waiting = state.registration && state.registration.waiting;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  }

  function dismissUpdate() {
    const banner = document.getElementById('update-banner');
    if (banner) banner.hidden = true;
  }

  /** Version und Dateiliste des aktiven Service Workers. */
  function swStatus() {
    return new Promise((resolve) => {
      const target = (navigator.serviceWorker && (navigator.serviceWorker.controller || (state.registration && state.registration.active))) || null;
      if (!target) return resolve(null);
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), SW_TIMEOUT_MS);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        resolve(e.data);
      };
      target.postMessage({ type: 'STATUS' }, [channel.port2]);
    });
  }

  function idbCheck() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open('pos-selftest', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('t');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('t', 'readwrite');
          const store = tx.objectStore('t');
          const token = 'ok-' + Date.now();
          store.put(token, 'probe');
          const get = store.get('probe');
          tx.oncomplete = () => {
            const ok = get.result === token;
            db.close();
            try {
              indexedDB.deleteDatabase('pos-selftest');
            } catch (e) {
              /* Aufräumen ist nicht kritisch */
            }
            resolve(ok);
          };
          tx.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      } catch (err) {
        resolve(false);
      }
    });
  }

  /**
   * Offline-Selbsttest. Pflichtprüfungen (required) müssen alle bestehen.
   * Liefert { checks: [{id,label,ok,detail,required}], ready, time }.
   */
  async function selfTest() {
    const checks = [];
    const add = (id, label, ok, detail = '', required = true) => checks.push({ id, label, ok: !!ok, detail, required });

    add('https', 'Sichere Verbindung (HTTPS oder localhost)', secureContext(), location.protocol);
    add('sw', 'Service Worker verfügbar', state.supported, state.reason || 'aktiv');

    const status = state.supported ? await swStatus() : null;
    state.version = status ? status.version : null;
    add('sw-active', 'App-Dateien vom Service Worker kontrolliert', !!status, status ? `Version ${status.version}` : 'noch nicht aktiv (Seite einmal neu laden)');

    let missing = [];
    if (status && 'caches' in root) {
      const cache = await caches.open(status.cache);
      for (const asset of status.assets) {
        if (!(await cache.match(asset))) missing.push(asset);
      }
      add('assets', `Alle Offline-Dateien vorhanden (${status.assets.length})`, missing.length === 0, missing.length ? `fehlt: ${missing.slice(0, 3).join(', ')}` : 'vollständig');
    } else {
      add('assets', 'Alle Offline-Dateien vorhanden', false, 'kein Cache verfügbar');
    }

    const idb = await idbCheck();
    add('idb', 'Lokale Datenbank (IndexedDB) lesbar und schreibbar', idb);
    const modules = ['Money', 'Ean', 'Fuel', 'Rules', 'Cart', 'Ledger', 'Pumps', 'Seed', 'Store', 'Reports', 'Printer'];
    const loaded = modules.filter((m) => !POS[m]);
    add('modules', 'Alle Programmmodule geladen', loaded.length === 0, loaded.length ? `fehlt: ${loaded.join(', ')}` : `${modules.length} Module`);
    add('state', 'Spielstand im Speicher', !!(POS.App && POS.App.S), POS.App && POS.App.S ? `Schema v${POS.App.S.schemaVersion}` : '–');
    add('storage', 'Dauerhafte Speicherung angefragt', state.persisted === true, state.persisted === true ? 'von iPadOS bestätigt' : 'nicht garantiert (optional, siehe Anleitung)', false);

    const ready = checks.filter((c) => c.required).every((c) => c.ok);
    const result = { checks, ready, time: new Date().toISOString() };
    state.lastResult = result;
    if (ready) {
      try {
        localStorage.setItem(LS_KEY, result.time);
      } catch (e) {
        /* nur Anzeige */
      }
    }
    return result;
  }

  /** Dauerhafte Speicherung anfragen (ohne Garantie). Ergebnis wird angezeigt. */
  async function requestPersist() {
    if (!navigator.storage) {
      state.persisted = false;
      return false;
    }
    try {
      state.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!state.persisted && navigator.storage.persist) state.persisted = await navigator.storage.persist();
    } catch (e) {
      state.persisted = false;
    }
    return state.persisted;
  }

  function lastReadyTime() {
    try {
      return localStorage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }

  POS.Pwa = { register, applyUpdate, dismissUpdate, selfTest, swStatus, requestPersist, lastReadyTime, state };
})(typeof window !== 'undefined' ? window : globalThis);
