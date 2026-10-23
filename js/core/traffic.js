/**
 * Dynamischer Kundenverkehr: Betriebsphasen, Tageszeit, Warteschlange und Ankünfte.
 *
 * Traffic.step(d, now, rng) wird einmal pro Simulationstakt aufgerufen (über Pumps.advance).
 * Die Phasen wechseln nach gewichteten Zufallsentscheidungen mit Gedächtnis: Nach intensiven Phasen
 * folgen häufiger ruhige Phasen. Verpasste Wechsel werden nach einer Pause NICHT nachgeholt,
 * es gibt höchstens einen Wechsel pro Takt.
 *
 * Der Zustand liegt in d.traffic (wird mit dem Spielstand gespeichert). Statistik je Schicht in d.traffic.stats.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const S = () => POS.Sim;

  const PHASES = ['RUHIG', 'NORMAL', 'STOSSZEIT', 'EXTREM'];
  const PHASE_LABEL = { RUHIG: 'Ruhig', NORMAL: 'Normal', STOSSZEIT: 'Stoßzeit', EXTREM: 'Extrembetrieb' };
  const BASE_WEIGHTS = { RUHIG: 30, NORMAL: 45, STOSSZEIT: 20, EXTREM: 5 };
  /** Dauer einer Phase in simulierten Minuten (Bereich). */
  const DURATION_MIN = { RUHIG: [5, 20], NORMAL: [8, 25], STOSSZEIT: [4, 12], EXTREM: [2, 6] };
  /** Ankünfte je simulierter Minute bei Schwierigkeitsgrad „Realistisch“. */
  const ARRIVALS_PER_MIN = { RUHIG: 0.4, NORMAL: 1.0, STOSSZEIT: 2.2, EXTREM: 3.5 };

  const DAYPART_LABEL = { FRUEH: 'Frühmorgens', MITTAG: 'Mittags', NACHMITTAG: 'Nachmittags', ABEND: 'Abends', NACHT: 'Nachts' };
  const DAYPART_PHASE_MUL = {
    FRUEH: { RUHIG: 0.7, NORMAL: 1.1, STOSSZEIT: 1.6, EXTREM: 0.8 },
    MITTAG: { RUHIG: 1, NORMAL: 1.1, STOSSZEIT: 1, EXTREM: 1 },
    NACHMITTAG: { RUHIG: 0.8, NORMAL: 1, STOSSZEIT: 1.4, EXTREM: 1.2 },
    ABEND: { RUHIG: 1, NORMAL: 1, STOSSZEIT: 1, EXTREM: 1 },
    NACHT: { RUHIG: 2.2, NORMAL: 0.8, STOSSZEIT: 0.3, EXTREM: 0.1 },
  };
  const DAYPART_ARRIVAL_MUL = { FRUEH: 1.3, MITTAG: 1.0, NACHMITTAG: 1.2, ABEND: 0.9, NACHT: 0.35 };

  /** Kundentypen mit Gewichten je Tageszeit. Das Verhalten unterscheidet sich über Dauer und Zahlweise (siehe unten). */
  const CUSTOMER_TYPES = {
    PENDLER: { label: 'Pendler', weights: { FRUEH: 40, MITTAG: 10, NACHMITTAG: 25, ABEND: 15, NACHT: 2 }, shop: 0.25, cash: 0.35 },
    GELEGENHEIT: { label: 'Gelegenheitskunde', weights: { FRUEH: 10, MITTAG: 25, NACHMITTAG: 20, ABEND: 20, NACHT: 15 }, shop: 0.4, cash: 0.5 },
    VIELFAHRER: { label: 'Vielfahrer', weights: { FRUEH: 15, MITTAG: 15, NACHMITTAG: 25, ABEND: 20, NACHT: 25 }, shop: 0.15, cash: 0.2 },
    SHOPKUNDE: { label: 'Shopkunde', weights: { FRUEH: 20, MITTAG: 30, NACHMITTAG: 20, ABEND: 20, NACHT: 15 }, shop: 1, cash: 0.6 },
    KLEINER_TANK: { label: 'Kleiner Tankbetrag', weights: { FRUEH: 10, MITTAG: 15, NACHMITTAG: 15, ABEND: 20, NACHT: 20 }, shop: 0.3, cash: 0.55 },
    GROSSER_TANK: { label: 'Großer Tankbetrag', weights: { FRUEH: 5, MITTAG: 5, NACHMITTAG: 5, ABEND: 5, NACHT: 23 }, shop: 0.1, cash: 0.15 },
  };

  const INTENSE = ['STOSSZEIT', 'EXTREM'];
  const MAX_HISTORY = 6;

  function daypart(hour) {
    if (hour >= 5 && hour < 10) return 'FRUEH';
    if (hour >= 10 && hour < 15) return 'MITTAG';
    if (hour >= 15 && hour < 19) return 'NACHMITTAG';
    if (hour >= 19 && hour < 22) return 'ABEND';
    return 'NACHT';
  }

  /**
   * Gewichte für die nächste Phase. Berücksichtigt Tageszeit, Gedächtnis (vorherige Phase),
   * Schwierigkeitsgrad. Nach intensiven Phasen wird Ruhe bevorzugt.
   */
  function phaseWeights({ prev, hour, difficulty }) {
    const part = daypart(hour);
    const out = {};
    for (const p of PHASES) {
      let w = BASE_WEIGHTS[p] * DAYPART_PHASE_MUL[part][p];
      if (p === 'RUHIG' && prev && INTENSE.includes(prev)) w *= 2.5;
      if (p === prev) w *= 0.5;
      if (p === 'RUHIG') w *= difficulty.calm;
      if (INTENSE.includes(p)) w *= difficulty.peak;
      out[p] = w;
    }
    return out;
  }

  function nextPhase(rng, { prev, hour, difficulty }) {
    const w = phaseWeights({ prev, hour, difficulty });
    return S().pick(rng, PHASES.map((p) => ({ key: p, weight: w[p] }))).key;
  }

  /** Dauer einer Phase in Millisekunden. Die Simulationsgeschwindigkeit verkürzt die reale Zeit. */
  function phaseDurationMs(rng, phase, speed = 1) {
    const [lo, hi] = DURATION_MIN[phase];
    const minutes = lo + rng() * (hi - lo);
    return Math.round((minutes * 60000) / speed);
  }

  /** Ankünfte je simulierter Minute. */
  function arrivalsPerMin(phase, hour, difficulty) {
    return ARRIVALS_PER_MIN[phase] * DAYPART_ARRIVAL_MUL[daypart(hour)] * difficulty.arrival;
  }

  function customerType(rng, hour) {
    const part = daypart(hour);
    const items = Object.entries(CUSTOMER_TYPES).map(([key, x]) => ({ key, weight: x.weights[part] }));
    return S().pick(rng, items).key;
  }

  function emptyStats() {
    return { arrivals: 0, driveOff: 0, queueMax: 0, stoss: 0, waitSumMs: 0, waitCount: 0, types: {} };
  }

  /** Startzustand (wird beim Schema-Upgrade angelegt). */
  function initialState(now = new Date()) {
    return {
      phase: 'NORMAL',
      prevPhase: null,
      until: new Date(now.getTime() + 10 * 60000).toISOString(),
      history: [],
      queue: [],
      stats: {},
    };
  }

  function ensureStats(d, shiftId) {
    d.traffic.stats[shiftId] = d.traffic.stats[shiftId] || emptyStats();
    return d.traffic.stats[shiftId];
  }

  /**
   * Ein Simulationstakt. Gibt true zurück, wenn sich etwas geändert hat.
   * Reihenfolge: Phasenwechsel (höchstens einer), Wartende abfertigen oder abwandern lassen,
   * Ankunft (Zapfsäule, Warteschlange oder Wegfahren).
   */
  function step(d, now = new Date(), rng = Math.random) {
    if (!d.traffic) d.traffic = initialState(now);
    const T = d.traffic;
    const speed = d.settings.simSpeed || 1;
    const difficulty = S().DIFFICULTY[d.settings.difficulty] || S().DIFFICULTY.REALISTISCH;
    const shift = POS.Ledger.currentShift(d);
    const t = now.getTime();
    let changed = false;

    if (t >= Date.parse(T.until)) {
      const prev = T.phase;
      const hour = now.getHours();
      const next = nextPhase(rng, { prev, hour, difficulty });
      T.history = T.history.concat([{ phase: prev, ts: now.toISOString() }]).slice(-MAX_HISTORY);
      T.prevPhase = prev;
      T.phase = next;
      T.until = new Date(t + phaseDurationMs(rng, next, speed)).toISOString();
      if (shift && INTENSE.includes(next)) ensureStats(d, shift.id).stoss += 1;
      changed = true;
    }
    if (!shift) return changed;

    const stats = ensureStats(d, shift.id);
    const maxWaitMs = ((d.settings.queueWaitMin || 4) * 60000) / speed;
    const kept = T.queue.filter((q) => t - Date.parse(q.at) <= maxWaitMs);
    if (kept.length !== T.queue.length) {
      stats.driveOff += T.queue.length - kept.length;
      T.queue = kept;
      changed = true;
    }

    const freePumps = () => d.pumps.filter((p) => p.status === 'FREI' && POS.Pumps.fuelOf(d, p.fuelId).stockMl > 0);
    while (T.queue.length && freePumps().length) {
      const q = T.queue.shift();
      const p = freePumps()[0];
      POS.Pumps.lift(d, { pumpId: p.id, now, rng, auto: true });
      stats.waitSumMs += t - Date.parse(q.at);
      stats.waitCount += 1;
      changed = true;
    }

    const perSec = (arrivalsPerMin(T.phase, now.getHours(), difficulty) * speed) / 60;
    if (rng() < perSec) {
      const type = customerType(rng, now.getHours());
      stats.arrivals += 1;
      stats.types[type] = (stats.types[type] || 0) + 1;
      const free = freePumps();
      if (free.length) {
        POS.Pumps.lift(d, { pumpId: free[0].id, now, rng, auto: true });
      } else if (T.queue.length < (d.settings.queueMax ?? 3)) {
        T.queue.push({ id: stats.arrivals, at: now.toISOString(), type });
      } else {
        stats.driveOff += 1;
      }
      stats.queueMax = Math.max(stats.queueMax, T.queue.length);
      changed = true;
    }
    return changed;
  }

  /** Kurze Anzeige für die Kasse, z. B. „Stoßzeit · 2 wartend“. */
  function badge(d) {
    if (!d.traffic || !d.settings.fuelAuto || d.settings.trafficOn === false) return null;
    const wait = d.traffic.queue.length ? ` · ${d.traffic.queue.length} wartend` : '';
    return `${PHASE_LABEL[d.traffic.phase]}${wait}`;
  }

  /** Auswertung einer Schicht für den Schichtbericht. */
  function shiftStats(d, shift) {
    const s = (d.traffic && d.traffic.stats[shift.id]) || emptyStats();
    return {
      kunden: s.arrivals,
      wegfahrer: s.driveOff,
      warteschlangeMax: s.queueMax,
      stoss: s.stoss,
      wartezeitSchnitt: s.waitCount ? Math.round(s.waitSumMs / s.waitCount) : null,
      typen: s.types,
    };
  }

  POS.Traffic = {
    PHASES,
    PHASE_LABEL,
    BASE_WEIGHTS,
    DURATION_MIN,
    ARRIVALS_PER_MIN,
    DAYPART_LABEL,
    CUSTOMER_TYPES,
    daypart,
    phaseWeights,
    nextPhase,
    phaseDurationMs,
    arrivalsPerMin,
    customerType,
    initialState,
    step,
    badge,
    shiftStats,
  };
})(typeof window !== 'undefined' ? window : globalThis);
