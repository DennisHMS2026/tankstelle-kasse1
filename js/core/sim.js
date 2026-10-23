/**
 * Zahlungssimulation: Szenarien, Gewichte, Dauern und Ereignisse virtueller Kunden.
 *
 * Reine Funktionen. rng liefert Werte in [0,1) und macht jeden Ablauf nachvollziehbar und testbar.
 * Es wird nichts gebucht und nichts angezeigt. Die Oberfläche (js/ui/automat-view.js,
 * js/ui/terminal-view.js) führt den Plan aus und bucht über POS.Ledger.
 *
 * Alle Wahrscheinlichkeiten und Dauern sind Simulationsparameter, keine Branchenstatistiken.
 * Beträge sind ganzzahlige Cent.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  /** Schwierigkeitsgrade: Faktoren für Kundenankünfte, Stoßzeiten, Ruhephasen und Störungen. */
  const DIFFICULTY = {
    ENTSPANNT: { label: 'Entspannt', arrival: 0.6, peak: 0.5, calm: 2.0, fault: 0.5 },
    REALISTISCH: { label: 'Realistisch', arrival: 1.0, peak: 1.0, calm: 1.0, fault: 1.0 },
    HERAUSFORDERND: { label: 'Herausfordernd', arrival: 1.5, peak: 1.6, calm: 0.7, fault: 1.5 },
    CHAOS: { label: 'Chaos', arrival: 2.2, peak: 2.5, calm: 0.3, fault: 2.0 },
  };

  /** Bargeldzahlung: Dauer in Millisekunden. Gewichte 75/15/8/2 als Ausgangswerte. */
  const CASH_SPEED = {
    NORMAL: { weight: 75, min: 8000, max: 14000 },
    SCHNELL: { weight: 15, min: 4000, max: 7000 },
    LANGSAM: { weight: 8, min: 15000, max: 25000 },
    STOERUNG: { weight: 2, min: 15000, max: 25000 },
  };

  /** Kartenzahlung: Dauer in Millisekunden, PIN-Eingabe kommt dazu. */
  const CARD_SPEED = {
    NORMAL: { weight: 75, min: 5000, max: 9000 },
    SCHNELL: { weight: 15, min: 2000, max: 4000 },
    LANGSAM: { weight: 8, min: 10000, max: 18000 },
    STOERUNG: { weight: 2, min: 10000, max: 18000 },
  };

  const CARD_METHODS = [
    { key: 'KONTAKTLOS', label: 'Kontaktlos', hold: 'Karte vorhalten', pin: false, weight: 50 },
    { key: 'KARTE_EINSTECKEN', label: 'Karte einstecken', hold: 'Karte einstecken', pin: true, weight: 18 },
    { key: 'SMARTPHONE', label: 'Smartphone', hold: 'Smartphone vorhalten', pin: false, weight: 12 },
    { key: 'SMARTWATCH', label: 'Smartwatch', hold: 'Smartwatch vorhalten', pin: false, weight: 5 },
    { key: 'KARTE_PIN', label: 'Karte mit PIN', hold: 'Karte einstecken', pin: true, weight: 10 },
    { key: 'KONTAKTLOS_PIN', label: 'Kontaktlos mit PIN', hold: 'Karte vorhalten', pin: true, weight: 5 },
  ];

  /** Wie der Kunde bezahlt: Stückelung der Einzahlung. */
  const CASH_STRATEGIES = [
    { key: 'PASSEND', label: 'passend', weight: 35 },
    { key: 'GROESSER', label: 'größerer Schein', weight: 20 },
    { key: 'MEHRERE', label: 'mehrere Scheine', weight: 15 },
    { key: 'KOMBI', label: 'Scheine und Münzen', weight: 15 },
    { key: 'SCHRITTWEISE', label: 'schrittweise', weight: 15 },
  ];

  const DENOMS_ASC = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const NOTES_ASC = [500, 1000, 2000, 5000, 10000, 20000];

  /** Ausgangswerte für Ereignisse je Einwurf bzw. je Zahlung (vor Schwierigkeitsfaktor). */
  const EVENT_BASE = {
    coinNotRecognized: 0.04,
    noteRejected: 0.05,
    acceptDelay: 0.08,
    slowChange: 0.12,
    cardNotRecognized: 0.06,
    cardSlow: 0.08,
    cardSwitch: 0.02,
  };

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function pick(rng, items) {
    const total = items.reduce((s, x) => s + x.weight, 0);
    let r = rng() * total;
    for (const x of items) {
      r -= x.weight;
      if (r < 0) return x;
    }
    return items[items.length - 1];
  }

  const between = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

  /** Zerlegt einen Betrag in Stücke aus den erlaubten Stückelungen (aufsteigend sortiert). */
  function decompose(rng, amount, denoms) {
    const out = [];
    let rest = amount;
    while (rest > 0) {
      const fit = denoms.filter((v) => v <= rest);
      if (!fit.length) throw new Error('Betrag nicht zerlegbar');
      const v = out.length > 24 || rng() < 0.7 ? fit[fit.length - 1] : fit[Math.floor(rng() * fit.length)];
      out.push(v);
      rest -= v;
    }
    return out;
  }

  /** Einzahlung je Strategie. Die Summe ist immer mindestens der offene Betrag. */
  function buildInserts(rng, due, strategy) {
    if (strategy === 'GROESSER') {
      // Ein größerer Schein. Übersteigt der Betrag den größten Schein, mehrere 200-€-Scheine.
      const note = NOTES_ASC.find((v) => v >= due);
      return note ? [note] : Array.from({ length: Math.ceil(due / 20000) }, () => 20000);
    }
    if (strategy === 'MEHRERE') return decompose(rng, Math.ceil(due / 500) * 500, NOTES_ASC);
    if (strategy === 'KOMBI') return decompose(rng, Math.ceil(due / 100) * 100, DENOMS_ASC);
    return decompose(rng, due, DENOMS_ASC);
  }

  /**
   * Plan einer Bargeldzahlung. due: offener Betrag in Cent (0 = nur noch Rückgeld).
   * opts: { difficulty, events: { coins, cards, slow }, faults (Faktor, 0 = aus), speed }
   */
  function planCash(rng, { dueCents, difficulty = DIFFICULTY.REALISTISCH, events = {}, faults = 1 }) {
    const fm = clamp(faults * difficulty.fault, 0, 4);
    const speedKey = pick(rng, Object.entries(CASH_SPEED).map(([key, x]) => ({ key, weight: key === 'STOERUNG' ? CASH_SPEED.STOERUNG.weight * fm : x.weight }))).key;
    const sp = CASH_SPEED[speedKey];
    const durationMs = between(rng, sp.min, sp.max);
    const strategy = pick(rng, CASH_STRATEGIES).key;
    const seq = dueCents > 0 ? buildInserts(rng, dueCents, strategy) : [];
    const serious = speedKey === 'STOERUNG' && seq.length ? Math.floor(rng() * seq.length) : -1;
    const shares = seq.map(() => 0.5 + rng());
    const shareSum = shares.reduce((s, x) => s + x, 0) || 1;
    const insertBudget = durationMs * 0.7;
    const inserts = seq.map((value, i) => {
      const isNote = value >= 500;
      const fault = [];
      if (events.coins !== false && !isNote && rng() < EVENT_BASE.coinNotRecognized * fm) fault.push('MUENZE_NICHT_ERKANNT');
      if (events.coins !== false && isNote && rng() < EVENT_BASE.noteRejected * fm) fault.push('SCHEIN_ABGELEHNT');
      const extra = events.slow !== false && rng() < EVENT_BASE.acceptDelay * fm ? between(rng, 1000, 3000) : 0;
      return {
        value,
        kind: isNote ? 'SCHEIN' : 'MUENZE',
        pauseMs: Math.round((insertBudget * shares[i]) / shareSum) + extra,
        fault: fault[0] || null,
        serious: i === serious,
        seriousKind: i === serious ? (isNote && rng() < 0.6 ? 'SCHEIN_KLEMMT' : 'AUSSER_BETRIEB') : null,
      };
    });
    const changeExtra = events.slow !== false && rng() < EVENT_BASE.slowChange * fm ? between(rng, 1500, 4000) : 0;
    return {
      kind: 'BAR',
      speed: speedKey,
      strategy,
      durationMs,
      dueCents,
      totalCents: seq.reduce((s, v) => s + v, 0),
      inserts,
      changeDelayMs: Math.round(durationMs * 0.3) + changeExtra,
      seriousIndex: serious,
    };
  }

  /**
   * Plan einer Kartenzahlung. Gleiche Gewichte wie Bar. Abgelehnte Versuche wiederholt der Kunde
   * einmal automatisch. Bleibt die Zahlung abgelehnt, ist ein Eingriff des Kassierers nötig.
   */
  function planCard(rng, { dueCents, difficulty = DIFFICULTY.REALISTISCH, declineRate = 0.1, events = {}, faults = 1 }) {
    const fm = clamp(faults * difficulty.fault, 0, 4);
    const speedKey = pick(rng, Object.entries(CARD_SPEED).map(([key, x]) => ({ key, weight: key === 'STOERUNG' ? CARD_SPEED.STOERUNG.weight * fm : x.weight }))).key;
    const sp = CARD_SPEED[speedKey];
    const method = pick(rng, CARD_METHODS);
    const durationMs = between(rng, sp.min, sp.max);
    const pinMs = method.pin ? between(rng, 2000, 4000) : 0;
    const notRecognized = events.cards !== false && rng() < EVENT_BASE.cardNotRecognized * fm;
    const slow = events.slow !== false && rng() < EVENT_BASE.cardSlow * fm ? between(rng, 3000, 6000) : 0;
    const attempts = [];
    const declineP = clamp(declineRate * fm, 0, 0.9);
    attempts.push(rng() < declineP ? 'ABGELEHNT' : 'GENEHMIGT');
    if (attempts[0] === 'ABGELEHNT') attempts.push(rng() < 0.5 ? 'GENEHMIGT' : 'ABGELEHNT');
    let outcome = attempts[attempts.length - 1] === 'GENEHMIGT' ? 'GENEHMIGT' : 'ABGELEHNT';
    if (outcome === 'ABGELEHNT' && events.cards !== false && rng() < EVENT_BASE.cardSwitch * fm) outcome = 'WECHSEL';
    return {
      kind: 'KARTE',
      speed: speedKey,
      method: method.key,
      methodLabel: method.label,
      hold: method.hold,
      pinRequired: method.pin,
      pinLength: 4,
      dueCents,
      durationMs,
      pinMs,
      notRecognized,
      slowMs: slow,
      attempts,
      outcome,
    };
  }

  /** Startwerte der Schwierigkeitsgrade als Tabelle für die Verwaltung. */
  function difficultyOptions() {
    return Object.entries(DIFFICULTY).map(([key, x]) => ({ key, label: x.label }));
  }

  POS.Sim = {
    DIFFICULTY,
    CASH_SPEED,
    CARD_SPEED,
    CARD_METHODS,
    CASH_STRATEGIES,
    EVENT_BASE,
    pick,
    decompose,
    buildInserts,
    planCash,
    planCard,
    difficultyOptions,
  };
})(typeof window !== 'undefined' ? window : globalThis);
