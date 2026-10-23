/**
 * Warenkorb als reiner Datenwert. Jede Operation liefert eine NEUE Kopie,
 * der alte Warenkorb bleibt unveraendert (keine halbfertigen Zustaende).
 *
 * Zeilenarten:
 *  - ART:        verkaufter Artikel (mit Pfand-Snapshot zum Zeitpunkt des Scans)
 *  - GUTSCHRIFT: eingeloester Pfandbon bzw. Leergutverrechnung (negativ)
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const R = POS.Rules;

  let counter = 0;
  function makeId(prefix) {
    counter += 1;
    return prefix + Date.now().toString(36) + counter.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function copy(value) {
    return structuredClone(value);
  }

  function newCart({ cashierId, shiftId, kassenNr }) {
    return {
      id: makeId('C'),
      cashierId,
      shiftId,
      kassenNr,
      startedAt: new Date().toISOString(),
      lines: [],
      payments: [],
      nextLine: 1,
    };
  }

  function findLine(cart, lineId) {
    const line = cart.lines.find((l) => l.id === lineId);
    if (!line) throw R.fail('ZEILE_NICHT_GEFUNDEN', 'Position nicht gefunden');
    return line;
  }

  function snapshotPfand(article, deposits) {
    return (article.pfand || []).map((p) => {
      const dep = deposits.find((d) => d.id === p.depositId);
      if (!dep) throw R.fail('PFAND_UNBEKANNT', `Pfandart ${p.depositId} fehlt in den Stammdaten`);
      return { depositId: dep.id, name: dep.name, cents: dep.cents, qty: p.qty };
    });
  }

  function paidSum(cart) {
    return cart.payments.reduce((s, p) => s + p.cents, 0);
  }

  /** Noch offener Betrag (kann negativ sein bei Auszahlung an den Kunden). */
  function dueCents(cart) {
    return R.computeTotals(cart).gesamt - paidSum(cart);
  }

  function addArticle(cart, article, deposits, qty, opts = {}) {
    if (!article.active) throw R.fail('ARTIKEL_INAKTIV', 'Artikel ist inaktiv');
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw R.fail('MENGE_UNGUELTIG', 'Menge muss zwischen 1 und 999 liegen');
    }
    if (article.ageCheck && !opts.ageVerified) {
      throw R.fail('ALTERSPRUEFUNG_FEHLT', 'Altersprüfung für diesen Artikel fehlt');
    }
    const next = copy(cart);
    const pfand = snapshotPfand(article, deposits);
    const existing = next.lines.find(
      (l) => l.kind === 'ART' && l.articleId === article.id && !l.discountPct && !l.priceChanged
    );
    if (existing) {
      if (existing.qty + qty > 999) throw R.fail('MENGE_UNGUELTIG', 'Menge darf 999 nicht überschreiten');
      existing.qty += qty;
    } else {
      next.lines.push({
        id: 'L' + next.nextLine++,
        kind: 'ART',
        articleId: article.id,
        ean: article.ean,
        plu: article.plu,
        name: article.name,
        qty,
        unitCents: article.priceCents,
        vat: article.vat,
        pfand,
        ageCheck: article.ageCheck || 0,
        ageVerified: !!article.ageCheck && !!opts.ageVerified,
        discountPct: 0,
        priceChanged: null,
        source: opts.source || 'SCAN',
      });
    }
    return next;
  }

  function setQty(cart, lineId, qty) {
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw R.fail('MENGE_UNGUELTIG', 'Menge muss zwischen 1 und 999 liegen');
    }
    const next = copy(cart);
    const line = findLine(next, lineId);
    if (line.kind !== 'ART') throw R.fail('ZEILE_NICHT_AENDERBAR', 'Gutschriften können nicht geändert werden');
    line.qty = qty;
    return next;
  }

  function removeLine(cart, lineId) {
    const next = copy(cart);
    const line = findLine(next, lineId);
    next.lines = next.lines.filter((l) => l.id !== lineId);
    return { cart: next, removed: line };
  }

  function setPrice(cart, lineId, cents, reason) {
    if (!Number.isInteger(cents) || cents < 0) throw R.fail('BETRAG_UNGUELTIG', 'Preis ist ungültig');
    if (!reason || !reason.trim()) throw R.fail('GRUND_FEHLT', 'Für eine Preisänderung ist ein Grund erforderlich');
    const next = copy(cart);
    const line = findLine(next, lineId);
    if (line.kind !== 'ART') throw R.fail('ZEILE_NICHT_AENDERBAR', 'Nur Artikelpositionen können geändert werden');
    line.priceChanged = { from: line.unitCents, to: cents, reason: reason.trim() };
    line.unitCents = cents;
    return { cart: next, line: copy(line) };
  }

  function setDiscount(cart, lineId, pct, reason) {
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw R.fail('RABATT_UNGUELTIG', 'Rabatt muss zwischen 0 und 100 % liegen');
    if (!reason || !reason.trim()) throw R.fail('GRUND_FEHLT', 'Für einen Rabatt ist ein Grund erforderlich');
    const next = copy(cart);
    const line = findLine(next, lineId);
    if (line.kind !== 'ART') throw R.fail('ZEILE_NICHT_AENDERBAR', 'Rabatt nur auf Artikelpositionen');
    line.discountPct = pct;
    line.discountReason = reason.trim();
    return { cart: next, line: copy(line) };
  }

  /**
   * Tankvorgang als Zeile. Betrag und Literpreis sind bereits eingefroren, der Vorgang
   * ist beim Entfernen wieder freigebbar (siehe ledger.removePosition).
   */
  function addFuel(cart, tank) {
    const next = copy(cart);
    if (next.lines.some((l) => l.kind === 'KRAFTSTOFF' && l.tankId === tank.id)) {
      throw R.fail('TANK_DOPPELT', `Tankvorgang ${tank.id} ist bereits im Bon`);
    }
    next.lines.push({
      id: 'L' + next.nextLine++,
      kind: 'KRAFTSTOFF',
      tankId: tank.id,
      pumpId: tank.pumpId,
      fuelName: tank.fuelName,
      name: `${tank.fuelName} · Zapfsäule ${tank.pumpId}`,
      qty: 1,
      unitCents: tank.amountCents,
      vat: tank.vat,
      pfand: [],
      discountPct: 0,
      priceChanged: null,
      ageCheck: 0,
      ageVerified: false,
      ml: tank.mlFinal,
      priceMilli: tank.priceMilli,
      source: 'ZAPFSAEULE',
    });
    return next;
  }

  /** Pfandbon-Gutschrift als Zeile (negativ). Der Bon wird erst beim Abschluss eingeloest. */
  function addVoucher(cart, voucher) {
    if (voucher.status !== 'OFFEN') throw R.fail('PFANDBON_NICHT_EINLOESBAR', `Pfandbon ${voucher.code} ist bereits verbraucht`);
    const next = copy(cart);
    if (next.lines.some((l) => l.kind === 'GUTSCHRIFT' && l.voucherCode === voucher.code)) {
      throw R.fail('PFANDBON_DOPPELT', 'Dieser Pfandbon ist bereits im Bon');
    }
    next.lines.push({
      id: 'L' + next.nextLine++,
      kind: 'GUTSCHRIFT',
      voucherCode: voucher.code,
      label: `Pfandbon ${voucher.code}`,
      cents: -voucher.cents,
      detail: voucher.details.map((d) => ({ depositId: d.depositId, qty: d.qty })),
    });
    return next;
  }

  /** Barzahlung. Gegeben darf nicht unter dem offenen Betrag liegen. */
  function addCash(cart, givenCents) {
    const totals = R.computeTotals(cart);
    if (totals.gesamt < 0) throw R.fail('AUSZAHLUNG_STATT_BAR', 'Bei negativem Bon wird ausgezahlt, nicht kassiert');
    const remaining = totals.gesamt - paidSum(cart);
    if (remaining <= 0) throw R.fail('NICHTS_ZU_ZAHLEN', 'Es ist kein Betrag mehr offen');
    if (!Number.isInteger(givenCents) || givenCents <= 0) throw R.fail('BETRAG_UNGUELTIG', 'Gegebener Betrag ist ungültig');
    if (givenCents < remaining) {
      throw R.fail('ZAHLBETRAG_ZU_NIEDRIG', `Zahlbetrag zu niedrig, offen sind ${POS.Money.formatEuro(remaining)}`);
    }
    const next = copy(cart);
    next.payments.push({ type: 'BAR', cents: remaining, given: givenCents, change: givenCents - remaining });
    return next;
  }

  function addCard(cart, ref) {
    const remaining = dueCents(cart);
    if (remaining <= 0) throw R.fail('NICHTS_ZU_ZAHLEN', 'Es ist kein Betrag mehr offen');
    const next = copy(cart);
    next.payments.push({ type: 'KARTE', cents: remaining, ref });
    return next;
  }

  /** Auszahlung an den Kunden bei negativem Bon (z. B. nur Pfandgutschrift). */
  function addPayout(cart) {
    const totals = R.computeTotals(cart);
    if (totals.gesamt >= 0) throw R.fail('KEINE_AUSZAHLUNG', 'Der Bon ist nicht negativ');
    if (cart.payments.length) throw R.fail('ZAHLUNG_BEREITS_ERFASST', 'Zahlung bereits erfasst');
    const next = copy(cart);
    next.payments.push({ type: 'AUSZAHLUNG', cents: totals.gesamt });
    return next;
  }

  POS.Cart = {
    newCart,
    findLine,
    addArticle,
    addFuel,
    setQty,
    removeLine,
    setPrice,
    setDiscount,
    addVoucher,
    addCash,
    addCard,
    addPayout,
    paidSum,
    dueCents,
  };
})(typeof window !== 'undefined' ? window : globalThis);
