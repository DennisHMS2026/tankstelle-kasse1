/**
 * Trainingsmodus: zufaellige Kundeneinkaeufe erzeugen und Verkaeufe auswerten.
 * Reine Funktionen. rng ist eine Funktion, die Werte in [0,1) liefert (testbar).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const C = POS.Cart;
  const R = POS.Rules;

  const DIFFICULTY = {
    ANFAENGER: { label: 'Anfänger', itemsMin: 1, itemsMax: 3, qtyMax: 3, leergutChance: 0, ageChance: 0 },
    FORTGESCHRITTEN: { label: 'Fortgeschritten', itemsMin: 2, itemsMax: 5, qtyMax: 6, leergutChance: 0.3, ageChance: 0.25 },
    PROFI: { label: 'Profi', itemsMin: 3, itemsMax: 7, qtyMax: 12, leergutChance: 0.7, ageChance: 0.5 },
  };

  const LEERGUT_DEPOSITS = ['MW08', 'MW15', 'EW25', 'KASTEN'];
  const ROUND_UP_TARGETS = [500, 1000, 2000, 5000, 10000];

  function shuffle(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Erster gaengiger Schein-/Betrag oberhalb des Gesamtbetrags. */
  function givenFor(total) {
    for (const target of ROUND_UP_TARGETS) {
      if (target >= total) return target;
    }
    return Math.ceil(total / 10000) * 10000;
  }

  /**
   * Erzeugt einen Kunden mit Einkaufsliste. Der erwartete Bon wird ueber dieselben
   * Regeln berechnet wie die Kasse selbst, damit die Auswertung konsistent ist.
   */
  function generateCustomer(rng, { articles, deposits, difficulty = 'ANFAENGER', index = 1, now = new Date() }) {
    const cfg = DIFFICULTY[difficulty] || DIFFICULTY.ANFAENGER;
    const sellable = articles.filter((a) => a.active && a.stock > 0);
    const normal = sellable.filter((a) => !a.ageCheck);
    const aged = sellable.filter((a) => a.ageCheck);
    if (normal.length < 3) throw R.fail('TRAINING_DATEN', 'Zu wenige verkaufbare Artikel für das Training');

    const count = cfg.itemsMin + Math.floor(rng() * (cfg.itemsMax - cfg.itemsMin + 1));
    const picked = shuffle(normal, rng).slice(0, count);
    if (aged.length && rng() < cfg.ageChance) picked.push(shuffle(aged, rng)[0]);

    const list = picked.map((a) => {
      const isCrate = a.name.includes('Kiste') || a.packUnit.startsWith('Kiste');
      const max = isCrate ? 2 : cfg.qtyMax;
      return { articleId: a.id, name: a.name, qty: 1 + Math.floor(rng() * max) };
    });

    let leergut = [];
    if (rng() < cfg.leergutChance) {
      const kinds = shuffle(LEERGUT_DEPOSITS, rng).slice(0, 1 + Math.floor(rng() * 2));
      leergut = kinds
        .map((id) => ({ depositId: id, qty: id === 'KASTEN' ? 1 : 1 + Math.floor(rng() * 6) }))
        .filter((e) => deposits.some((d) => d.id === e.depositId));
    }

    // Erwarteter Bon mit denselben Regeln wie die Kasse
    let cart = C.newCart({ cashierId: 'training', shiftId: 'training', kassenNr: '0' });
    for (const item of list) {
      const article = articles.find((a) => a.id === item.articleId);
      cart = C.addArticle(cart, article, deposits, item.qty, { ageVerified: true, source: 'TRAINING' });
    }
    const pfandAndWare = R.computeTotals(cart).gesamt;
    const leergutCents = leergut.reduce((s, e) => s + deposits.find((d) => d.id === e.depositId).cents * e.qty, 0);
    if (pfandAndWare - leergutCents <= 0) {
      leergut = [];
    }
    const expectedGesamt = pfandAndWare - (leergut.length ? leergutCents : 0);
    const payment = rng() < 0.35 ? 'KARTE' : 'BAR';
    const givenCents = payment === 'BAR' ? givenFor(expectedGesamt) : null;

    return {
      id: 'T' + now.getTime().toString(36) + index,
      name: `Kunde ${index}`,
      difficulty,
      list,
      leergut,
      payment,
      givenCents,
      expected: {
        gesamt: expectedGesamt,
        pfand: R.computeTotals(cart).pfand,
        gutschriften: -(leergut.length ? leergutCents : 0),
        change: givenCents === null ? 0 : givenCents - expectedGesamt,
      },
      createdAt: now.toISOString(),
    };
  }

  /** Auswertung eines abgeschlossenen Trainingsverkaufs (0-100 Punkte). */
  function evaluate(customer, sale, elapsedMs, now = new Date()) {
    const fehler = [];

    // Artikel und Mengen
    const soll = new Map(customer.list.map((i) => [i.articleId, i.qty]));
    const ist = new Map();
    for (const line of sale.lines) {
      if (line.kind === 'ART') ist.set(line.articleId, (ist.get(line.articleId) || 0) + line.qty);
    }
    let artikelOk = soll.size === ist.size;
    for (const [id, qty] of soll) {
      if (ist.get(id) !== qty) {
        artikelOk = false;
        const name = customer.list.find((i) => i.articleId === id).name;
        fehler.push(`Artikel/Menge falsch: ${name} (soll ${qty}, ist ${ist.get(id) || 0})`);
      }
    }
    for (const id of ist.keys()) {
      if (!soll.has(id)) {
        artikelOk = false;
        fehler.push('Nicht auf der Liste: Artikel wurde zusätzlich gescannt');
      }
    }

    // Pfand und Leergut
    const pfandOk = sale.totals.pfand === customer.expected.pfand && sale.totals.gutschriften === customer.expected.gutschriften;
    if (!pfandOk) fehler.push('Pfand oder Leergutgutschrift stimmt nicht');

    // Zahlart und Rueckgeld
    // BAR – AUTOMAT zählt als Barzahlung, nur die Maschine nimmt das Geld an
    const payment = sale.payments.find((p) => p.type === 'BAR' || p.type === 'KARTE' || p.type === 'AUTOMAT');
    const zahlart = payment ? (payment.type === 'AUTOMAT' ? 'BAR' : payment.type) : null;
    let zahlungOk = !!payment && zahlart === customer.payment;
    if (!zahlungOk) fehler.push(`Zahlart falsch (soll ${customer.payment})`);
    if (zahlungOk && customer.payment === 'BAR') {
      const change = payment.change || 0;
      if (change !== customer.expected.change) {
        zahlungOk = false;
        fehler.push(`Rückgeld falsch (soll ${POS.Money.formatEuro(customer.expected.change)})`);
      }
    }
    const gesamtOk = sale.totals.gesamt === customer.expected.gesamt;
    if (!gesamtOk) fehler.push('Gesamtbetrag weicht vom erwarteten Bon ab');

    // Bearbeitungszeit: volle Punkte bis 90 s, danach linear fallend bis 0 bei 270 s
    const sec = Math.max(0, elapsedMs / 1000);
    const zeit = sec <= 90 ? 1 : Math.max(0, 1 - (sec - 90) / 180);

    const parts = {
      artikel: artikelOk && gesamtOk ? 25 : 0,
      pfand: pfandOk ? 25 : 0,
      zahlung: zahlungOk ? 25 : 0,
      zeit: Math.round(25 * zeit),
    };
    const score = parts.artikel + parts.pfand + parts.zahlung + parts.zeit;
    return {
      id: 'TR' + now.getTime().toString(36),
      ts: now.toISOString(),
      customer: customer.name,
      difficulty: customer.difficulty,
      saleBonNr: sale.bonNr,
      score,
      parts,
      fehler,
      elapsedSec: Math.round(sec),
    };
  }

  POS.Training = { DIFFICULTY, generateCustomer, evaluate };
})(typeof window !== 'undefined' ? window : globalThis);
