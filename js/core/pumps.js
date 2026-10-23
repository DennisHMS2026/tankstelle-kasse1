/**
 * Virtuelle Zapfsäulen: Zustandsmaschine, Tankvorgänge und Kundensimulation.
 *
 * Alle Funktionen arbeiten auf dem Entwurf (draft) wie js/core/ledger.js und werden
 * über App.mutate gespeichert. Zeitpunkte werden übergeben (now), damit Tests deterministisch laufen.
 *
 * Zustandsübergänge (Zapfsäule):
 *   FREI → ENTNOMMEN → WARTET_FREIGABE → TANKT → BEENDET → ZAHLUNG_AUSSTEHEND → BEZAHLT → FREI
 *   WARTET_FREIGABE → FREI (abgebrochen)     FREI/WARTET_FREIGABE ↔ GESPERRT
 *   jeder Zustand außer ZAHLUNG_AUSSTEHEND/BEZAHLT → STOERUNG → FREI oder ZAHLUNG_AUSSTEHEND
 *
 * Tankvorgang (Tank): LAUFEND → OFFEN → IM_WARENKORB → BEZAHLT   (OFFEN → STORNIERT)
 *   Ein Tankvorgang kann höchstens einmal in einen Bon gelangen und nur einmal bezahlt werden.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const R = POS.Rules;
  const F = POS.Fuel;
  const L = POS.Ledger;
  const C = POS.Cart;
  const fail = R.fail;

  const pad = (n, len) => String(n).padStart(len, '0');

  const LABEL = {
    FREI: 'Frei',
    ENTNOMMEN: 'Zapfpistole entnommen',
    WARTET_FREIGABE: 'Wartet auf Freigabe',
    TANKT: 'Tanken läuft',
    BEENDET: 'Tankvorgang beendet',
    ZAHLUNG_AUSSTEHEND: 'Zahlung ausstehend',
    BEZAHLT: 'Bezahlt',
    GESPERRT: 'Gesperrt',
    STOERUNG: 'Störung',
  };

  const TRANSITIONS = {
    FREI: ['ENTNOMMEN', 'GESPERRT', 'STOERUNG'],
    ENTNOMMEN: ['WARTET_FREIGABE', 'FREI', 'STOERUNG'],
    WARTET_FREIGABE: ['TANKT', 'FREI', 'GESPERRT', 'STOERUNG'],
    TANKT: ['BEENDET', 'STOERUNG'],
    BEENDET: ['ZAHLUNG_AUSSTEHEND', 'FREI', 'STOERUNG'],
    ZAHLUNG_AUSSTEHEND: ['BEZAHLT', 'FREI'],
    BEZAHLT: ['FREI'],
    GESPERRT: ['FREI'],
    STOERUNG: ['FREI', 'ZAHLUNG_AUSSTEHEND'],
  };

  const AUTO_RELEASE_MIN_MS = 2000;
  const AUTO_RELEASE_RANGE_MS = 3000;
  const PAID_RESET_MS = 8000;
  const OPEN_TANK = ['OFFEN', 'IM_WARENKORB'];

  function pumpOf(d, id) {
    const p = d.pumps.find((x) => x.id === id);
    if (!p) throw fail('ZAPFSAEULE_NICHT_GEFUNDEN', `Zapfsäule ${id} nicht gefunden`);
    return p;
  }

  function tankById(d, id) {
    const t = d.tanks.find((x) => x.id === id);
    if (!t) throw fail('TANK_NICHT_GEFUNDEN', `Tankvorgang ${id} nicht gefunden`);
    return t;
  }

  function fuelOf(d, id) {
    const f = d.fuels.find((x) => x.id === id);
    if (!f) throw fail('KRAFTSTOFF_UNBEKANNT', `Kraftstoff ${id} unbekannt`);
    return f;
  }

  function setStatus(d, pump, to, now, { nextAt = null, cashierId = null, approverId = null, text = '' } = {}) {
    const from = pump.status;
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
      throw fail('ZAPFSAEULE_UNGUELTIG', `Zapfsäule ${pump.id}: Wechsel von „${LABEL[from]}“ nach „${LABEL[to]}“ ist nicht zulässig`);
    }
    pump.status = to;
    pump.since = now.toISOString();
    pump.nextAt = nextAt;
    const shift = L.currentShift(d);
    L.logEvent(d, {
      type: 'ZAPFSAEULE',
      text: `Zapfsäule ${pump.id}: ${LABEL[from]} → ${LABEL[to]}${text ? ` (${text})` : ''}`,
      cashierId,
      approverId,
      shiftId: shift ? shift.id : null,
      now,
    });
  }

  function randomTarget(rng) {
    const v = 10000 + Math.floor(rng() * 40001); // 10 bis 50 Liter
    return v - (v % 100); // auf 100 ml gerundet
  }

  function randomFlow(rng) {
    return 600 + Math.floor(rng() * 101); // 600 bis 700 ml/s, also 36 bis 42 Liter pro Minute
  }

  /** Zapfpistole entnommen und sofort Wartezustand. Im Automatikmodus folgt die Freigabe per Zeitplan. */
  function lift(d, { pumpId, cashierId = null, now = new Date(), rng = Math.random, auto = false }) {
    const p = pumpOf(d, pumpId);
    if (p.status !== 'FREI') throw fail('ZAPFSAEULE_UNGUELTIG', `Zapfsäule ${pumpId} ist nicht frei`);
    const fuel = fuelOf(d, p.fuelId);
    if (fuel.stockMl <= 0) throw fail('KRAFTSTOFF_LEER', `${fuel.name} ist nicht verfügbar (Tank leer)`);
    setStatus(d, p, 'ENTNOMMEN', now, { cashierId, text: auto ? 'Kundensimulation' : 'Simulation' });
    const delay = auto ? AUTO_RELEASE_MIN_MS + Math.floor(rng() * AUTO_RELEASE_RANGE_MS) : null;
    setStatus(d, p, 'WARTET_FREIGABE', now, { cashierId, nextAt: delay === null ? null : now.getTime() + delay });
    return p;
  }

  /** Freigabe: Tankvorgang beginnt. Der Literpreis wird jetzt eingefroren. */
  function release(d, { pumpId, cashierId = null, now = new Date(), rng = Math.random }) {
    const p = pumpOf(d, pumpId);
    if (p.status !== 'WARTET_FREIGABE') throw fail('ZAPFSAEULE_UNGUELTIG', `Zapfsäule ${pumpId} wartet nicht auf Freigabe`);
    const shift = L.requireShift(d);
    const fuel = fuelOf(d, p.fuelId);
    if (fuel.stockMl <= 0) throw fail('KRAFTSTOFF_LEER', `${fuel.name} ist nicht verfügbar (Tank leer)`);
    const tank = {
      id: 'T' + pad(L.nextId(d, 'tank'), 5),
      pumpId: p.id,
      fuelId: fuel.id,
      fuelName: fuel.name,
      priceMilli: fuel.priceMilli,
      vat: fuel.vat,
      status: 'LAUFEND',
      startedAt: now.toISOString(),
      ml: 0, // gespeicherter Fortschritt in ml
      lastAt: now.toISOString(), // Zeitpunkt des letzten Fortschritts
      targetMl: randomTarget(rng),
      flowMlPerSec: randomFlow(rng),
      mlFinal: null,
      amountCents: null,
      endedAt: null,
      cartId: null,
      bonNr: null,
      paidAt: null,
      shiftId: shift.id,
      cashierId,
    };
    d.tanks.push(tank);
    p.tankId = tank.id;
    setStatus(d, p, 'TANKT', now, { cashierId, text: `${fuel.name}, ${fuel.priceMilli ? F.formatPricePerLiter(fuel.priceMilli) : ''}` });
    return tank;
  }

  /**
   * Tankvorgang beenden: Menge wird festgeschrieben, Betrag berechnet, Lagerbestand reduziert.
   * next: Zustand nach dem Tankvorgang (ZAHLUNG_AUSSTEHEND oder STOERUNG).
   */
  function finish(d, pump, now, { reason = '', cashierId = null, next = 'ZAHLUNG_AUSSTEHEND', stored = false } = {}) {
    const tank = tankById(d, pump.tankId);
    // stored: nur der gespeicherte Stand zählt (Unterbrechung), kein Zuwachs mehr
    const ml = stored ? tank.ml : F.mlAt(tank, now.getTime());
    tank.mlFinal = ml;
    tank.endedAt = now.toISOString();
    setStatus(d, pump, 'BEENDET', now, { cashierId, text: reason });
    if (ml === 0) {
      tank.status = 'STORNIERT';
      tank.amountCents = 0;
      setStatus(d, pump, 'FREI', now, { cashierId, text: 'kein Kraftstoff abgegeben' });
      pump.tankId = null;
      return tank;
    }
    tank.status = 'OFFEN';
    tank.amountCents = F.amountCents(ml, tank.priceMilli);
    fuelOf(d, tank.fuelId).stockMl -= ml;
    setStatus(d, pump, next, now, { cashierId, text: F.formatMl(ml) });
    return tank;
  }

  /** Kassierer stoppt den Tankvorgang manuell. */
  function stop(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    if (p.status !== 'TANKT') throw fail('ZAPFSAEULE_UNGUELTIG', `Zapfsäule ${pumpId} tankt nicht`);
    return finish(d, p, now, { reason: 'Stopp durch Kassierer', cashierId });
  }

  /** Wartende Pistole wieder einhängen. */
  function cancel(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    setStatus(d, p, 'FREI', now, { cashierId, text: 'abgebrochen' });
    p.tankId = null;
  }

  function lock(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    setStatus(d, p, 'GESPERRT', now, { cashierId, text: 'durch Kassierer' });
  }

  function unlock(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    setStatus(d, p, 'FREI', now, { cashierId, text: 'entsperrt' });
  }

  /** Störung. Läuft ein Tankvorgang, wird die bisher gezapfte Menge übernommen. */
  function fault(d, { pumpId, cashierId = null, now = new Date(), reason = 'Störung gemeldet' }) {
    const p = pumpOf(d, pumpId);
    if (p.status === 'TANKT') finish(d, p, now, { reason: 'Störung während des Tankens', cashierId, next: 'STOERUNG' });
    else setStatus(d, p, 'STOERUNG', now, { cashierId, text: reason });
  }

  function clearFault(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    const tank = p.tankId ? d.tanks.find((t) => t.id === p.tankId) : null;
    const open = !!tank && OPEN_TANK.includes(tank.status);
    setStatus(d, p, open ? 'ZAHLUNG_AUSSTEHEND' : 'FREI', now, { cashierId, text: 'Störung behoben' });
    if (!open) p.tankId = null;
  }

  function resetPaid(d, { pumpId, cashierId = null, now = new Date() }) {
    const p = pumpOf(d, pumpId);
    setStatus(d, p, 'FREI', now, { cashierId, text: 'zurückgesetzt' });
    p.tankId = null;
  }

  /** Tankvorgang in den Bon legen. Der Tankvorgang ist danach reserviert. */
  function attachToCart(d, { tankId, cashierId, now = new Date() }) {
    const shift = L.requireShift(d);
    const tank = tankById(d, tankId);
    if (tank.status !== 'OFFEN') {
      const why = tank.status === 'IM_WARENKORB' ? 'bereits im Bon' : tank.status === 'BEZAHLT' ? 'bereits bezahlt' : tank.status === 'LAUFEND' ? 'läuft noch' : 'nicht mehr verfügbar';
      throw fail('TANK_NICHT_VERFUEGBAR', `Tankvorgang ${tank.id} ist ${why}`);
    }
    if (!(tank.amountCents > 0)) throw fail('TANK_LEER', `Tankvorgang ${tank.id} hat keinen Betrag`);
    const cart = d.cart || C.newCart({ cashierId, shiftId: shift.id, kassenNr: d.settings.kassenNr });
    d.cart = C.addFuel(cart, tank);
    tank.status = 'IM_WARENKORB';
    tank.cartId = d.cart.id;
    L.logEvent(d, { type: 'TANK_IM_BON', text: `Tankvorgang ${tank.id} (${tank.fuelName}, ${F.formatMl(tank.mlFinal)}) in den Bon übernommen`, cashierId, shiftId: shift.id, now });
    return tank;
  }

  /** Wird aufgerufen, wenn eine Kraftstoffzeile aus dem Bon entfernt wird. */
  function detachFromCart(d, tank) {
    tank.status = 'OFFEN';
    tank.cartId = null;
  }

  /** Beim Bezahlen: Tankvorgang gilt als bezahlt, Zapfsäule geht auf BEZAHLT. */
  function markPaid(d, tank, now, bonNr) {
    tank.status = 'BEZAHLT';
    tank.bonNr = bonNr;
    tank.paidAt = now.toISOString();
    tank.cartId = null;
    const p = d.pumps.find((x) => x.tankId === tank.id);
    if (p && p.status === 'ZAHLUNG_AUSSTEHEND') {
      setStatus(d, p, 'BEZAHLT', now, { nextAt: now.getTime() + PAID_RESET_MS, text: bonNr });
    }
  }

  /** Offener Tankvorgang wird storniert (Kunde ist ohne Bezahlung gefahren). Freigabe ist Pflicht. */
  function cancelTank(d, { tankId, cashierId, approverId, reason, now = new Date() }) {
    const tank = tankById(d, tankId);
    if (tank.status !== 'OFFEN') throw fail('TANK_NICHT_VERFUEGBAR', `Tankvorgang ${tank.id} kann nicht storniert werden (${tank.status})`);
    if (!reason || !reason.trim()) throw fail('GRUND_FEHLT', 'Bitte einen Grund angeben');
    tank.status = 'STORNIERT';
    tank.endedAt = tank.endedAt || now.toISOString();
    const p = d.pumps.find((x) => x.tankId === tank.id);
    if (p) {
      if (p.status === 'ZAHLUNG_AUSSTEHEND') setStatus(d, p, 'FREI', now, { cashierId, approverId, text: 'Tankvorgang storniert' });
      p.tankId = null;
    }
    L.logEvent(d, { type: 'TANK_STORNO', text: `Tankvorgang ${tank.id} storniert: ${reason.trim()}`, cashierId, approverId, shiftId: L.currentShift(d) ? L.currentShift(d).id : null, now });
  }

  function resetPaidDue(d, p, now) {
    setStatus(d, p, 'FREI', now, { text: 'automatisch' });
    p.tankId = null;
  }

  /** Muss der Ticker laufen? Nur wenn Automatik an ist oder Zustände sich zeitlich ändern. */
  function needsTick(d) {
    return !!d.settings.fuelAuto || d.pumps.some((p) => p.status === 'TANKT' || p.nextAt);
  }

  /**
   * Eine Simulationssekunde: zeitgesteuerte Übergänge, Kundenankunft, Zufallsstörungen.
   * rng liefert [0,1). Gibt true zurück, wenn sich etwas geändert hat.
   */
  function advance(d, now = new Date(), rng = Math.random) {
    let changed = false;
    const t = now.getTime();
    const shiftOpen = !!L.currentShift(d);
    for (const p of d.pumps) {
      if (p.status === 'TANKT') {
        const tank = tankById(d, p.tankId);
        // Fortschritt festschreiben (inkrementell, siehe fuel.js)
        tank.ml = F.mlAt(tank, t);
        if (t > Date.parse(tank.lastAt)) tank.lastAt = now.toISOString(); // nie rückwärts
        if (tank.ml >= tank.targetMl) {
          finish(d, p, now, { reason: 'Ziel erreicht', stored: true });
          changed = true;
        } else if (d.settings.fuelFaultPerHour > 0 && rng() < d.settings.fuelFaultPerHour / 3600) {
          fault(d, { pumpId: p.id, now, reason: 'Zufallsstörung (Simulation)' });
          changed = true;
        }
      } else if (p.nextAt && t >= p.nextAt) {
        if (p.status === 'WARTET_FREIGABE' && d.settings.fuelAuto && shiftOpen) {
          release(d, { pumpId: p.id, now, rng });
          changed = true;
        } else if (p.status === 'BEZAHLT' && d.settings.fuelAuto) {
          resetPaidDue(d, p, now);
          changed = true;
        }
      }
    }
    if (d.settings.fuelAuto && rng() < (d.settings.fuelArrivalPerMin || 0) / 60) {
      const free = d.pumps.filter((p) => p.status === 'FREI' && fuelOf(d, p.fuelId).stockMl > 0);
      if (free.length) {
        const p = free[Math.floor(rng() * free.length)];
        lift(d, { pumpId: p.id, now, rng, auto: true });
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Unterbrechung (App neu gestartet, Pause im Hintergrund): laufende Tankvorgänge werden mit dem
   * zuletzt gespeicherten Stand beendet und zur Kasse gegeben. Es wird nichts nachberechnet.
   * Gibt die Anzahl unterbrochener Vorgänge zurück.
   */
  function interrupt(d, now = new Date(), reason = 'Unterbrechung') {
    let n = 0;
    for (const p of d.pumps) {
      if (p.status !== 'TANKT') continue;
      finish(d, p, now, { reason: `${reason}, Stand gespeichert`, stored: true });
      n++;
    }
    return n;
  }

  /** Offene Tankvorgänge (noch nicht im Bon) für die Anzeige an der Kasse. */
  function openTanks(d) {
    return d.tanks.filter((t) => t.status === 'OFFEN');
  }

  POS.Pumps = {
    LABEL,
    TRANSITIONS,
    lift,
    release,
    stop,
    cancel,
    lock,
    unlock,
    fault,
    clearFault,
    resetPaid,
    attachToCart,
    detachFromCart,
    markPaid,
    cancelTank,
    needsTick,
    advance,
    interrupt,
    openTanks,
    pumpOf,
    tankById,
    fuelOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
