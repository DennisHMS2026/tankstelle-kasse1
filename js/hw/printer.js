/**
 * Bondruck ueber den Browserdruck (lokal installierter Druckertreiber).
 *
 * Die Bons werden als Monospace-Text mit festen Spaltenbreiten erzeugt
 * (48 Zeichen bei 80 mm, 32 Zeichen bei 58 mm). Der Text landet in einem <pre>-Block
 * im Druckbereich; alle Bedienelemente werden beim Drucken ausgeblendet.
 *
 * Grenzen: Die Anwendung kennt den Druckerstatus NICHT (Browser-Druckdialog).
 * Eine Hardwarepruefung gilt erst als erfolgreich, wenn ein Testbon physisch geprueft wurde.
 * ESC/POS-Direktdruck ist nicht implementiert (siehe README).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const M = POS.Money;
  const R = POS.Rules;

  const SIM_NOTE = 'SIMULATION – KEIN GÜLTIGER BELEG';

  function widthOf(cfg) {
    return cfg.paperWidth === 58 ? 32 : 48;
  }

  function wrap(text, n) {
    const out = [];
    let s = String(text);
    while (s.length > n) {
      let cut = s.lastIndexOf(' ', n);
      if (cut <= 0) cut = n;
      out.push(s.slice(0, cut));
      s = s.slice(cut).trimStart();
    }
    out.push(s);
    return out;
  }

  function center(text, W) {
    return wrap(text, W)
      .map((t) => ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t)
      .join('\n');
  }

  /** Feste Spalten: Menge 4 | Text W-14 | Betrag 10 (rechtsbuendig). */
  function row(qty, label, amount, W) {
    const nameW = W - 14;
    const parts = wrap(label || '', nameW);
    const first = (qty || '').padEnd(4).slice(0, 4) + parts[0].padEnd(nameW) + (amount || '').padStart(10);
    const rest = parts.slice(1).map((p) => ''.padEnd(4) + p.padEnd(nameW));
    return [first, ...rest].join('\n');
  }

  function hr(W, ch = '-') {
    return ch.repeat(W);
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function mwstBlock(mwst, W) {
    const cols = W === 48 ? [10, 12, 12, 14] : [6, 8, 8, 10];
    const head = ['MwSt %', 'Netto', 'Steuer', 'Brutto'].map((h, i) => (i === 0 ? h.padEnd(cols[0]) : h.padStart(cols[i]))).join('');
    const lines = [head];
    for (const m of mwst) {
      lines.push(
        [`${m.rate}%`.padEnd(cols[0]), M.formatPlain(m.netto).padStart(cols[1]), M.formatPlain(m.steuer).padStart(cols[2]), M.formatPlain(m.brutto).padStart(cols[3])].join('')
      );
    }
    return lines.join('\n');
  }

  /**
   * Gemeinsamer Bonaufbau fuer Verkauf, Vorschau und Retoure.
   * sale: {bonNr, ts, kassenNr, cashierName, lines, totals, payments, kind, preview, refBonNr}
   */
  function receiptText(sale, cfg) {
    const W = widthOf(cfg);
    const out = [];
    out.push(center(cfg.marketName, W));
    out.push(center(cfg.marketAddress, W));
    out.push(center(`Kasse ${sale.kassenNr || cfg.kassenNr}`, W));
    out.push(hr(W, '='));
    const title = sale.preview ? 'VORSCHAU – KEIN VERKAUF' : sale.kind === 'RETOURE' ? 'RETOURE' : 'KASSENBON';
    out.push(center(title, W));
    out.push(row('', `Bon-Nr ${sale.bonNr}`, '', W).trimEnd());
    if (sale.refBonNr) out.push(row('', `zu Bon ${sale.refBonNr}`, '', W).trimEnd());
    out.push(row('', `${fmtDate(sale.ts)}`, '', W).trimEnd());
    out.push(row('', `Kassierer: ${sale.cashierName || '-'}`, '', W).trimEnd());
    out.push(center(sale.preview ? 'VORSCHAU' : SIM_NOTE, W));
    out.push(hr(W));

    const t = sale.totals;
    for (const line of sale.lines) {
      if (line.kind === 'KRAFTSTOFF') {
        out.push(row('1x', line.name, M.formatPlain(line.unitCents), W));
        out.push(row('', `  ${POS.Fuel.formatMl(line.ml)} à ${POS.Fuel.formatPricePerLiter(line.priceMilli)}`, '', W));
      } else if (line.kind === 'ART' && line.unitCents !== undefined) {
        out.push(row(`${line.qty}x`, line.name, M.formatPlain(R.lineGrossCents(line)), W));
        if (line.qty > 1) out.push(row('', `  à ${M.formatPlain(line.unitCents)}`, '', W));
        if (line.discountPct) {
          out.push(row('', `  Rabatt ${line.discountPct}%`, '-' + M.formatPlain(R.lineDiscountCents(line)), W));
        }
        for (const p of line.pfand || []) {
          out.push(row('', `  Pfand ${p.qty * line.qty}x ${p.name}`, M.formatPlain(p.cents * p.qty * line.qty), W));
        }
      } else if (line.kind === 'ART') {
        out.push(row(`${line.qty}x`, line.name, M.formatPlain(line.cents), W));
      } else if (line.kind === 'GUTSCHRIFT') {
        out.push(row('', line.label || `Pfandbon ${line.voucherCode}`, M.formatPlain(line.cents), W));
      }
    }
    out.push(hr(W));
    out.push(row('', 'Warenwert brutto', M.formatPlain(t.warenBrutto || 0), W));
    if (t.rabatt) out.push(row('', 'Rabatt', '-' + M.formatPlain(t.rabatt), W));
    out.push(row('', 'Warenwert nach Rabatt', M.formatPlain(t.ware !== undefined ? t.ware : 0), W));
    if (t.pfand) out.push(row('', 'Pfand', M.formatPlain(t.pfand), W));
    if (t.gutschriften) out.push(row('', 'Pfand-/Leergutgutschrift', M.formatPlain(t.gutschriften), W));
    out.push(hr(W, '='));
    out.push(row('', 'GESAMT EUR', M.formatPlain(t.gesamt), W));
    out.push(hr(W));
    out.push(mwstBlock(t.mwst || [], W));
    out.push(wrap('Pfand und Gutschriften sind nicht mehrwertsteuerpflichtig.', W).join('\n'));
    out.push(hr(W));

    for (const p of sale.payments || []) {
      if (p.type === 'BAR') {
        out.push(row('', 'Bar', M.formatPlain(p.cents), W));
        if (p.given !== undefined) {
          out.push(row('', 'gegeben', M.formatPlain(p.given), W));
          out.push(row('', 'Rückgeld', M.formatPlain(p.change), W));
        }
      } else if (p.type === 'KARTE') {
        out.push(row('', 'Karte (SIMULATION)', M.formatPlain(p.cents), W));
        if (p.ref) out.push(row('', `Autorisierung ${p.ref}`, '', W).trimEnd());
      } else if (p.type === 'AUSZAHLUNG') {
        out.push(row('', 'Auszahlung an Kunde', M.formatPlain(-p.cents), W));
      }
    }
    if (sale.kind === 'RETOURE') {
      for (const p of sale.payments || []) out.push(row('', `Erstattung ${p.type === 'KARTE' ? 'Karte' : 'bar'}`, M.formatPlain(p.cents), W));
    }
    out.push(hr(W));
    out.push(wrap('Simulationsdaten. Keine echten Zahlungen. Keine KassenSichV-/TSE-Konformität.', W).join('\n'));
    out.push(center('*** ENDE ***', W));
    return out.join('\n') + '\n';
  }

  function saleFromRecord(sale, S) {
    const cashier = S.staff.find((s) => s.id === sale.cashierId);
    return { ...sale, cashierName: cashier ? cashier.name : sale.cashierId };
  }

  function cartPreview(cart, S, cfg) {
    const cashier = S.staff.find((s) => s.id === cart.cashierId);
    return receiptText(
      {
        preview: true,
        bonNr: 'VORSCHAU',
        ts: new Date().toISOString(),
        kassenNr: cfg.kassenNr,
        cashierName: cashier ? cashier.name : '',
        lines: cart.lines,
        totals: R.computeTotals(cart),
        payments: cart.payments,
      },
      cfg
    );
  }

  function voucherText(voucher, cfg) {
    const W = widthOf(cfg);
    const out = [];
    out.push(center(cfg.marketName, W));
    out.push(center('LEERGUTBON / PFANDBON', W));
    out.push(hr(W, '='));
    out.push(center(SIM_NOTE, W));
    out.push(row('', `Datum ${fmtDate(voucher.createdAt)}`, '', W).trimEnd());
    out.push(hr(W));
    for (const d of voucher.details) out.push(row(`${d.qty}x`, d.name, M.formatPlain(d.cents * d.qty), W));
    out.push(hr(W, '='));
    out.push(row('', 'Gutschrift gesamt', M.formatPlain(voucher.cents), W));
    out.push(hr(W));
    out.push(center(`Code ${voucher.code}`, W));
    out.push(wrap('Einmal einlösbar oder auszahlbar. Simulation, kein Wertpapier.', W).join('\n'));
    return out.join('\n') + '\n';
  }

  function shiftText(lines, cfg, title = 'KASSENABSCHLUSS') {
    const W = widthOf(cfg);
    const out = [];
    out.push(center(cfg.marketName, W));
    out.push(center(title, W));
    out.push(hr(W, '='));
    out.push(center(SIM_NOTE, W));
    out.push(hr(W));
    for (const [label, value] of lines) out.push(row('', label, value, W));
    out.push(hr(W));
    out.push(center('*** ENDE ***', W));
    return out.join('\n') + '\n';
  }

  function testText(cfg) {
    const W = widthOf(cfg);
    return [
      center(cfg.marketName, W),
      center('TESTBON', W),
      hr(W, '='),
      center(SIM_NOTE, W),
      hr(W),
      `Papierbreite ${cfg.paperWidth} mm (${W} Zeichen)`,
      '0123456789012345678901234567890123456789'.slice(0, W),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ'.slice(0, W),
      row('1x', 'Testartikel 0,5 l', '0,99', W),
      row('', 'Summe', '0,99', W),
      hr(W),
      center('Bitte Zeichenbreite und Abschnitt prüfen.', W),
      center('*** ENDE ***', W),
    ].join('\n') + '\n';
  }

  /** Druckt einen Text. Der Druckdialog des Browsers entscheidet ueber den Drucker. */
  function print(text, cfg) {
    const area = document.getElementById('print-area');
    area.replaceChildren();
    const pre = document.createElement('pre');
    pre.className = 'receipt paper-' + (cfg.paperWidth === 58 ? '58' : '80');
    pre.textContent = text;
    area.append(pre);
    root.print();
  }

  function status() {
    return 'Browserdruck über Druckertreiber – Druckerstatus nicht ermittelbar';
  }

  POS.Printer = { widthOf, receiptText, saleFromRecord, cartPreview, voucherText, shiftText, testText, print, status, SIM_NOTE, wrap };
})(typeof window !== 'undefined' ? window : globalThis);
