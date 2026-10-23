/**
 * Zapfsäulenübersicht (Mitte der Kasse): acht Kacheln und die Liste offener Tankbeträge.
 * Kacheln werden einmal aufgebaut. Laufende Werte (Liter, Betrag) werden nur im Text
 * aktualisiert, damit Klicks nicht durch ein Neuzeichnen verloren gehen.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast, requestApproval } = POS.Ui;
  const F = POS.Fuel;
  const P = POS.Pumps;
  const M = POS.Money;

  const app = () => POS.App;

  const STATE_CLASS = {
    FREI: 'st-frei',
    ENTNOMMEN: 'st-entnommen',
    WARTET_FREIGABE: 'st-wartet',
    TANKT: 'st-tankt',
    BEENDET: 'st-beendet',
    ZAHLUNG_AUSSTEHEND: 'st-zahlung',
    BEZAHLT: 'st-bezahlt',
    GESPERRT: 'st-gesperrt',
    STOERUNG: 'st-stoerung',
  };

  /** Welche Schaltflächen zu welchem Zustand gehören. */
  const ACTIONS_BY_STATE = {
    FREI: ['lift', 'lock', 'fault'],
    ENTNOMMEN: [],
    WARTET_FREIGABE: ['release', 'cancel', 'lock', 'fault'],
    TANKT: ['stop', 'fault'],
    BEENDET: [],
    ZAHLUNG_AUSSTEHEND: [],
    BEZAHLT: ['reset'],
    GESPERRT: ['unlock'],
    STOERUNG: ['clear'],
  };

  const BUTTONS = [
    ['lift', 'Pistole entnehmen (Sim)', ''],
    ['release', 'Freigeben', 'primary'],
    ['cancel', 'Abbrechen', ''],
    ['stop', 'Stopp', ''],
    ['fault', 'Störung melden', 'danger'],
    ['clear', 'Störung behoben', ''],
    ['lock', 'Sperren', ''],
    ['unlock', 'Entsperren', ''],
    ['reset', 'Zurücksetzen', ''],
  ];

  const SHORT_FUEL = { 'Super E5': 'E5', 'Super E10': 'E10', 'Super Plus': 'Super+', Diesel: 'Diesel', 'Premium Diesel': 'Prem. Diesel', AdBlue: 'AdBlue' };
  const SHORT_STATE = {
    FREI: 'Frei',
    ENTNOMMEN: 'Pistole',
    WARTET_FREIGABE: 'Wartet',
    TANKT: 'Tankt',
    BEENDET: 'Beendet',
    ZAHLUNG_AUSSTEHEND: 'Zahlung',
    BEZAHLT: 'Bezahlt',
    GESPERRT: 'Gesperrt',
    STOERUNG: 'Störung',
  };

  let mini = {};
  let miniGrid = null;

  /** Kompakte Zapfsäulen für die Kassenansicht (2 Spalten × 4 Zeilen). */
  function buildMini() {
    mini = {};
    miniGrid = h('div', { class: 'pump-mini-grid' });
    for (const p of app().S.pumps) {
      const el = h(
        'button',
        { class: 'pm', type: 'button', 'data-pump': String(p.id), 'aria-label': `Zapfsäule ${p.id}`, onclick: () => openSheet(p.id) },
        h('span', { class: 'pm-no', text: `Zapfsäule ${p.id}` }),
        h('span', { class: 'pm-state' }),
        h('span', { class: 'pm-fuel' }),
        h('span', { class: 'pm-amount' })
      );
      mini[p.id] = { el, state: el.querySelector('.pm-state'), fuel: el.querySelector('.pm-fuel'), amount: el.querySelector('.pm-amount') };
      miniGrid.append(el);
    }
    return h('section', { class: 'pump-mini-panel', 'aria-label': 'Zapfsäulen' }, h('div', { class: 'pmp-head' }, h('strong', { text: 'Zapfsäulen' }), h('span', { class: 'hint', text: 'Antippen für Details' })), miniGrid);
  }

  function updateMini(S, now) {
    if (!miniGrid) return;
    for (const pump of S.pumps) {
      const m = mini[pump.id];
      if (!m) continue;
      const v = valuesOf(S, pump, now);
      m.el.className = `pm ${STATE_CLASS[pump.status] || ''}`;
      m.state.textContent = SHORT_STATE[pump.status] || pump.status;
      m.fuel.textContent = SHORT_FUEL[v.fuel] || v.fuel;
      m.amount.textContent = M.formatEuro(v.cents);
    }
  }

  /** Detailblatt einer Zapfsäule. Werte aktualisieren sich, solange es offen ist. */
  function openSheet(pumpId) {
    let entry = null;
    let timer = null;
    const body = h('div', { class: 'sheet-body' });
    const kv = (label, value) => h('div', { class: 'kv' }, h('span', { class: 'kv-l', text: label }), h('strong', { class: 'kv-v', text: value }));
    const sbtn = (label, cls, enabled, fn) =>
      h('button', {
        class: 'btn big ' + cls,
        type: 'button',
        disabled: !enabled,
        onclick: async () => {
          entry.close();
          await fn();
        },
        text: label,
      });
    const draw = () => {
      const S1 = app().S;
      const p = S1.pumps.find((x) => x.id === pumpId);
      if (!p) return;
      const v = valuesOf(S1, p, Date.now());
      const tank = p.tankId ? S1.tanks.find((t) => t.id === p.tankId) : null;
      const offer = !!tank && tank.status === 'OFFEN';
      body.replaceChildren(
        h('div', { class: 'sheet-head' }, h('strong', { text: `Zapfsäule ${p.id}` }), h('span', { class: `pm-badge ${STATE_CLASS[p.status] || ''}`, text: P.LABEL[p.status] || p.status })),
        h('div', { class: 'sheet-kv' }, kv('Kraftstoff', v.fuel), kv('Literpreis', F.formatPricePerLiter(v.price)), kv('Getankt', litersText(v.ml)), kv('Gesamtbetrag', M.formatEuro(v.cents))),
        h(
          'div',
          { class: 'sheet-actions' },
          sbtn('Freigeben', 'primary', p.status === 'WARTET_FREIGABE', () => act('release', pumpId)),
          sbtn('Pistole entnehmen (Sim)', '', p.status === 'FREI', () => act('lift', pumpId)),
          sbtn('Sperren', '', p.status === 'FREI' || p.status === 'WARTET_FREIGABE', () => act('lock', pumpId)),
          sbtn('Entsperren', '', p.status === 'GESPERRT', () => act('unlock', pumpId)),
          sbtn('Tankvorgang stoppen', 'danger', p.status === 'TANKT', () => act('stop', pumpId)),
          sbtn('Tankbetrag übernehmen', 'primary', offer, () => attach(tank.id)),
          sbtn('Schließen', '', true, () => {})
        )
      );
    };
    entry = POS.Ui.openModal({
      title: `Zapfsäule ${pumpId}`,
      cls: 'sheet',
      content: body,
      actions: [],
      onClose: () => clearInterval(timer),
    });
    draw();
    timer = setInterval(draw, 500);
  }

  let panel = null;
  let autoBtn = null;
  let pumpGrid = null;
  let tiles = {};
  let listBox = null;
  let listSig = '';
  let rows = {};

  function build() {
    autoBtn = h('button', { class: 'btn small', type: 'button', onclick: toggleAuto });
    pumpGrid = h('div', { class: 'pump-grid' });
    tiles = {};
    for (const p of app().S.pumps) {
      tiles[p.id] = makeTile(p.id);
      pumpGrid.append(tiles[p.id].el);
    }
    listBox = h('div', { class: 'tank-list' });
    panel = h(
      'section',
      { class: 'pump-panel', 'aria-label': 'Zapfsäulenübersicht' },
      h(
        'div',
        { class: 'pump-head' },
        h('strong', { text: 'Zapfsäulen' }),
        h('span', { class: 'hint', text: 'Liter und Betrag laufen live' }),
        autoBtn
      ),
      pumpGrid,
      h('div', { class: 'section-title', text: 'Offene Tankbeträge' }),
      listBox
    );
    return panel;
  }

  function makeTile(id) {
    const tile = {
      el: null,
      badge: h('span', { class: 'pump-badge' }),
      fuel: h('div', { class: 'pump-fuel' }),
      liters: h('div', { class: 'pump-liters' }),
      price: h('div', { class: 'pump-price' }),
      amount: h('div', { class: 'pump-amount' }),
      btns: {},
    };
    const actions = h('div', { class: 'pump-actions' });
    for (const [key, label, cls] of BUTTONS) {
      tile.btns[key] = h('button', { class: 'btn small ' + cls, type: 'button', hidden: true, onclick: () => act(key, id), text: label });
      actions.append(tile.btns[key]);
    }
    tile.el = h(
      'div',
      { class: 'pump', 'data-pump': String(id), 'aria-label': `Zapfsäule ${id}` },
      h('div', { class: 'pump-top' }, h('span', { class: 'pump-no', text: `Zapfsäule ${id}` }), tile.badge),
      tile.fuel,
      tile.liters,
      h('div', { class: 'pump-row' }, h('span', { text: 'Literpreis' }), tile.price),
      h('div', { class: 'pump-row' }, h('span', { text: 'Gesamtbetrag' }), tile.amount),
      actions
    );
    return tile;
  }

  /** Großes „L“ auf den Zapfsäulenkacheln, damit das „l“ nicht mit einer „1“ verwechselt wird. */
  function litersText(ml) {
    return F.formatMl(ml).replace(' l', ' L');
  }

  /** Aktuelle Anzeigewerte einer Zapfsäule. */
  function valuesOf(S, pump, now) {
    const fuel = S.fuels.find((f) => f.id === pump.fuelId);
    const tank = pump.tankId ? S.tanks.find((t) => t.id === pump.tankId) : null;
    if (tank && tank.status === 'LAUFEND') {
      const ml = F.mlAt(tank, now);
      return { fuel: tank.fuelName, ml, price: tank.priceMilli, cents: F.amountCents(ml, tank.priceMilli) };
    }
    if (tank) return { fuel: tank.fuelName, ml: tank.mlFinal || 0, price: tank.priceMilli, cents: tank.amountCents || 0 };
    return { fuel: fuel ? fuel.name : '–', ml: 0, price: fuel ? fuel.priceMilli : 0, cents: 0 };
  }

  /** Schnelle Aktualisierung (ohne Speichern), wird regelmäßig aufgerufen. */
  function live(S) {
    if (!S) return;
    updateMini(S, Date.now());
    if (!panel) return;
    const now = Date.now();
    for (const pump of S.pumps) {
      const tile = tiles[pump.id];
      if (!tile) continue;
      const v = valuesOf(S, pump, now);
      tile.liters.textContent = litersText(v.ml);
      tile.amount.textContent = M.formatEuro(v.cents);
      tile.price.textContent = F.formatPricePerLiter(v.price);
    }
    for (const row of Object.values(rows)) {
      const tank = S.tanks.find((t) => t.id === row.tankId);
      if (tank) row.amount.textContent = M.formatEuro(tank.amountCents || 0);
    }
  }

  function update(S) {
    updateMini(S, Date.now());
    if (!panel) return;
    const now = Date.now();
    autoBtn.textContent = S.settings.fuelAuto ? 'Automatik: EIN' : 'Automatik: AUS';
    autoBtn.classList.toggle('primary', !!S.settings.fuelAuto);
    for (const pump of S.pumps) {
      const tile = tiles[pump.id];
      const v = valuesOf(S, pump, now);
      tile.el.className = `pump ${STATE_CLASS[pump.status] || ''}`;
      tile.badge.textContent = P.LABEL[pump.status] || pump.status;
      tile.fuel.textContent = v.fuel;
      tile.liters.textContent = litersText(v.ml);
      tile.amount.textContent = M.formatEuro(v.cents);
      tile.price.textContent = F.formatPricePerLiter(v.price);
      const allowed = ACTIONS_BY_STATE[pump.status] || [];
      for (const [key] of BUTTONS) tile.btns[key].hidden = !allowed.includes(key);
    }
    renderTankList(S);
  }

  function renderTankList(S) {
    const open = S.tanks.filter((t) => t.status === 'OFFEN' || t.status === 'IM_WARENKORB');
    const sig = open.map((t) => `${t.id}:${t.status}`).join('|');
    if (sig !== listSig) {
      listSig = sig;
      rows = {};
      if (!open.length) {
        listBox.replaceChildren(h('div', { class: 'hint', text: 'Keine offenen Tankbeträge. Nach dem Tanken erscheint der Betrag hier.' }));
        return;
      }
      listBox.replaceChildren(
        ...open.map((t) => {
          const amount = h('span', { class: 'tr-amount', text: M.formatEuro(t.amountCents || 0) });
          const inCart = t.status === 'IM_WARENKORB';
          rows[t.id] = { tankId: t.id, amount };
          return h(
            'div',
            { class: 'tank-row' + (inCart ? ' in-cart' : ''), 'data-tank': t.id },
            h('span', { class: 'tr-pump', text: `Zapfsäule ${t.pumpId}` }),
            h('span', { class: 'tr-fuel', text: t.fuelName }),
            h('span', { class: 'tr-liters', text: F.formatMl(t.mlFinal || 0) }),
            amount,
            inCart
              ? h('span', { class: 'tag warn', text: 'im Bon' })
              : h('button', { class: 'btn small primary', type: 'button', onclick: () => attach(t.id), text: 'In Bon übernehmen' }),
            inCart ? null : h('button', { class: 'btn small danger', type: 'button', onclick: () => storno(t.id), text: 'Stornieren' })
          );
        })
      );
    }
    // Betrag aktualisieren, falls sich nichts an der Liste geändert hat
    for (const t of open) if (rows[t.id]) rows[t.id].amount.textContent = M.formatEuro(t.amountCents || 0);
  }

  async function act(key, pumpId) {
    const now = new Date();
    const cashierId = app().user ? app().user.id : null;
    const fns = {
      lift: (d) => P.lift(d, { pumpId, cashierId, now, rng: Math.random }),
      release: (d) => P.release(d, { pumpId, cashierId, now, rng: Math.random }),
      cancel: (d) => P.cancel(d, { pumpId, cashierId, now }),
      stop: (d) => P.stop(d, { pumpId, cashierId, now }),
      fault: (d) => P.fault(d, { pumpId, cashierId, now, reason: 'Störung gemeldet' }),
      clear: (d) => P.clearFault(d, { pumpId, cashierId, now }),
      lock: (d) => P.lock(d, { pumpId, cashierId, now }),
      unlock: (d) => P.unlock(d, { pumpId, cashierId, now }),
      reset: (d) => P.resetPaid(d, { pumpId, cashierId, now }),
    };
    try {
      await app().mutate(fns[key]);
    } catch (err) {
      errorToast(err);
    }
  }

  async function attach(tankId) {
    try {
      await app().mutate((d) => {
        P.attachToCart(d, { tankId, cashierId: app().user.id, now: new Date() });
      });
      toast('Kraftstoff in den Bon übernommen', 'ok');
    } catch (err) {
      errorToast(err);
    }
  }

  /** Stornierung eines offenen Tankvorgangs (Kunde ohne Bezahlung). Freigabe und Grund sind Pflicht. */
  async function storno(tankId) {
    const approver = await requestApproval('SCHICHTLEITUNG', 'Tankvorgang stornieren (Kunde ohne Bezahlung)');
    if (!approver) return;
    const reason = h('input', { type: 'text', placeholder: 'Grund (Pflicht)', 'data-autofocus': true, 'aria-label': 'Grund' });
    openModal({
      title: 'Tankvorgang stornieren',
      content: h('div', { class: 'form' }, h('p', { text: 'Der Tankvorgang wird ohne Bezahlung geschlossen. Die Freigabe wird protokolliert.' }), h('label', {}, 'Grund', reason)),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Tankvorgang stornieren',
          danger: true,
          run: async () => {
            await app().mutate((d) => P.cancelTank(d, { tankId, cashierId: app().user.id, approverId: approver, reason: reason.value, now: new Date() }));
            toast('Tankvorgang storniert', 'ok');
          },
        },
      ],
    });
  }

  async function toggleAuto() {
    try {
      await app().mutate((d) => {
        d.settings.fuelAuto = !d.settings.fuelAuto;
      });
      toast(app().S.settings.fuelAuto ? 'Automatikmodus eingeschaltet: Kunden kommen selbstständig' : 'Automatikmodus ausgeschaltet', 'info');
    } catch (err) {
      errorToast(err);
    }
  }

  POS.PumpView = { build, buildMini, update, live, openSheet };
})(typeof window !== 'undefined' ? window : globalThis);
