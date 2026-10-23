/**
 * Geschaeftsregeln: Rollen, Pfand, Steuer, Summen, Wechselgeld, Kartensimulation.
 * Alle Funktionen sind rein (keine Seiteneffekte, kein DOM).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const M = POS.Money;

  /** Fehler mit maschinenlesbarem Code, z. B. 'ZAHLBETRAG_ZU_NIEDRIG'. */
  function fail(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  const ROLE_LEVEL = { KASSIERER: 1, SCHICHTLEITUNG: 2, ADMIN: 3 };
  const ROLE_LABEL = {
    KASSIERER: 'Kassierer',
    SCHICHTLEITUNG: 'Schichtleitung',
    ADMIN: 'Marktleitung / Administrator',
  };

  function hasRole(staff, minRole) {
    return !!staff && staff.active !== false && ROLE_LEVEL[staff.role] >= ROLE_LEVEL[minRole];
  }

  /** Muenzen und Scheine in Cent, absteigend (Greedy ist fuer EUR-Stueckelung optimal). */
  const DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

  /** Rabatt einer Position in Cent (Prozent ganzzahlig, kaufmaennisch gerundet). */
  function lineDiscountCents(line) {
    return M.divRound(line.unitCents * line.qty * (line.discountPct || 0), 100);
  }

  function lineGrossCents(line) {
    return line.unitCents * line.qty - lineDiscountCents(line);
  }

  /** Pfand je verkaufter Einheit aus der Pfand-Snapshot-Liste der Position. */
  function pfandCentsPerUnit(pfand) {
    return (pfand || []).reduce((sum, p) => sum + p.cents * p.qty, 0);
  }

  /**
   * Summen eines Warenkorbs.
   * - Pfand und Gutschriften (Leergut/Pfandbons) sind NICHT mehrwertsteuerpflichtig.
   * - MwSt. wird je Satz aus dem Bruttobetrag der Warenpositionen herausgerechnet.
   */
  function computeTotals(cart) {
    const t = {
      warenBrutto: 0,
      rabatt: 0,
      ware: 0,
      pfand: 0,
      gutschriften: 0,
      zwischensumme: 0,
      gesamt: 0,
      mwst: [],
    };
    const byRate = {};
    for (const line of cart.lines) {
      // Kraftstoffzeilen: Betrag ist eingefroren (qty 1, unitCents = Betrag in Cent), MwSt. wie Ware
      if (line.kind === 'ART' || line.kind === 'KRAFTSTOFF') {
        const brutto = line.unitCents * line.qty;
        const disc = lineDiscountCents(line);
        const gross = brutto - disc;
        t.warenBrutto += brutto;
        t.rabatt += disc;
        t.ware += gross;
        t.pfand += line.qty * pfandCentsPerUnit(line.pfand);
        byRate[line.vat] = (byRate[line.vat] || 0) + gross;
      } else if (line.kind === 'GUTSCHRIFT') {
        t.gutschriften += line.cents;
      }
    }
    t.mwst = Object.keys(byRate)
      .map(Number)
      .sort((a, b) => a - b)
      .map((rate) => {
        const brutto = byRate[rate];
        const steuer = M.taxOf(brutto, rate);
        return { rate, netto: brutto - steuer, steuer, brutto };
      });
    t.zwischensumme = t.ware + t.pfand + t.gutschriften;
    t.gesamt = t.zwischensumme;
    return t;
  }

  /** Wechselgeld als Stueckelungsvorschlag, z. B. 1124 -> [{value:1000,count:1},{value:100,count:1},...]. */
  function changeBreakdown(cents) {
    if (!Number.isInteger(cents) || cents <= 0) return [];
    let rest = cents;
    const out = [];
    for (const value of DENOMINATIONS) {
      const count = Math.floor(rest / value);
      if (count > 0) {
        out.push({ value, count });
        rest -= count * value;
      }
    }
    return out;
  }

  /** Prueft eine vom Kassierer zusammengestellte Rueckgeldmenge gegen den Sollbetrag. */
  function checkComposition(composed, change) {
    const sum = composed.reduce((s, c) => s + c.value * c.count, 0);
    return { ok: sum === change, sum, diff: change - sum };
  }

  /**
   * Virtuelle Kartenzahlung. rng liefert Werte in [0,1).
   * Simuliert Ablehnung und Terminalfehler. Es findet niemals eine echte Zahlung statt.
   */
  function simulateCard(rng, rejectRate) {
    const roll = rng();
    const ref = 'SIM' + String(Math.floor(rng() * 1e6)).padStart(6, '0');
    if (roll < rejectRate) {
      const reasons = [
        'Karte abgelehnt (Simulation)',
        'Kartenlesefehler (Simulation)',
        'Keine Autorisierung (Simulation)',
      ];
      const reason = reasons[Math.min(reasons.length - 1, Math.floor(rng() * reasons.length))];
      return { approved: false, reason, ref };
    }
    return { approved: true, reason: null, ref: 'AUT-' + ref };
  }

  POS.Rules = {
    fail,
    ROLE_LEVEL,
    ROLE_LABEL,
    hasRole,
    DENOMINATIONS,
    lineDiscountCents,
    lineGrossCents,
    pfandCentsPerUnit,
    computeTotals,
    changeBreakdown,
    checkComposition,
    simulateCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
