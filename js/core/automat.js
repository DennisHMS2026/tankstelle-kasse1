/**
 * Virtueller Bargeld-Einzahlautomat (reine Simulation, keine Hardware).
 *
 * Dieses Modul enthaelt nur reine Funktionen: Stueckelung, Bestand, Wechselgeld-Planung,
 * Maschinenzustand und die Auswahl simulierter Stoerungen. Alle Buchungen laufen ueber
 * js/core/ledger.js, damit sie zusammen mit dem Verkauf gespeichert oder verworfen werden.
 *
 * Bestand ist immer abgeleitet: Er ist die Summe aller Bewegungen (d.automatMoves) je Stueckelung.
 * Es gibt keinen separaten Zaehler, der auseinanderlaufen koennte.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const M = POS.Money;

  /** Alle annehmbaren Muenzen und Scheine in Cent, aufsteigend. */
  const DENOMS = [
    { value: 1, kind: 'MUENZE' },
    { value: 2, kind: 'MUENZE' },
    { value: 5, kind: 'MUENZE' },
    { value: 10, kind: 'MUENZE' },
    { value: 20, kind: 'MUENZE' },
    { value: 50, kind: 'MUENZE' },
    { value: 100, kind: 'MUENZE' },
    { value: 200, kind: 'MUENZE' },
    { value: 500, kind: 'SCHEIN' },
    { value: 1000, kind: 'SCHEIN' },
    { value: 2000, kind: 'SCHEIN' },
    { value: 5000, kind: 'SCHEIN' },
    { value: 10000, kind: 'SCHEIN' },
    { value: 20000, kind: 'SCHEIN' },
  ];

  /** Obergrenze fuer ein Rueckgeld (Speicher- und Rechenzeit der Planung). */
  const MAX_CHANGE_CENTS = 100000;

  const STATE_LABEL = {
    BETRIEBSBEREIT: 'Betriebsbereit',
    GELDANNAHME: 'Geldannahme läuft',
    ZAHLUNG_AUSREICHEND: 'Zahlung ausreichend',
    RUECKGELDAUSGABE: 'Rückgeldausgabe',
    ZAHLUNG_ABGESCHLOSSEN: 'Zahlung abgeschlossen',
    STOERUNG: 'Störung',
    AUSSER_BETRIEB: 'Außer Betrieb',
    WARTUNG: 'Wartung erforderlich',
  };

  const FAULT_LABEL = {
    MUENZE_NICHT_ERKANNT: 'Münze nicht erkannt (Rückgabe)',
    SCHEIN_ABGELEHNT: 'Schein abgelehnt (Rückgabe)',
    SCHEIN_KLEMMT: 'Schein klemmt (Störung)',
    AUSSER_BETRIEB: 'Vorübergehend außer Betrieb',
    WECHSEL_STOERUNG: 'Rückgeldeinheit meldet Störung',
  };

  /** Kurzbezeichnung einer Stueckelung: 1 ct, 2 €, 5 €, 0,50 €. */
  function label(value) {
    if (value < 100) return `${value} ct`;
    return value % 100 === 0 ? `${value / 100} €` : `${M.formatPlain(value)} €`;
  }

  function denom(value) {
    return DENOMS.find((x) => x.value === value) || null;
  }

  /** Bestand je Stueckelung aus allen Bewegungen (Stueckzahl, kann nie aus dem Nichts entstehen). */
  function counts(d) {
    const c = {};
    for (const x of DENOMS) c[x.value] = 0;
    for (const m of d.automatMoves || []) c[m.denom] = (c[m.denom] || 0) + m.count;
    return c;
  }

  function slot(d, value) {
    return (d.automat && d.automat.slots || []).find((s) => s.value === value) || null;
  }

  /** Gesamtwert im Automaten in Cent. */
  function totalCents(d) {
    const c = counts(d);
    return DENOMS.reduce((sum, x) => sum + x.value * (c[x.value] || 0), 0);
  }

  /** Eingezahlter Betrag einer Sitzung. */
  function sessionPaid(session) {
    return session.deposits.reduce((sum, x) => sum + x.denom, 0);
  }

  /** Warnungen je Behaelter: voll (Wartung) oder unter Mindestbestand (Wechselgeld knapp). */
  function slotWarnings(d) {
    const c = counts(d);
    const out = [];
    for (const s of d.automat.slots) {
      const n = c[s.value] || 0;
      if (n >= s.capacity) out.push({ kind: 'VOLL', value: s.value, count: n });
      else if (n < s.minimum) out.push({ kind: 'KNAPP', value: s.value, count: n });
    }
    return out;
  }

  /** Aktueller Maschinenzustand (Zustaende Rueckgeldausgabe und Abgeschlossen sind nur kurze Anzeige in der Oberflaeche). */
  function machineState(d) {
    const a = d.automat;
    if (a.mode === 'AUSSER_BETRIEB') return 'AUSSER_BETRIEB';
    if (a.mode === 'STOERUNG') return 'STOERUNG';
    const s = d.automatSession;
    if (s && s.status === 'OFFEN') return sessionPaid(s) >= s.dueCents ? 'ZAHLUNG_AUSREICHEND' : 'GELDANNAHME';
    if (slotWarnings(d).some((w) => w.kind === 'VOLL')) return 'WARTUNG';
    return 'BETRIEBSBEREIT';
  }

  /**
   * Wechselgeld-Planung. Liefert die Stueckelung mit der kleinsten Stueckzahl, die EXAKT den
   * Betrag ergibt und mit dem vorhandenen Bestand machbar ist. Ist das nicht moeglich, kommt
   * ok: false zurueck. Es wird nie ein Teilbetrag oder ein ungenauer Betrag vorgeschlagen.
   *
   * Verfahren: Jede Stueckelung wird in Zweierpakete (1, 2, 4, ...) zerlegt. Danach ist eine
   * Dynamik ueber alle Betraege bis zum Rueckgeld moeglich (0/1-Rucksack mit minimaler Stueckzahl).
   */
  function planChange(change, stock) {
    if (!Number.isInteger(change) || change < 0) return { ok: false, plan: [], reason: 'BETRAG_UNGUELTIG' };
    if (change > MAX_CHANGE_CENTS) return { ok: false, plan: [], reason: 'ZU_GROSS' };
    if (change === 0) return { ok: true, plan: [], reason: null };

    const items = [];
    for (const x of DENOMS) {
      let rest = Math.max(0, stock[x.value] || 0);
      let size = 1;
      while (rest > 0) {
        const take = Math.min(size, rest);
        items.push({ value: x.value, count: take });
        rest -= take;
        size *= 2;
      }
    }

    // best[a] = kleinste Anzahl Muenzen/Scheine, mit der genau a Cent entstehen. Kosten eines
    // Pakets sind seine Stueckzahl, nicht 1, sonst wuerden grosse Pakete unnoetig bevorzugt.
    const INF = 1 << 29;
    const best = new Int32Array(change + 1).fill(INF);
    best[0] = 0;
    const taken = [];
    for (const it of items) {
      const w = it.value * it.count;
      const t = new Uint8Array(change + 1);
      for (let a = change; a >= w; a--) {
        if (best[a - w] + it.count < best[a]) {
          best[a] = best[a - w] + it.count;
          t[a] = 1;
        }
      }
      taken.push(t);
    }
    if (best[change] >= INF) return { ok: false, plan: [], reason: 'NICHT_EXAKT' };

    const used = {};
    let rest = change;
    for (let i = items.length - 1; i >= 0; i--) {
      if (taken[i][rest]) {
        used[items[i].value] = (used[items[i].value] || 0) + items[i].count;
        rest -= items[i].value * items[i].count;
      }
    }
    const plan = Object.keys(used)
      .map(Number)
      .sort((a, b) => b - a)
      .map((value) => ({ value, count: used[value] }));
    // Sicherheitsprüfung: Nur ein exakt passender Plan darf zurückgegeben werden.
    const sum = plan.reduce((s, p) => s + p.value * p.count, 0);
    if (sum !== change) return { ok: false, plan: [], reason: 'NICHT_EXAKT' };
    return { ok: true, plan, reason: null };
  }

  /**
   * Simulierte Stoerung. rng liefert Werte in [0,1). Rollt nur bei rate, sonst null.
   * kind: 'MUENZE' | 'SCHEIN' | 'WECHSEL'. Wird nur im Trainingsmodus aufgerufen.
   */
  function rollFault(rng, rate, kind) {
    if (!(rng() < rate)) return null;
    const r = rng();
    if (kind === 'MUENZE') return 'MUENZE_NICHT_ERKANNT';
    if (kind === 'WECHSEL') return 'WECHSEL_STOERUNG';
    if (r < 0.6) return 'SCHEIN_ABGELEHNT';
    if (r < 0.85) return 'SCHEIN_KLEMMT';
    return 'AUSSER_BETRIEB';
  }

  /** Startbestand und Behaelter-Grenzen fuer eine frische Installation. */
  function defaultSlots() {
    const initial = { 1: 40, 2: 40, 5: 40, 10: 40, 20: 40, 50: 40, 100: 40, 200: 40, 500: 10, 1000: 10, 2000: 10, 5000: 5, 10000: 5, 20000: 2 };
    return DENOMS.map((x) => ({
      value: x.value,
      kind: x.kind,
      accepted: true,
      capacity: x.kind === 'MUENZE' ? 300 : 80,
      minimum: x.kind === 'MUENZE' ? 10 : 2,
      initial: initial[x.value],
    }));
  }

  POS.Automat = {
    DENOMS,
    MAX_CHANGE_CENTS,
    STATE_LABEL,
    FAULT_LABEL,
    label,
    denom,
    counts,
    slot,
    totalCents,
    sessionPaid,
    slotWarnings,
    machineState,
    planChange,
    rollFault,
    defaultSlots,
  };
})(typeof window !== 'undefined' ? window : globalThis);
