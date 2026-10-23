/**
 * Anwendungssteuerung: Start, Anmeldung, Schichtstart, Zustandsverwaltung, Ansichtswechsel.
 *
 * App.mutate(fn) ist die EINZIGE Stelle, an der Zustand geaendert und gespeichert wird:
 *  1. Kopie des Zustands erstellen
 *  2. fn(entwurf) ausfuehren (wirft fn, wird nichts gespeichert)
 *  3. Entwurf speichern (atomar)
 *  4. erst nach erfolgreichem Speichern als aktueller Zustand uebernehmen
 * Aufrufe laufen nacheinander, damit kein Vorgang auf veralteten Daten aufsetzt.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast } = POS.Ui;
  const R = POS.Rules;
  const L = POS.Ledger;
  const M = POS.Money;

  /** Ab dieser Lücke zwischen zwei Takten gilt die App als unterbrochen (iPadOS-Pause). */
  const PAUSE_MS = 5000;
  /** Während Tankvorgängen wird höchstens alle zehn Sekunden gespeichert. */
  const HEARTBEAT_MS = 10000;

  const App = {
    S: null,
    user: null,
    chain: Promise.resolve(),

    settings() {
      return this.S.settings;
    },

    shift() {
      return L.currentShift(this.S);
    },

    mutate(fn) {
      const job = this.chain.then(async () => {
        const draft = structuredClone(this.S);
        const result = fn(draft);
        draft.updatedAt = new Date().toISOString();
        await POS.Store.save(draft);
        this.S = draft;
        return result;
      });
      this.chain = job.catch(() => {});
      return job.then((result) => {
        this.render();
        return result;
      });
    },

    /**
     * Simulationstakt (jede Sekunde): zeitgesteuerte Zapfsäulenübergänge und Kundenankünfte.
     * Gespeichert wird nur, wenn sich wirklich etwas geändert hat.
     */
    tick() {
      if (!this.S) return;
      const nowMs = Date.now();
      const gap = this.lastTick ? nowMs - this.lastTick : 0;
      this.lastTick = nowMs;
      const running = this.S.pumps.some((p) => p.status === 'TANKT');
      if (!running && !POS.Pumps.needsTick(this.S)) return;
      this.chain = this.chain.then(() => this.tickNow(nowMs, gap, running)).catch((err) => console.warn('Zapfsäulen-Takt:', err));
    },

    /**
     * Ein Takt. Kopiert nur Zapfsäulen, Tankvorgänge und Kraftstoffe (nicht den ganzen Spielstand),
     * damit iPad-Akku und Rechenzeit geschont werden. Gespeichert wird bei Zustandswechseln
     * sofort und während laufender Tankvorgänge höchstens alle zehn Sekunden (Heartbeat).
     */
    async tickNow(nowMs, gap, running) {
      const S = this.S;
      // Lange Lücke zwischen zwei Takten: iPadOS hat die App angehalten. Laufende Vorgänge
      // werden mit dem gespeicherten Stand beendet, nichts wird nachberechnet.
      const light = {
        ...S,
        pumps: structuredClone(S.pumps),
        tanks: structuredClone(S.tanks),
        fuels: structuredClone(S.fuels),
        counters: { ...S.counters },
        events: [],
      };
      let changed;
      if (running && gap > PAUSE_MS) changed = POS.Pumps.interrupt(light, new Date(), 'Pause (App nicht aktiv)') > 0;
      else changed = POS.Pumps.advance(light, new Date(), Math.random);
      const heartbeat = running && nowMs - this.lastSave > HEARTBEAT_MS;
      const next = { ...S, pumps: light.pumps, tanks: light.tanks, fuels: light.fuels, counters: light.counters, events: S.events.concat(light.events) };
      this.S = next;
      if (!changed && !heartbeat) return false;
      next.updatedAt = new Date().toISOString();
      await POS.Store.save(next);
      this.lastSave = Date.now();
      this.render();
      return true;
    },

    /** Sofort speichern (z. B. beim Verlassen der App). */
    flush() {
      if (this.S) POS.Store.save(this.S).then(() => (this.lastSave = Date.now())).catch((err) => console.warn('Speichern fehlgeschlagen:', err));
    },

    /**
     * Ändert den Zustand nur im Entwurf. Gespeichert wird nur, wenn fn true liefert.
     * Der Zustand im Speicher bleibt aber immer der neueste (Simulationsfortschritt).
     */
    mutateIf(fn) {
      const job = this.chain.then(async () => {
        const draft = structuredClone(this.S);
        const save = fn(draft);
        this.S = draft;
        if (!save) return false;
        draft.updatedAt = new Date().toISOString();
        await POS.Store.save(draft);
        this.lastSave = Date.now();
        return true;
      });
      this.chain = job.catch(() => {});
      return job.then((changed) => {
        if (changed) this.render();
        return changed;
      });
    },

    render() {
      POS.Pos.render();
      POS.PumpView.update(this.S);
      if (POS.Admin.isVisible()) POS.Admin.render();
      if (!document.getElementById('view-shop').hidden) POS.ShopView.update(this.S);
      if (!document.getElementById('view-board').hidden) POS.Board.update(this.S);
      this.renderBanners();
    },

    /** Sicherungserinnerung und Offline-Anzeige in der Kopfzeile. */
    renderBanners() {
      const s = this.S;
      const pill = document.getElementById('offline-pill');
      if (pill) {
        const ready = POS.Pwa.state.lastResult && POS.Pwa.state.lastResult.ready;
        pill.textContent = ready ? 'Offline bereit' : 'Offline prüfen';
        pill.className = 'pill ' + (ready ? 'ok' : 'warn');
      }
      const last = s.settings.lastBackupAt ? Date.parse(s.settings.lastBackupAt) : 0;
      const days = last ? (Date.now() - last) / 86400000 : Infinity;
      const since = s.settings.salesSinceBackup || 0;
      const due = days > 7 || since >= 20;
      const note = document.getElementById('backup-note');
      if (note) {
        note.hidden = !due;
        note.textContent = last ? `Bitte Sicherung erstellen (letzte vor ${Math.floor(days)} Tagen, ${since} Verkäufe seither)` : 'Noch keine Sicherung. Bitte eine Datensicherung erstellen.';
      }
    },

    /** Hauptbereiche: kasse | pumps | shop | admin | board. Nur ein Bereich ist sichtbar. */
    showView(name) {
      const views = { kasse: 'view-kasse', pumps: 'view-pumps', shop: 'view-shop', admin: 'view-admin', board: 'view-board' };
      for (const [key, id] of Object.entries(views)) document.getElementById(id).hidden = key !== name;
      for (const key of Object.keys(views)) {
        const btn = document.getElementById('nav-' + key);
        if (btn) {
          btn.classList.toggle('active', key === name);
          btn.setAttribute('aria-current', key === name ? 'page' : 'false');
        }
      }
      if (name === 'admin') POS.Admin.show();
      else if (name === 'board') POS.Board.update(this.S);
      else if (name === 'shop') POS.ShopView.update(this.S);
      else if (name === 'kasse') POS.Pos.focusBarcode();
      window.scrollTo(0, 0);
    },

    /** Anmeldung mit Personalnummer und PIN. Danach ggf. Schichtstart. */
    showLogin(message = '') {
      this.user = null;
      this.showView('kasse');
      const host = document.getElementById('login-root');
      host.hidden = false;
      const nr = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Personalnummer', 'data-autofocus': true, 'aria-label': 'Personalnummer' });
      const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', 'aria-label': 'PIN' });
      const err = h('div', { class: 'login-error', role: 'alert', text: message });
      const submit = () => {
        const staff = this.S.staff.find((s) => s.nr === nr.value.trim());
        if (!staff || staff.pin !== pin.value || !staff.active) {
          err.textContent = 'Personalnummer oder PIN falsch';
          pin.value = '';
          POS.Sound.play('error');
          return;
        }
        this.user = staff;
        host.hidden = true;
        host.replaceChildren();
        toast(`Angemeldet: ${staff.name}`, 'ok');
        if (!this.shift()) this.showShiftStart();
        else this.render();
      };
      nr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          pin.focus();
        }
      });
      pin.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      host.replaceChildren(
        h(
          'div',
          { class: 'login-card' },
          h('h1', { text: 'GETRÄNKEMARKT POS' }),
          h('p', { class: 'login-sub', text: 'Anmeldung Kassierer' }),
          h('label', { class: 'field-label', text: 'Personalnummer' }),
          nr,
          h('label', { class: 'field-label', text: 'PIN' }),
          pin,
          err,
          h('button', { class: 'btn primary big', type: 'button', onclick: submit, text: 'Anmelden' }),
          h('p', { class: 'hint', text: 'Simulation. Die PIN schützt nicht gegen Personen mit Zugriff auf Browser oder Dateien.' })
        )
      );
      setTimeout(() => nr.focus(), 0);
    },

    /** Schichtbeginn: Anfangsbestand zaehlen und bestaetigen. */
    showShiftStart() {
      const amount = h('input', { type: 'text', inputmode: 'decimal', 'data-autofocus': true, placeholder: 'z. B. 150,00', 'aria-label': 'Anfangsbestand' });
      openModal({
        title: 'Schichtbeginn',
        dismissible: false,
        content: h(
          'div',
          { class: 'form' },
          h('p', { text: `Angemeldet: ${this.user.name}. Bitte den Kassenbestand zählen.` }),
          h('label', {}, 'Anfangsbestand (€)', amount), POS.Ui.numpad(amount, { decimal: true }),
          h('div', { class: 'hint', text: 'Ohne offene Schicht sind Verkäufe gesperrt.' })
        ),
        actions: [
          { label: 'Abmelden', run: () => this.logout() },
          {
            label: 'Kasse öffnen',
            primary: true,
            run: async () => {
              const cents = M.parseEuro(amount.value);
              if (cents === null || cents < 0) throw R.fail('BETRAG_UNGUELTIG', 'Anfangsbestand ungültig');
              await this.mutate((d) => {
                L.openShift(d, { cashierId: this.user.id, startCents: cents });
              });
              toast('Schicht gestartet', 'ok');
              POS.Pos.focusBarcode();
            },
          },
        ],
      });
    },

    logout() {
      this.showLogin();
    },

    /** Zugang zur Verwaltung nur mit Marktleitung/Administrator. */
    async openAdmin(section = null) {
      if (!(this.user && R.hasRole(this.user, 'ADMIN'))) {
        const approver = await POS.Ui.requestApproval('ADMIN', 'Zugang zur Verwaltung');
        if (!approver) return;
      }
      if (section) POS.Admin.goto(section);
      this.showView('admin');
    },

    async boot() {
      const mode = await POS.Store.init();
      let state;
      try {
        state = await POS.Store.load();
      } catch (err) {
        document.getElementById('login-root').hidden = false;
        document.getElementById('login-root').replaceChildren(
          h('div', { class: 'login-card' }, h('h1', { text: 'Daten konnten nicht geladen werden' }), h('p', { text: err.message }), h('p', { class: 'hint', text: 'Keine Änderungen wurden vorgenommen. Bitte Datensicherung prüfen.' }))
        );
        return;
      }
      if (!state) {
        state = POS.Seed.createInitialState();
        await POS.Store.save(state);
      }
      this.S = state;
      this.lastSave = Date.now();
      POS.Sound.setConfigSource(() => this.S.settings);
      POS.Pos.init();
      POS.Admin.init(this);
      document.getElementById('nav-kasse').addEventListener('click', () => this.showView('kasse'));
      document.getElementById('nav-admin').addEventListener('click', () => this.openAdmin());
      document.getElementById('nav-kasse').addEventListener('click', () => this.showView('kasse'));
      document.getElementById('nav-pumps').addEventListener('click', () => this.showView('pumps'));
      document.getElementById('nav-shop').addEventListener('click', () => this.showView('shop'));
      document.getElementById('offline-pill').addEventListener('click', () => this.openAdmin('systeminfo'));
      document.getElementById('update-now').addEventListener('click', () => POS.Pwa.applyUpdate());
      document.getElementById('update-later').addEventListener('click', () => POS.Pwa.dismissUpdate());
      document.getElementById('nav-logout').addEventListener('click', () => this.logout());
      document.getElementById('view-board').replaceChildren(POS.Board.build());
      document.getElementById('nav-board').addEventListener('click', () => this.showView('board'));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('view-board').hidden && !POS.Ui.modalOpen()) this.showView('kasse');
      });
      setInterval(() => this.tick(), 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.flush(); // beim Verlassen sofort sichern
      });
      window.addEventListener('pagehide', () => this.flush());
      setInterval(() => POS.PumpView.live(this.S), 250);
      document.getElementById('nav-admin').textContent = 'Verwaltung';
      await this.mutateIf((d) => POS.Pumps.interrupt(d, new Date(), 'App neu gestartet') > 0);
      // Offline-Betrieb: Service Worker registrieren, Speicher dauerhaft anfragen (ohne Garantie)
      POS.Pwa.register().then(() => POS.Pwa.selfTest().then(() => this.render())).catch((err) => console.warn('PWA:', err));
      POS.Pwa.requestPersist().then(() => this.render());
      this.showLogin(mode === 'memory' ? 'Achtung: Speicher nicht verfügbar. Änderungen gehen beim Neuladen verloren.' : '');
    },
  };

  POS.App = App;
  App.lastTick = 0;
  App.lastSave = 0;

  window.addEventListener('error', (e) => {
    POS.Ui.toast('Unerwarteter Fehler: ' + (e.message || 'unbekannt'), 'error');
  });

  document.addEventListener('DOMContentLoaded', () => {
    App.boot().catch((err) => {
      document.body.replaceChildren(h('pre', { class: 'fatal', text: 'Start fehlgeschlagen: ' + err.message }));
    });
  });
})(typeof window !== 'undefined' ? window : globalThis);
