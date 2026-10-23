/**
 * Zentrale Transaktionslogik.
 *
 * Alle Funktionen erhalten einen ENTWURF (draft) des Gesamtzustands und veraendern ihn.
 * Wirft eine Funktion, wird der Entwurf verworfen (siehe App.mutate in js/data/store.js).
 * Dadurch gibt es keine halb gebuchten Verkaeufe: Verkauf, Bestand, Kassenbewegung,
 * Pfandbon und Ereignislog werden gemeinsam gespeichert oder gar nicht.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const R = POS.Rules;
  const M = POS.Money;
  const E = POS.Ean;
  const T = POS.Training;
  const fail = R.fail;

  const pad = (n, len) => String(n).padStart(len, '0');

  function nextId(d, name) {
    d.counters[name] = (d.counters[name] || 0) + 1;
    return d.counters[name];
  }

  function logEvent(d, { type, text, cashierId = null, approverId = null, shiftId = null, data = null, now = new Date() }) {
    const id = nextId(d, 'event');
    d.events.push({ id, ts: now.toISOString(), type, text, cashierId, approverId, shiftId, data });
    return id;
  }

  function currentShift(d) {
    return d.shifts.find((s) => s.status === 'OFFEN') || null;
  }

  function requireShift(d) {
    const shift = currentShift(d);
    if (!shift) throw fail('SCHICHT_NICHT_OFFEN', 'Keine offene Kassenschicht. Bitte zuerst Schicht starten.');
    return shift;
  }

  function cashMove(d, { type, cents, reason = '', cashierId = null, shiftId, now = new Date(), ref = null }) {
    M.assertCents(cents, 'Kassenbewegung');
    d.cashMoves.push({ id: nextId(d, 'cashmove'), shiftId, ts: now.toISOString(), type, cents, reason, cashierId, ref });
  }

  function stockMove(d, { articleId, qty, type, ref = null, reason = '', cashierId = null, now = new Date() }) {
    const art = d.articles.find((a) => a.id === articleId);
    if (!art) throw fail('ARTIKEL_NICHT_GEFUNDEN', `Artikel ${articleId} nicht gefunden`);
    const before = art.stock;
    art.stock = before + qty;
    d.stockMoves.push({
      id: nextId(d, 'stock'),
      ts: now.toISOString(),
      articleId,
      articleName: art.name,
      type,
      qty,
      before,
      after: art.stock,
      ref,
      reason,
      cashierId,
    });
  }

  // ---------------------------------------------------------------- Schicht

  function openShift(d, { cashierId, startCents, now = new Date() }) {
    if (currentShift(d)) throw fail('SCHICHT_BEREITS_OFFEN', 'Es ist bereits eine Schicht offen');
    M.assertCents(startCents, 'Anfangsbestand');
    if (startCents < 0) throw fail('BETRAG_UNGUELTIG', 'Anfangsbestand darf nicht negativ sein');
    const shift = {
      id: 'S' + pad(nextId(d, 'shift'), 5),
      cashierId,
      openedAt: now.toISOString(),
      startCents,
      status: 'OFFEN',
      endedAt: null,
      countedCents: null,
      expectedCents: null,
      diffCents: null,
      // Bargeld-Automat: eigener Bestand, getrennt von der Kassenlade
      machineStartCents: POS.Automat.totalCents(d),
      machineCountedCents: null,
      machineExpectedCents: null,
      machineDiffCents: null,
    };
    d.shifts.push(shift);
    logEvent(d, { type: 'SCHICHT_START', text: `Schicht ${shift.id} gestartet, Anfangsbestand ${M.formatEuro(startCents)}`, cashierId, shiftId: shift.id, now });
    return shift;
  }

  /** Kennzahlen einer Schicht (fuer Abschlussbericht, Dashboard und Export). */
  function shiftSummary(d, shift) {
    const moves = d.cashMoves.filter((m) => m.shiftId === shift.id);
    const sales = d.sales.filter((s) => s.shiftId === shift.id);
    const sumType = (type) => moves.filter((m) => m.type === type).reduce((s, m) => s + m.cents, 0);
    const paySum = (type) =>
      sales.reduce((s, sale) => s + sale.payments.filter((p) => p.type === type).reduce((a, p) => a + p.cents, 0), 0);
    const cashMoveSum = moves.reduce((s, m) => s + m.cents, 0);
    const expectedCents = shift.startCents + cashMoveSum;
    const fuelLines = sales
      .filter((s) => s.kind === 'VERKAUF')
      .flatMap((s) => s.lines.filter((l) => l.kind === 'KRAFTSTOFF'));
    const fuelByName = {};
    for (const l of fuelLines) {
      const f = (fuelByName[l.fuelName] = fuelByName[l.fuelName] || { name: l.fuelName, ml: 0, cents: 0, count: 0 });
      f.ml += l.ml;
      f.cents += l.unitCents;
      f.count += 1;
    }
    return {
      kraftstoff: Object.values(fuelByName),
      kraftstoffUmsatz: fuelLines.reduce((s, l) => s + l.unitCents, 0),
      kraftstoffMl: fuelLines.reduce((s, l) => s + l.ml, 0),
      tankvorgaenge: fuelLines.length,
      startCents: shift.startCents,
      barUmsatz: paySum('BAR'),
      kartenUmsatz: paySum('KARTE'),
      pfandAuszahlungen: -sumType('PFAND_AUSZAHLUNG'),
      retoureBar: -sumType('RETOURE_BAR'),
      einlagen: sumType('EINLAGE'),
      entnahmen: -sumType('ENTNAHME'),
      anzahlVerkaeufe: sales.filter((s) => s.kind === 'VERKAUF').length,
      anzahlStornos: d.events.filter(
        (e) => e.shiftId === shift.id && ['BON_STORNO', 'POSITION_STORNO', 'RETOURE'].includes(e.type)
      ).length,
      expectedCents,
      countedCents: shift.countedCents,
      diffCents: shift.diffCents,
      ...automatShiftSummary(d, shift),
      ...paymentShiftSummary(d, shift),
      traffic: POS.Traffic ? POS.Traffic.shiftStats(d, shift) : null,
    };
  }

  /** Zahlungen und Störungen einer Schicht (Anzahl, Dauer, Gesamtumsatz). */
  function paymentShiftSummary(d, shift) {
    const sales = d.sales.filter((x) => x.shiftId === shift.id && x.kind === 'VERKAUF');
    const has = (x, t) => x.payments.some((p) => p.type === t);
    const timed = sales.filter((x) => typeof x.durationMs === 'number');
    const faults = d.events.filter((e) => e.shiftId === shift.id && ['AUTOMAT_ABGELEHNT', 'KARTE_ABGELEHNT', 'AUTOMAT_BETRIEB'].includes(e.type)).length;
    return {
      zahlungenBar: sales.filter((x) => has(x, 'BAR')).length,
      zahlungenAutomat: sales.filter((x) => has(x, 'AUTOMAT')).length,
      zahlungenKarte: sales.filter((x) => has(x, 'KARTE')).length,
      zahlungsdauerSchnittMs: timed.length ? Math.round(timed.reduce((s, x) => s + x.durationMs, 0) / timed.length) : null,
      zahlungsstoerungen: faults,
      gesamtumsatz: sales.reduce((s, x) => s + x.totals.gesamt, 0),
    };
  }

  /**
   * Bargeld-Automat getrennt von der Kassenlade. Kundenzahlungen und Rückgeld laufen nur über
   * den Automaten, Befüllung und Entleerung bewegen Bargeld zwischen Lade und Automat.
   */
  function automatShiftSummary(d, shift) {
    const moves = (d.automatMoves || []).filter((m) => m.shiftId === shift.id);
    const sumType = (type, sign = 1) => moves.filter((m) => m.type === type).reduce((s, m) => s + sign * m.cents, 0);
    const umsatz = d.sales
      .filter((s) => s.shiftId === shift.id && s.kind === 'VERKAUF')
      .reduce((s, sale) => s + sale.payments.filter((p) => p.type === 'AUTOMAT').reduce((a, p) => a + p.cents, 0), 0);
    const start = shift.machineStartCents === undefined ? null : shift.machineStartCents;
    return {
      automatStartCents: start,
      automatUmsatz: umsatz,
      automatEingezahlt: sumType('EINZAHLUNG'),
      automatRueckgeld: sumType('RUECKGELD', -1),
      automatErstattet: sumType('ERSTATTUNG', -1),
      automatBefuellt: sumType('BEFUELLUNG'),
      automatEntleert: sumType('ENTLEERUNG', -1),
      automatExpectedCents: start === null ? null : start + moves.reduce((s, m) => s + m.cents, 0),
    };
  }

  function closeShift(d, { countedCents, machineCountedCents, approverId, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    if (d.cart && d.cart.lines.length) throw fail('WARENKORB_NICHT_LEER', 'Schicht kann nicht abgeschlossen werden, solange ein Bon offen ist');
    assertNoSession(d);
    if (d.tanks.some((t) => t.status === 'OFFEN' || t.status === 'IM_WARENKORB')) {
      throw fail('OFFENE_TANKVORGAENGE', 'Vor Schichtende müssen alle Tankvorgänge bezahlt oder storniert sein');
    }
    if (d.pumps.some((p) => ['ENTNOMMEN', 'WARTET_FREIGABE', 'TANKT'].includes(p.status))) {
      throw fail('ZAPFSAEULE_AKTIV', 'Eine Zapfsäule ist noch in Betrieb (Kunde am Zapfhahn)');
    }
    M.assertCents(countedCents, 'Istbestand');
    M.assertCents(machineCountedCents, 'Automat-Istbestand');
    const auto = automatShiftSummary(d, shift);
    if (auto.automatExpectedCents === null) throw fail('AUTOMAT_STARTWERT_FEHLT', 'Automat-Anfangsbestand dieser Schicht fehlt');
    shift.countedCents = countedCents;
    const summary = shiftSummary(d, shift);
    shift.expectedCents = summary.expectedCents;
    shift.diffCents = countedCents - summary.expectedCents;
    shift.machineCountedCents = machineCountedCents;
    shift.machineExpectedCents = auto.automatExpectedCents;
    shift.machineDiffCents = machineCountedCents - auto.automatExpectedCents;
    shift.endedAt = now.toISOString();
    shift.status = 'GESCHLOSSEN';
    shift.report = { ...summary, diffCents: shift.diffCents, machineDiffCents: shift.machineDiffCents };
    logEvent(d, {
      type: 'SCHICHT_ENDE',
      text: `Schicht ${shift.id} geschlossen, Kassendifferenz ${M.formatEuro(shift.diffCents)}, Automatendifferenz ${M.formatEuro(shift.machineDiffCents)}`,
      cashierId,
      approverId,
      shiftId: shift.id,
      now,
    });
    return shift;
  }

  // ---------------------------------------------------------------- Verkauf

  /**
   * Schliesst einen Verkauf ab. Prueft alle Bedingungen, bevor irgendetwas geschrieben wird.
   */
  function finalizeSale(d, { cashierId, now = new Date(), durationMs = null }) {
    const shift = requireShift(d);
    const cart = d.cart;
    if (!cart || cart.lines.length === 0) throw fail('WARENKORB_LEER', 'Der Warenkorb ist leer');
    if (d.sales.some((s) => s.cartId === cart.id)) throw fail('DOPPELTER_VERKAUF', 'Dieser Verkauf wurde bereits gebucht');

    const totals = R.computeTotals(cart);
    const paid = POS.Cart.paidSum(cart);
    if (paid !== totals.gesamt) throw fail('ZAHLUNG_UNVOLLSTAENDIG', 'Die Zahlung deckt den Gesamtbetrag nicht');
    // Ein Bon mit laufender Automat-Zahlung darf nur über den Automaten abgeschlossen werden
    if (d.automatSession && d.automatSession.cartId === cart.id && !cart.payments.some((p) => p.type === 'AUTOMAT')) {
      throw fail('AUTOMAT_SITZUNG_OFFEN', 'Eine Automat-Zahlung läuft für diesen Bon. Bitte dort abschließen oder abbrechen.');
    }

    const codes = [];
    for (const line of cart.lines) {
      if (line.kind === 'ART') {
        if (line.ageCheck && !line.ageVerified) throw fail('ALTERSPRUEFUNG_FEHLT', `Altersprüfung fehlt: ${line.name}`);
        const art = d.articles.find((a) => a.id === line.articleId);
        if (!art || !art.active) throw fail('ARTIKEL_INAKTIV', `Artikel nicht mehr verfügbar: ${line.name}`);
      } else if (line.kind === 'KRAFTSTOFF') {
        const tank = d.tanks.find((t) => t.id === line.tankId);
        if (!tank || tank.status !== 'IM_WARENKORB' || tank.cartId !== cart.id) {
          throw fail('TANK_NICHT_VERFUEGBAR', `Tankvorgang ${line.tankId} ist nicht mehr für diesen Bon reserviert`);
        }
        codes.push(line.tankId);
      } else if (line.kind === 'GUTSCHRIFT') {
        const v = d.vouchers.find((x) => x.code === line.voucherCode);
        if (!v || v.status !== 'OFFEN') throw fail('PFANDBON_NICHT_EINLOESBAR', `Pfandbon ${line.voucherCode} ist bereits eingelöst oder ungültig`);
        codes.push(line.voucherCode);
      }
    }
    if (new Set(codes).size !== codes.length) throw fail('PFANDBON_DOPPELT', 'Ein Pfandbon ist mehrfach im Bon');

    // Ab hier nur noch Schreibzugriffe. Der Entwurf wird insgesamt gespeichert oder verworfen.
    const bonNr = 'B-' + pad(nextId(d, 'bon'), 6);
    const ts = now.toISOString();
    const lines = cart.lines.map((l) => (l.kind === 'ART' ? { ...structuredClone(l), returnedQty: 0 } : structuredClone(l)));
    const sale = {
      id: bonNr,
      bonNr,
      kind: 'VERKAUF',
      status: 'ABGESCHLOSSEN',
      cartId: cart.id,
      shiftId: shift.id,
      cashierId,
      kassenNr: cart.kassenNr,
      ts,
      lines,
      totals,
      payments: cart.payments.map((p) => ({ ...p })),
      simulation: true,
      training: null,
      durationMs,
    };
    d.sales.push(sale);

    for (const p of cart.payments) {
      if (p.type === 'BAR') cashMove(d, { type: 'VERKAUF_BAR', cents: p.cents, cashierId, shiftId: shift.id, ref: bonNr, now });
      if (p.type === 'AUSZAHLUNG') cashMove(d, { type: 'PFAND_AUSZAHLUNG', cents: p.cents, cashierId, shiftId: shift.id, ref: bonNr, now });
    }
    for (const line of lines) {
      if (line.kind === 'KRAFTSTOFF') POS.Pumps.markPaid(d, d.tanks.find((t) => t.id === line.tankId), now, bonNr);
      if (line.kind === 'ART') stockMove(d, { articleId: line.articleId, qty: -line.qty, type: 'VERKAUF', ref: bonNr, cashierId, now });
      if (line.kind === 'GUTSCHRIFT') {
        const v = d.vouchers.find((x) => x.code === line.voucherCode);
        v.status = 'EINGELÖST';
        v.usedIn = bonNr;
        v.usedAt = ts;
      }
    }

    if (d.trainingCustomer) {
      const elapsedMs = now.getTime() - new Date(d.trainingCustomer.createdAt).getTime();
      const result = T.evaluate(d.trainingCustomer, sale, elapsedMs, now);
      d.trainingResults.push({ ...result, shiftId: shift.id, cashierId });
      sale.training = { score: result.score, parts: result.parts, fehler: result.fehler };
      d.trainingCustomer = null;
    }

    logEvent(d, { type: 'VERKAUF', text: `Bon ${bonNr} abgeschlossen, ${M.formatEuro(totals.gesamt)}`, cashierId, shiftId: shift.id, data: { bonNr }, now });
    d.cart = null;
    d.settings.salesSinceBackup = (d.settings.salesSinceBackup || 0) + 1;
    return sale;
  }

  /** Bon-Storno vor Abschluss. Erfordert eine Freigabe, die der Aufrufer bereits geprueft hat. */
  function cancelBon(d, { cashierId, approverId, reason, now = new Date() }) {
    const shift = requireShift(d);
    assertNoSession(d);
    if (!d.cart || d.cart.lines.length === 0) throw fail('WARENKORB_LEER', 'Kein Bon zum Stornieren vorhanden');
    if (!reason || !reason.trim()) throw fail('GRUND_FEHLT', 'Bitte einen Grund für den Bon-Storno angeben');
    const totals = R.computeTotals(d.cart);
    logEvent(d, {
      type: 'BON_STORNO',
      text: `Bon-Storno: ${d.cart.lines.length} Positionen, ${M.formatEuro(totals.warenBrutto)} – ${reason.trim()}`,
      cashierId,
      approverId,
      shiftId: shift.id,
      data: { cartId: d.cart.id },
      now,
    });
    for (const t of d.tanks) if (t.cartId === d.cart.id) POS.Pumps.detachFromCart(d, t);
    d.cart = null;
  }

  /** Einzelne Position stornieren (normale Kassiererfunktion). */
  function removePosition(d, { lineId, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    assertNoSession(d);
    const { cart, removed } = POS.Cart.removeLine(d.cart, lineId);
    const amount = removed.kind === 'GUTSCHRIFT' ? removed.cents : R.lineGrossCents(removed);
    if (removed.kind === 'KRAFTSTOFF') POS.Pumps.detachFromCart(d, d.tanks.find((t) => t.id === removed.tankId));
    d.cart = cart.lines.length ? cart : null;
    logEvent(d, {
      type: 'POSITION_STORNO',
      text: `Position storniert: ${removed.qty || ''}x ${removed.name || removed.label} (${M.formatEuro(amount)})`,
      cashierId,
      shiftId: shift.id,
      now,
    });
    return removed;
  }

  // ---------------------------------------------------------------- Leergut und Pfandbons

  /**
   * Leergutbon erstellen. entries: [{depositId, qty}]. Der Bon ist danach OFFEN und
   * kann genau einmal eingeloest oder ausgezahlt werden.
   */
  function createVoucher(d, { entries, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    const details = entries
      .filter((e) => Number.isInteger(e.qty) && e.qty > 0)
      .map((e) => {
        const dep = d.deposits.find((x) => x.id === e.depositId);
        if (!dep) throw fail('PFAND_UNBEKANNT', `Pfandart ${e.depositId} unbekannt`);
        if (e.qty > 9999) throw fail('MENGE_UNGUELTIG', 'Menge zu groß');
        return { depositId: dep.id, name: dep.name, cents: dep.cents, qty: e.qty };
      });
    if (!details.length) throw fail('LEERGUT_LEER', 'Keine Leergutmenge erfasst');
    const cents = details.reduce((s, x) => s + x.cents * x.qty, 0);
    const code = E.simulationEan13('299', nextId(d, 'voucher'));
    const voucher = {
      code,
      cents,
      status: 'OFFEN',
      createdAt: now.toISOString(),
      cashierId,
      shiftId: shift.id,
      details,
      usedIn: null,
      usedAt: null,
      payoutAt: null,
    };
    d.vouchers.push(voucher);
    logEvent(d, { type: 'LEERGUTBON', text: `Leergutbon ${code} über ${M.formatEuro(cents)}`, cashierId, shiftId: shift.id, now });
    return voucher;
  }

  function findVoucher(d, code) {
    const v = d.vouchers.find((x) => x.code === code);
    if (!v) throw fail('PFANDBON_NICHT_GEFUNDEN', `Pfandbon ${code} nicht gefunden`);
    return v;
  }

  /** Pfandbon sofort in bar auszahlen. Gibt den Bon danach nicht mehr frei. */
  function payoutVoucher(d, { code, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    const v = findVoucher(d, code);
    if (v.status !== 'OFFEN') throw fail('PFANDBON_NICHT_EINLOESBAR', `Pfandbon ${code} ist bereits ${v.status.toLowerCase()}`);
    v.status = 'AUSGEZAHLT';
    v.payoutAt = now.toISOString();
    cashMove(d, { type: 'PFAND_AUSZAHLUNG', cents: -v.cents, cashierId, shiftId: shift.id, ref: code, now });
    logEvent(d, { type: 'PFAND_AUSZAHLUNG', text: `Pfandbon ${code} ausgezahlt: ${M.formatEuro(v.cents)}`, cashierId, shiftId: shift.id, now });
    return v;
  }

  // ---------------------------------------------------------------- Retoure

  /**
   * Rueckgabe nach abgeschlossenem Verkauf. items: [{lineId, qty}].
   * Erstattet Ware plus Pfand. Bereits retournierte Mengen koennen nicht erneut erstattet werden.
   */
  function returnSale(d, { bonNr, items, restock, refund, approverId, cashierId, reason, now = new Date() }) {
    const shift = requireShift(d);
    const sale = d.sales.find((s) => s.id === bonNr && s.kind === 'VERKAUF');
    if (!sale) throw fail('BON_NICHT_GEFUNDEN', `Bon ${bonNr} nicht gefunden`);
    if (!items || !items.length) throw fail('POSITION_FEHLT', 'Keine Positionen für die Retoure gewählt');
    if (!reason || !reason.trim()) throw fail('GRUND_FEHLT', 'Bitte einen Grund für die Retoure angeben');

    const refLines = [];
    let refundCents = 0;
    for (const it of items) {
      const line = sale.lines.find((l) => l.id === it.lineId && l.kind === 'ART');
      if (!line) throw fail('POSITION_NICHT_GEFUNDEN', 'Position nicht gefunden');
      const available = line.qty - (line.returnedQty || 0);
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > available) {
        throw fail('MENGE_UNGUELTIG', `Retourenmenge für ${line.name} ungültig (verfügbar: ${available})`);
      }
      const share = M.divRound(R.lineGrossCents(line) * it.qty, line.qty);
      const pfand = it.qty * R.pfandCentsPerUnit(line.pfand);
      const cents = share + pfand;
      refundCents += cents;
      line.returnedQty = (line.returnedQty || 0) + it.qty;
      refLines.push({ id: line.id, kind: 'ART', articleId: line.articleId, name: line.name, qty: -it.qty, cents: -cents });
      if (restock) stockMove(d, { articleId: line.articleId, qty: it.qty, type: 'RETOURE', ref: bonNr, cashierId, now });
    }
    sale.status = sale.lines.every((l) => l.kind !== 'ART' || (l.returnedQty || 0) === l.qty) ? 'RETOURIERT' : 'TEILRETOURIERT';

    const method = refund === 'KARTE' ? 'KARTE' : 'BAR';
    const rid = 'R-' + pad(nextId(d, 'ret'), 6);
    const record = {
      id: rid,
      bonNr: rid,
      refBonNr: bonNr,
      kind: 'RETOURE',
      status: 'ABGESCHLOSSEN',
      cartId: null,
      shiftId: shift.id,
      cashierId,
      approverId,
      kassenNr: sale.kassenNr,
      ts: now.toISOString(),
      lines: refLines,
      totals: { gesamt: -refundCents },
      payments: [{ type: method, cents: -refundCents, ref: method === 'KARTE' ? 'RETOURE-SIM' : null }],
      reason: reason.trim(),
      simulation: true,
    };
    d.sales.push(record);
    if (method === 'BAR') cashMove(d, { type: 'RETOURE_BAR', cents: -refundCents, cashierId, shiftId: shift.id, ref: rid, reason: reason.trim(), now });
    logEvent(d, {
      type: 'RETOURE',
      text: `Retoure zu ${bonNr}: ${M.formatEuro(refundCents)} (${method}) – ${reason.trim()}`,
      cashierId,
      approverId,
      shiftId: shift.id,
      now,
    });
    return record;
  }

  // ---------------------------------------------------------------- Lager

  function receiveStock(d, { articleId, qty, reason, cashierId, now = new Date() }) {
    if (!Number.isInteger(qty) || qty < 1) throw fail('MENGE_UNGUELTIG', 'Zugangsmenge muss mindestens 1 sein');
    stockMove(d, { articleId, qty, type: 'ZUGANG', reason: reason || 'Warenzugang', cashierId, now });
  }

  function correctStock(d, { articleId, newQty, reason, cashierId, now = new Date() }) {
    if (!Number.isInteger(newQty)) throw fail('MENGE_UNGUELTIG', 'Bestand muss ganzzahlig sein');
    if (!reason || !reason.trim()) throw fail('GRUND_FEHLT', 'Bitte einen Grund für die Bestandskorrektur angeben');
    const art = d.articles.find((a) => a.id === articleId);
    if (!art) throw fail('ARTIKEL_NICHT_GEFUNDEN', 'Artikel nicht gefunden');
    const diff = newQty - art.stock;
    if (diff !== 0) stockMove(d, { articleId, qty: diff, type: 'KORREKTUR', reason: reason.trim(), cashierId, now });
    logEvent(d, { type: 'BESTANDSKORREKTUR', text: `${art.name}: Bestand auf ${newQty} korrigiert – ${reason.trim()}`, cashierId, now });
  }

  /** Inventur: counts = [{articleId, qty}]. Differenzen werden als Bewegung gebucht. */
  function inventory(d, { counts, cashierId, now = new Date() }) {
    let changed = 0;
    for (const c of counts) {
      const art = d.articles.find((a) => a.id === c.articleId);
      if (!art) throw fail('ARTIKEL_NICHT_GEFUNDEN', 'Artikel nicht gefunden');
      if (!Number.isInteger(c.qty)) throw fail('MENGE_UNGUELTIG', `Zählmenge für ${art.name} ungültig`);
      const diff = c.qty - art.stock;
      if (diff !== 0) {
        stockMove(d, { articleId: art.id, qty: diff, type: 'INVENTUR', reason: 'Inventur', cashierId, now });
        changed += 1;
      }
    }
    logEvent(d, { type: 'INVENTUR', text: `Inventur gebucht: ${changed} Artikel mit Differenz`, cashierId, now });
    return changed;
  }

  // ---------------------------------------------------------------- Stammdaten

  function validateArticle(d, a, selfId) {
    const name = (a.name || '').trim();
    if (name.length < 3 || name.length > 80) throw fail('STAMM_UNGUELTIG', 'Artikelbezeichnung: 3 bis 80 Zeichen');
    if (!d.categories.some((c) => c.id === a.category)) throw fail('STAMM_UNGUELTIG', 'Kategorie unbekannt');
    if (!Number.isInteger(a.priceCents) || a.priceCents <= 0) throw fail('STAMM_UNGUELTIG', 'Verkaufspreis muss größer als 0 sein');
    if (![7, 19].includes(a.vat)) throw fail('STAMM_UNGUELTIG', 'MwSt.-Satz muss 7 oder 19 sein');
    if (![0, 16, 18].includes(a.ageCheck)) throw fail('STAMM_UNGUELTIG', 'Altersprüfung: 0, 16 oder 18');
    if (!Number.isInteger(a.minStock) || a.minStock < 0) throw fail('STAMM_UNGUELTIG', 'Mindestbestand ungültig');
    for (const p of a.pfand || []) {
      if (!d.deposits.some((x) => x.id === p.depositId)) throw fail('STAMM_UNGUELTIG', `Pfandart ${p.depositId} unbekannt`);
      if (!Number.isInteger(p.qty) || p.qty < 1 || p.qty > 999) throw fail('STAMM_UNGUELTIG', 'Pfand-Menge 1 bis 999');
    }
    if (a.plu && !/^\d{1,6}$/.test(a.plu)) throw fail('STAMM_UNGUELTIG', 'PLU: 1 bis 6 Ziffern');
    if (a.plu && d.articles.some((x) => x.plu === a.plu && x.id !== selfId)) throw fail('STAMM_UNGUELTIG', `PLU ${a.plu} ist bereits vergeben`);
    if (a.ean && !E.isValid(a.ean)) throw fail('STAMM_UNGUELTIG', 'EAN ist ungültig (Prüfziffer oder Länge)');
    if (a.ean && d.articles.some((x) => x.ean === a.ean && x.id !== selfId)) throw fail('STAMM_UNGUELTIG', `EAN ${a.ean} ist bereits vergeben`);
  }

  /** Neuer oder geaenderter Artikel. Ohne EAN wird ein fiktiver Testcode vergeben. */
  function upsertArticle(d, data, { cashierId, now = new Date() } = {}) {
    const existing = data.id ? d.articles.find((a) => a.id === data.id) : null;
    if (data.id && !existing) throw fail('ARTIKEL_NICHT_GEFUNDEN', 'Artikel nicht gefunden');
    const a = {
      name: data.name,
      brand: data.brand || '',
      category: data.category,
      gebinde: data.gebinde || '',
      packUnit: data.packUnit || 'Einzel',
      priceCents: data.priceCents,
      vat: data.vat,
      pfand: (data.pfand || []).map((p) => ({ depositId: p.depositId, qty: p.qty })),
      ageCheck: data.ageCheck || 0,
      minStock: data.minStock || 0,
      active: data.active !== false,
      ean: data.ean ? data.ean.trim() : '',
      plu: data.plu ? String(data.plu).trim() : '',
    };
    if (!a.plu) {
      a.plu = existing ? existing.plu : String(d.articles.reduce((m, x) => Math.max(m, parseInt(x.plu, 10) || 0), 1000) + 1);
    }
    if (!a.ean) a.ean = existing ? existing.ean : freeSimulationEan(d);
    validateArticle(d, a, existing ? existing.id : null);
    if (existing) {
      Object.assign(existing, a);
      logEvent(d, { type: 'ARTIKEL_GEAENDERT', text: `Artikel geändert: ${existing.name}`, cashierId, now });
      return existing;
    }
    const article = { id: 'A' + pad(nextId(d, 'article'), 4), ...a, stock: 0, simulation: true };
    d.articles.push(article);
    logEvent(d, { type: 'ARTIKEL_ANGELEGT', text: `Artikel angelegt: ${article.name}`, cashierId, now });
    return article;
  }

  function freeSimulationEan(d) {
    let seq = 100000 + nextId(d, 'ean');
    let code = E.simulationEan13('200', seq);
    while (d.articles.some((x) => x.ean === code)) {
      seq += 1;
      code = E.simulationEan13('200', seq);
    }
    return code;
  }

  function upsertStaff(d, data, { cashierId, now = new Date() } = {}) {
    if (!/^\d{4,6}$/.test(data.nr || '')) throw fail('STAMM_UNGUELTIG', 'Personalnummer: 4 bis 6 Ziffern');
    if (!/^\d{4,8}$/.test(data.pin || '')) throw fail('STAMM_UNGUELTIG', 'PIN: 4 bis 8 Ziffern');
    if (!(data.name || '').trim()) throw fail('STAMM_UNGUELTIG', 'Name fehlt');
    if (!R.ROLE_LEVEL[data.role]) throw fail('STAMM_UNGUELTIG', 'Rolle ungültig');
    if (d.staff.some((s) => s.nr === data.nr && s.id !== data.id)) throw fail('STAMM_UNGUELTIG', 'Personalnummer bereits vergeben');
    const existing = data.id ? d.staff.find((s) => s.id === data.id) : null;
    const rec = { nr: data.nr, name: data.name.trim(), pin: data.pin, role: data.role, active: data.active !== false };
    if (existing) {
      Object.assign(existing, rec);
      logEvent(d, { type: 'MITARBEITER_GEAENDERT', text: `Mitarbeiter geändert: ${rec.name}`, cashierId, now });
      return existing;
    }
    const staff = { id: 'U' + pad(nextId(d, 'staff'), 3), ...rec };
    d.staff.push(staff);
    logEvent(d, { type: 'MITARBEITER_ANGELEGT', text: `Mitarbeiter angelegt: ${rec.name} (${rec.role})`, cashierId, now });
    return staff;
  }

  function upsertDeposit(d, data, { cashierId, now = new Date() } = {}) {
    if (!(data.name || '').trim()) throw fail('STAMM_UNGUELTIG', 'Name fehlt');
    if (!Number.isInteger(data.cents) || data.cents < 0) throw fail('STAMM_UNGUELTIG', 'Pfandbetrag in Cent ungültig');
    const existing = d.deposits.find((x) => x.id === data.id);
    if (!existing) throw fail('PFAND_UNBEKANNT', 'Pfandart nicht gefunden');
    const before = existing.cents;
    existing.name = data.name.trim();
    existing.cents = data.cents;
    if (before !== data.cents) {
      logEvent(d, { type: 'PFAND_GEAENDERT', text: `Pfand ${existing.name}: ${M.formatEuro(before)} → ${M.formatEuro(data.cents)}`, cashierId, now });
    }
    return existing;
  }

  // ---------------------------------------------------------------- Bargeld-Automat

  const A = () => POS.Automat;

  /** Eine Bewegung im Automaten. count > 0: Zugang in den Automaten, count < 0: Abgang. */
  function automatMove(d, { type, denom, count, ref = null, reason = '', cashierId = null, shiftId = null, now = new Date() }) {
    d.automatMoves.push({ id: nextId(d, 'automatmove'), ts: now.toISOString(), shiftId, type, denom, count, cents: denom * count, ref, reason, cashierId });
  }

  function openAutomatSession(d) {
    return d.automatSession && d.automatSession.status === 'OFFEN' ? d.automatSession : null;
  }

  function requireSession(d) {
    const s = openAutomatSession(d);
    if (!s) throw fail('AUTOMAT_KEINE_SITZUNG', 'Keine offene Automat-Zahlung');
    return s;
  }

  function assertNoSession(d) {
    if (d.automatSession) throw fail('AUTOMAT_SITZUNG_OFFEN', 'Eine Automat-Zahlung läuft. Erst abschließen oder abbrechen.');
  }

  function slotFor(d, value) {
    const sl = A().slot(d, value);
    if (!sl) throw fail('AUTOMAT_NICHT_AKZEPTIERT', `${A().label(value)} wird vom Automaten nicht geführt`);
    return sl;
  }

  function assertMachineReady(d) {
    const fault = d.automat.fault ? d.automat.fault.reason : '';
    if (d.automat.mode === 'AUSSER_BETRIEB') throw fail('AUTOMAT_AUSSER_BETRIEB', `Automat außer Betrieb${fault ? ': ' + fault : ''}`);
    if (d.automat.mode === 'STOERUNG') throw fail('AUTOMAT_STOERUNG', `Automat-Störung${fault ? ': ' + fault : ''}`);
  }

  /** Mengenliste normalisieren: [{value, count}], nur Stückzahlen größer 0, ganzzahlig. */
  function normalizeEntries(entries) {
    const out = [];
    for (const e of entries || []) {
      if (!Number.isInteger(e.count) || e.count < 0) throw fail('MENGE_UNGUELTIG', 'Stückzahl muss eine ganze Zahl ab 0 sein');
      if (e.count > 0) out.push({ value: e.value, count: e.count });
    }
    return out;
  }

  /** Startet eine Automat-Zahlung für den offenen Bon. Der Betrag wird damit eingefroren. */
  function automatStart(d, { cashierId, now = new Date() } = {}) {
    const shift = requireShift(d);
    assertNoSession(d);
    assertMachineReady(d);
    const cart = d.cart;
    if (!cart || !cart.lines.length) throw fail('WARENKORB_LEER', 'Der Warenkorb ist leer');
    if (cart.payments.length) throw fail('ZAHLUNG_BEREITS_ERFASST', 'Für diesen Bon ist bereits eine Zahlung erfasst');
    const totals = R.computeTotals(cart);
    if (totals.gesamt <= 0) throw fail('NICHTS_ZU_ZAHLEN', 'Bei diesem Bon wird nichts über den Automaten kassiert');
    const session = {
      id: 'AZ' + pad(nextId(d, 'automatsession'), 6),
      cartId: cart.id,
      shiftId: shift.id,
      cashierId,
      dueCents: totals.gesamt,
      deposits: [],
      status: 'OFFEN',
      startedAt: now.toISOString(),
      closedAt: null,
      bonNr: null,
      change: [],
      reason: null,
    };
    d.automatSession = session;
    logEvent(d, { type: 'AUTOMAT_START', text: `Automat-Zahlung ${session.id} gestartet: ${M.formatEuro(session.dueCents)}`, cashierId, shiftId: shift.id, data: { sessionId: session.id }, now });
    return session;
  }

  /** Ein angenommenes Geldstück. Bestand und Sitzung werden gemeinsam geschrieben. */
  function automatDeposit(d, { value, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    const session = requireSession(d);
    const sl = slotFor(d, value);
    if (!sl.accepted) throw fail('AUTOMAT_NICHT_AKZEPTIERT', `${A().label(value)} ist in den Automat-Einstellungen nicht freigegeben`);
    assertMachineReady(d);
    const have = A().counts(d)[value] || 0;
    if (have + 1 > sl.capacity) throw fail('AUTOMAT_BEHAELTER_VOLL', `Behälter ${A().label(value)} ist voll (${sl.capacity} Stück)`);
    session.deposits.push({ id: `${session.id}-${session.deposits.length + 1}`, denom: value, ts: now.toISOString() });
    automatMove(d, { type: 'EINZAHLUNG', denom: value, count: 1, ref: session.id, cashierId, shiftId: shift.id, now });
    return { paidCents: A().sessionPaid(session), dueCents: session.dueCents };
  }

  /** Abgelehnt (Rückgabe an den Kunden). Nichts wird gebucht, Störungen setzen den Betriebszustand. */
  function automatReject(d, { value, reason, cashierId, now = new Date() }) {
    const shift = requireShift(d);
    const session = requireSession(d);
    if (!A().FAULT_LABEL[reason]) throw fail('STOERUNG_UNBEKANNT', 'Unbekannte Störung');
    logEvent(d, {
      type: 'AUTOMAT_ABGELEHNT',
      text: `${A().label(value)}: ${A().FAULT_LABEL[reason]}`,
      cashierId,
      shiftId: shift.id,
      data: { sessionId: session.id, value, reason },
      now,
    });
    if (reason === 'SCHEIN_KLEMMT' || reason === 'AUSSER_BETRIEB') {
      d.automat.mode = reason === 'SCHEIN_KLEMMT' ? 'STOERUNG' : 'AUSSER_BETRIEB';
      d.automat.fault = { reason: A().FAULT_LABEL[reason], since: now.toISOString(), sessionId: session.id };
    }
  }

  /**
   * Abbruch der Automat-Zahlung. Vor der ersten Einzahlung passiert nichts am Bestand.
   * Danach werden genau die eingezahlten Stücke wieder ausgegeben (virtuelle Erstattung).
   */
  function automatCancel(d, { cashierId, reason = '', now = new Date() }) {
    const shift = requireShift(d);
    const session = requireSession(d);
    const paid = A().sessionPaid(session);
    if (session.deposits.length && !(reason || '').trim()) throw fail('GRUND_FEHLT', 'Bitte einen Grund für den Abbruch angeben');
    const need = {};
    for (const x of session.deposits) need[x.denom] = (need[x.denom] || 0) + 1;
    const have = A().counts(d);
    for (const v of Object.keys(need)) {
      if (have[v] < need[v]) throw fail('AUTOMAT_BESTAND_FEHLT', `Erstattung nicht möglich: ${A().label(Number(v))} fehlt im Automaten`);
    }
    const refund = Object.keys(need).map(Number).sort((a, b) => b - a);
    for (const v of refund) {
      automatMove(d, { type: 'ERSTATTUNG', denom: v, count: -need[v], ref: session.id, reason: (reason || '').trim(), cashierId, shiftId: shift.id, now });
    }
    session.status = 'ABGEBROCHEN';
    session.closedAt = now.toISOString();
    session.reason = (reason || '').trim() || null;
    d.automatSessions.push(session);
    d.automatSession = null;
    logEvent(d, {
      type: 'AUTOMAT_ABBRUCH',
      text: paid ? `Automat-Zahlung ${session.id} abgebrochen, erstattet ${M.formatEuro(paid)}` : `Automat-Zahlung ${session.id} abgebrochen`,
      cashierId,
      shiftId: shift.id,
      data: { sessionId: session.id },
      now,
    });
    return { refundCents: paid, refund: refund.map((v) => ({ value: v, count: need[v] })) };
  }

  /**
   * Abschluss: Bon wird bezahlt und das Rückgeld aus dem tatsächlichen Bestand herausgegeben.
   * Gelingt die exakte Herausgabe nicht, bleibt alles offen und nichts wird gebucht.
   * changeFault: simulierte Störung der Rückgeldeinheit (nur Trainingsmodus, siehe UI).
   */
  function automatComplete(d, { cashierId, changeFault = false, now = new Date(), durationMs = null }) {
    const shift = requireShift(d);
    const session = requireSession(d);
    const cart = d.cart;
    const changed = fail('AUTOMAT_BON_GEAENDERT', 'Der Bon hat sich geändert. Bitte die Automat-Zahlung abbrechen und neu starten.');
    if (!cart || cart.id !== session.cartId) throw changed;
    if (cart.payments.length) throw fail('ZAHLUNG_BEREITS_ERFASST', 'Für diesen Bon ist bereits eine Zahlung erfasst');
    const due = R.computeTotals(cart).gesamt;
    if (due !== session.dueCents) throw changed;
    const paid = A().sessionPaid(session);
    if (paid < due) throw fail('ZAHLBETRAG_ZU_NIEDRIG', `Eingezahlt ${M.formatEuro(paid)}, offen ${M.formatEuro(due - paid)}`);
    if (changeFault) throw fail('WECHSEL_STOERUNG', 'Rückgeldeinheit meldet eine Störung. Die Zahlung bleibt offen.');
    const change = paid - due;
    const plan = A().planChange(change, A().counts(d));
    if (!plan.ok) {
      throw fail('WECHSELGELD_NICHT_MOEGLICH', `Wechselgeld ${M.formatEuro(change)} kann mit dem Automatenbestand nicht exakt herausgegeben werden`);
    }

    // Ab hier nur noch Schreibzugriffe. Der Entwurf wird insgesamt gespeichert oder verworfen.
    // rueckgeld: tatsächlich ausgegebene Stücke (nicht eine Standardaufteilung)
    cart.payments.push({ type: 'AUTOMAT', cents: due, given: paid, change, sessionId: session.id, rueckgeld: plan.plan.map((p) => ({ ...p })) });
    const sale = finalizeSale(d, { cashierId, now, durationMs });
    for (const step of plan.plan) {
      automatMove(d, { type: 'RUECKGELD', denom: step.value, count: -step.count, ref: sale.bonNr, cashierId, shiftId: shift.id, now });
    }
    session.status = 'ABGESCHLOSSEN';
    session.closedAt = now.toISOString();
    session.bonNr = sale.bonNr;
    session.change = plan.plan.map((p) => ({ ...p }));
    d.automatSessions.push(session);
    d.automatSession = null;
    logEvent(d, {
      type: 'AUTOMAT_ABGESCHLOSSEN',
      text: `Automat-Zahlung zu ${sale.bonNr}: eingezahlt ${M.formatEuro(paid)}, Rückgeld ${M.formatEuro(change)}`,
      cashierId,
      shiftId: shift.id,
      data: { bonNr: sale.bonNr, sessionId: session.id },
      now,
    });
    return { sale, paid, change, plan: plan.plan };
  }

  /** Befüllen aus der Kassenlade. entries: [{value, count}]. Eine Buchung je Vorgang, gemeinsame Chargen-ID. */
  function automatFill(d, { entries, cashierId, approverId = null, reason = 'Befüllung', now = new Date() }) {
    const shift = requireShift(d);
    assertNoSession(d);
    const list = normalizeEntries(entries);
    if (!list.length) throw fail('MENGE_UNGUELTIG', 'Keine Stückzahl erfasst');
    const have = A().counts(d);
    let sum = 0;
    for (const e of list) {
      const sl = slotFor(d, e.value);
      if (have[e.value] + e.count > sl.capacity) {
        throw fail('AUTOMAT_BEHAELTER_VOLL', `${A().label(e.value)}: Platz für höchstens ${sl.capacity - have[e.value]} Stück`);
      }
      sum += e.value * e.count;
    }
    const batch = 'AB' + pad(nextId(d, 'automatbatch'), 5);
    for (const e of list) automatMove(d, { type: 'BEFUELLUNG', denom: e.value, count: e.count, ref: batch, reason, cashierId, shiftId: shift.id, now });
    cashMove(d, { type: 'AUTOMAT_BEFUELLUNG', cents: -sum, reason: `Automat ${batch}`, cashierId, shiftId: shift.id, ref: batch, now });
    logEvent(d, { type: 'AUTOMAT_BEFUELLUNG', text: `Automat befüllt (${batch}): ${M.formatEuro(sum)}`, cashierId, approverId, shiftId: shift.id, data: { batch }, now });
    return { batch, cents: sum };
  }

  /** Entleeren in die Kassenlade. Es wird nie mehr entnommen, als im Automaten liegt. */
  function automatEmpty(d, { entries, cashierId, approverId = null, reason = 'Entleerung', now = new Date() }) {
    const shift = requireShift(d);
    assertNoSession(d);
    const list = normalizeEntries(entries);
    if (!list.length) throw fail('MENGE_UNGUELTIG', 'Keine Stückzahl erfasst');
    const have = A().counts(d);
    let sum = 0;
    for (const e of list) {
      slotFor(d, e.value);
      if (have[e.value] < e.count) throw fail('AUTOMAT_BESTAND_FEHLT', `${A().label(e.value)}: nur ${have[e.value]} Stück im Automaten`);
      sum += e.value * e.count;
    }
    const batch = 'AB' + pad(nextId(d, 'automatbatch'), 5);
    for (const e of list) automatMove(d, { type: 'ENTLEERUNG', denom: e.value, count: -e.count, ref: batch, reason, cashierId, shiftId: shift.id, now });
    cashMove(d, { type: 'AUTOMAT_ENTLEERUNG', cents: sum, reason: `Automat ${batch}`, cashierId, shiftId: shift.id, ref: batch, now });
    logEvent(d, { type: 'AUTOMAT_ENTLEERUNG', text: `Automat entleert (${batch}): ${M.formatEuro(sum)}`, cashierId, approverId, shiftId: shift.id, data: { batch }, now });
    return { batch, cents: sum };
  }

  /** Betriebszustand setzen. Störungen brauchen einen Grund, Rückkehr zu Betriebsbereit nicht. */
  function automatSetMode(d, { mode, reason = '', cashierId, approverId = null, now = new Date() }) {
    if (!['BETRIEBSBEREIT', 'STOERUNG', 'AUSSER_BETRIEB'].includes(mode)) throw fail('STAMM_UNGUELTIG', 'Betriebszustand ungültig');
    const text = (reason || '').trim();
    if (mode !== 'BETRIEBSBEREIT' && !text) throw fail('GRUND_FEHLT', 'Bitte einen Grund für die Störung angeben');
    const before = d.automat.mode;
    const session = openAutomatSession(d);
    d.automat.mode = mode;
    d.automat.fault = mode === 'BETRIEBSBEREIT' ? null : { reason: text, since: now.toISOString(), sessionId: session ? session.id : null };
    logEvent(d, {
      type: 'AUTOMAT_BETRIEB',
      text: `Automat: ${before} → ${mode}${text ? ' – ' + text : ''}`,
      cashierId,
      approverId,
      shiftId: (currentShift(d) || {}).id || null,
      now,
    });
  }

  /** Behälter-Einstellungen: Annahme, Kapazität und Mindestbestand je Stückelung. */
  function automatConfigure(d, { value, accepted, capacity, minimum, cashierId, now = new Date() }) {
    const sl = slotFor(d, value);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99999) throw fail('STAMM_UNGUELTIG', 'Kapazität: 1 bis 99999 Stück');
    if (!Number.isInteger(minimum) || minimum < 0 || minimum > capacity) throw fail('STAMM_UNGUELTIG', 'Mindestbestand: 0 bis zur Kapazität');
    if (capacity < (A().counts(d)[value] || 0)) throw fail('STAMM_UNGUELTIG', 'Kapazität ist kleiner als der aktuelle Bestand');
    const before = `${sl.accepted ? 'angenommen' : 'gesperrt'}, Kapazität ${sl.capacity}, Minimum ${sl.minimum}`;
    Object.assign(sl, { accepted: !!accepted, capacity, minimum });
    const after = `${sl.accepted ? 'angenommen' : 'gesperrt'}, Kapazität ${sl.capacity}, Minimum ${sl.minimum}`;
    if (before !== after) {
      logEvent(d, { type: 'AUTOMAT_KONFIG', text: `Automat ${A().label(value)}: ${before} → ${after}`, cashierId, now });
    }
  }

  /**
   * Zählung des Automaten. counts = [{value, count}] (alle Stückelungen). Bucht nichts,
   * sondern hält die Abweichung zum Soll fest, damit sie geprüft und nachgebucht werden kann.
   */
  function automatCount(d, { counts: entries, cashierId, now = new Date() }) {
    const have = A().counts(d);
    const rows = A().DENOMS.map((x) => {
      const got = entries.find((e) => e.value === x.value);
      const ist = got ? got.count : 0;
      if (!Number.isInteger(ist) || ist < 0) throw fail('MENGE_UNGUELTIG', `Zählung ${A().label(x.value)} ungültig`);
      return { value: x.value, soll: have[x.value] || 0, ist, diff: ist - (have[x.value] || 0) };
    });
    const sollCents = rows.reduce((s, r) => s + r.value * r.soll, 0);
    const istCents = rows.reduce((s, r) => s + r.value * r.ist, 0);
    const diffCents = istCents - sollCents;
    const shift = currentShift(d);
    logEvent(d, {
      type: 'AUTOMAT_ZAEHLUNG',
      text: `Automat gezählt: Soll ${M.formatEuro(sollCents)}, Ist ${M.formatEuro(istCents)}, Differenz ${M.formatEuro(diffCents)}`,
      cashierId,
      shiftId: shift ? shift.id : null,
      data: { rows: rows.filter((r) => r.diff !== 0) },
      now,
    });
    return { rows, sollCents, istCents, diffCents };
  }

  POS.Ledger = {
    nextId,
    logEvent,
    currentShift,
    requireShift,
    cashMove,
    stockMove,
    openShift,
    closeShift,
    shiftSummary,
    finalizeSale,
    cancelBon,
    removePosition,
    createVoucher,
    findVoucher,
    payoutVoucher,
    returnSale,
    receiveStock,
    correctStock,
    inventory,
    validateArticle,
    upsertArticle,
    upsertStaff,
    upsertDeposit,
    automatShiftSummary,
    automatStart,
    automatDeposit,
    automatReject,
    automatCancel,
    automatComplete,
    automatFill,
    automatEmpty,
    automatSetMode,
    automatConfigure,
    automatCount,
    openAutomatSession,
  };
})(typeof window !== 'undefined' ? window : globalThis);
