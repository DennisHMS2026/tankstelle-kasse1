/**
 * Persistenz.
 *
 * Stufe 1: IndexedDB (Datenbank "getraenkemarkt-pos", ein Eintrag "state").
 * Stufe 2: localStorage, falls IndexedDB unter file:// nicht verfuegbar ist.
 * Stufe 3: nur Arbeitsspeicher (Daten gehen beim Neuladen verloren, Warnung in der Oberflaeche).
 *
 * Jeder Schreibvorgang ist ein einzelnes put/setItem des Gesamtzustands. Dadurch ist
 * das Speichern atomar: entweder ist der neue Zustand vollstaendig geschrieben oder der alte bleibt.
 * Schreibvorgaenge laufen nacheinander (Warteschlange).
 *
 * Schema-Migration: migrate() wandelt aeltere Versionen in die aktuelle um. Neue Versionen
 * werden hier als Schritt (schemaVersion n -> n+1) ergaenzt.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const SCHEMA_VERSION = POS.Seed.SCHEMA_VERSION;

  const DB_NAME = 'getraenkemarkt-pos';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const KEY = 'state';
  const LS_KEY = 'getraenkemarkt-pos.state.v1';
  const BACKUP_FORMAT = 'getraenkemarkt-pos-backup';

  let mode = 'memory';
  let db = null;
  let memoryValue = null;
  let queue = Promise.resolve();

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Datenbank blockiert (anderes Fenster geöffnet?)'));
    });
  }

  async function init() {
    if (typeof indexedDB !== 'undefined') {
      try {
        db = await openIdb();
        // Testlesen, um Berechtigungsprobleme unter file:// frueh zu erkennen
        await rawRead();
        mode = 'indexeddb';
        return mode;
      } catch (err) {
        console.warn('IndexedDB nicht nutzbar, Fallback auf localStorage:', err);
        db = null;
      }
    }
    try {
      localStorage.setItem(LS_KEY + '.probe', '1');
      localStorage.removeItem(LS_KEY + '.probe');
      mode = 'localstorage';
    } catch (err) {
      console.warn('localStorage nicht nutzbar, nur Arbeitsspeicher:', err);
      mode = 'memory';
    }
    return mode;
  }

  function rawRead() {
    if (mode === 'indexeddb' || db) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }
    if (mode === 'localstorage') return Promise.resolve(localStorage.getItem(LS_KEY));
    return Promise.resolve(memoryValue);
  }

  function rawWrite(json) {
    if (db) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(json, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Speichern fehlgeschlagen'));
        tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
      });
    }
    if (mode === 'localstorage') {
      try {
        localStorage.setItem(LS_KEY, json);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(new Error('Speicher voll oder gesperrt: ' + err.message));
      }
    }
    memoryValue = json;
    return Promise.resolve();
  }

  /** Migration auf die aktuelle Schemaversion. Wirft bei unbekannten oder zu neuen Daten. */
  function migrate(obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.schemaVersion !== 'number') {
      throw new Error('Keine gültigen Simulationsdaten (Schemaversion fehlt)');
    }
    if (obj.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`Datenstand ${obj.schemaVersion} ist neuer als diese Version (${SCHEMA_VERSION})`);
    }
    // Schritt 1 -> 2: Tankstelle (Kraftstoffe, Zapfsäulen, Tankvorgänge, Tankstellenartikel).
    // Bestehende Daten bleiben erhalten, siehe POS.Seed.upgradeToV2.
    const state = obj.schemaVersion === 1 ? POS.Seed.upgradeToV2(obj) : obj;
    for (const key of ['settings', 'categories', 'deposits', 'articles', 'staff', 'shifts', 'cashMoves', 'sales', 'stockMoves', 'vouchers', 'events', 'trainingResults', 'counters', 'fuels', 'pumps', 'tanks']) {
      if (!(key in state)) throw new Error(`Datensicherung unvollständig: ${key} fehlt`);
    }
    state.trainingCustomer = state.trainingCustomer || null;
    state.cart = state.cart || null;
    return state;
  }

  /** Laedt den gespeicherten Zustand oder null, wenn noch keiner existiert. */
  async function load() {
    const raw = await rawRead();
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  }

  /** Speichert den Gesamtzustand atomar. Resolved erst nach erfolgreichem Schreiben. */
  function save(state) {
    const json = JSON.stringify(state);
    const job = queue.then(() => rawWrite(json));
    queue = job.catch(() => {});
    return job;
  }

  function exportBackup(state) {
    return JSON.stringify(
      { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), state },
      null,
      2
    );
  }

  /**
   * Prüft einen Zustand auf Datenintegrität. Liefert eine Liste von Fehlern (leer = gültig).
   * Geldbeträge müssen ganzzahlige Cent sein, Mengen ganzzahlige ml, Zustände bekannte Werte.
   */
  function validateState(s) {
    const errs = [];
    const isInt = Number.isInteger;
    const lists = ['articles', 'categories', 'deposits', 'staff', 'shifts', 'cashMoves', 'sales', 'stockMoves', 'vouchers', 'events', 'trainingResults', 'fuels', 'pumps', 'tanks'];
    for (const k of lists) if (!Array.isArray(s[k])) errs.push(`${k}: keine Liste`);
    if (errs.length) return errs;
    if (!s.counters || typeof s.counters !== 'object') errs.push('Zähler fehlen');
    s.articles.forEach((a) => {
      if (!a.id || !a.name) errs.push(`Artikel ohne ID oder Name`);
      if (!isInt(a.priceCents) || a.priceCents < 0) errs.push(`Artikel ${a.id || '?'}: Preis ist keine ganze Cent-Zahl`);
      if (!isInt(a.stock)) errs.push(`Artikel ${a.id || '?'}: Bestand ungültig`);
    });
    s.sales.forEach((x) => {
      if (!x.bonNr || !x.totals || !isInt(x.totals.gesamt)) errs.push(`Verkauf ${x.bonNr || '?'}: Summe ungültig`);
    });
    s.cashMoves.forEach((m) => {
      if (!isInt(m.cents)) errs.push(`Kassenbewegung ${m.id || '?'}: Betrag ungültig`);
    });
    s.fuels.forEach((f) => {
      if (!isInt(f.priceMilli) || f.priceMilli <= 0) errs.push(`Kraftstoff ${f.id || '?'}: Literpreis ungültig`);
      if (!isInt(f.stockMl)) errs.push(`Kraftstoff ${f.id || '?'}: Tankinhalt ungültig`);
    });
    if (s.pumps.length !== 8) errs.push('Es müssen genau 8 Zapfsäulen vorhanden sein');
    const TANK = ['LAUFEND', 'OFFEN', 'IM_WARENKORB', 'BEZAHLT', 'STORNIERT'];
    s.tanks.forEach((t) => {
      if (!TANK.includes(t.status)) errs.push(`Tankvorgang ${t.id || '?'}: unbekannter Status`);
      if (!isInt(t.ml || 0) || !isInt(t.targetMl || 0)) errs.push(`Tankvorgang ${t.id || '?'}: Menge ungültig`);
      if (t.amountCents !== null && t.amountCents !== undefined && !isInt(t.amountCents)) errs.push(`Tankvorgang ${t.id || '?'}: Betrag ungültig`);
    });
    return errs;
  }

  /** Liest eine Sicherungsdatei und prueft das Format. Liefert den migrierten Zustand. */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Datei ist kein gültiges JSON');
    }
    if (!data || data.format !== BACKUP_FORMAT) throw new Error('Keine Datensicherung dieser Anwendung');
    const state = migrate(data.state);
    const errs = validateState(state);
    if (errs.length) throw new Error('Datensicherung ist fehlerhaft: ' + errs.slice(0, 4).join('; ') + (errs.length > 4 ? ` (+${errs.length - 4} weitere)` : ''));
    return state;
  }

  POS.Store = {
    SCHEMA_VERSION,
    init,
    load,
    save,
    migrate,
    validateState,
    exportBackup,
    parseBackup,
    get mode() {
      return mode;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
