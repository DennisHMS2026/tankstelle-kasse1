/**
 * Auswertungen (Dashboard, Nachbestellliste) und CSV-Import/-Export.
 * CSV: Trennzeichen Semikolon, UTF-8 mit BOM (Excel-kompatibel), Dezimalkomma.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const M = POS.Money;
  const E = POS.Ean;

  const pad = (n) => String(n).padStart(2, '0');

  /** Lokales Datum YYYY-MM-DD eines ISO-Zeitstempels. */
  function localDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function todayStr(now = new Date()) {
    return localDate(now.toISOString());
  }

  function sumPayments(sales, type) {
    return sales.reduce((s, sale) => s + sale.payments.filter((p) => p.type === type).reduce((a, p) => a + p.cents, 0), 0);
  }

  function dashboard(d, dateStr) {
    const onDay = (x) => localDate(x.ts) === dateStr;
    const verkaeufe = d.sales.filter((s) => s.kind === 'VERKAUF' && onDay(s));
    const retouren = d.sales.filter((s) => s.kind === 'RETOURE' && onDay(s));
    const alle = verkaeufe.concat(retouren);
    const summeVerkauf = verkaeufe.reduce((s, x) => s + x.totals.gesamt, 0);
    const umsatz = summeVerkauf + retouren.reduce((s, x) => s + x.totals.gesamt, 0);
    const fuelLines = verkaeufe.flatMap((s) => s.lines.filter((l) => l.kind === 'KRAFTSTOFF'));
    const pfandAusz = -d.cashMoves
      .filter((m) => m.type === 'PFAND_AUSZAHLUNG' && localDate(m.ts) === dateStr)
      .reduce((s, m) => s + m.cents, 0);
    return {
      date: dateStr,
      umsatz,
      anzahl: verkaeufe.length,
      retouren: retouren.length,
      durchschnitt: verkaeufe.length ? Math.round(summeVerkauf / verkaeufe.length) : 0,
      bar: sumPayments(alle, 'BAR'),
      karte: sumPayments(alle, 'KARTE'),
      pfandGebucht: verkaeufe.reduce((s, x) => s + x.totals.pfand, 0),
      gutschriften: verkaeufe.reduce((s, x) => s + x.totals.gutschriften, 0),
      pfandAuszahlungen: pfandAusz,
      kraftstoffUmsatz: fuelLines.reduce((s, l) => s + l.unitCents, 0),
      kraftstoffLiter: fuelLines.reduce((s, l) => s + l.ml, 0),
      tankvorgaenge: fuelLines.length,
      niedrigerBestand: d.articles
        .filter((a) => a.active && a.stock <= a.minStock)
        .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name, 'de')),
    };
  }

  /** Nachbestellliste: Zielbestand = doppelter Mindestbestand, mindestens 1 Stueck. */
  function reorderList(d) {
    return d.articles
      .filter((a) => a.active && a.stock <= a.minStock)
      .map((a) => ({ article: a, order: Math.max(1, a.minStock * 2 - a.stock) }));
  }

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(rows) {
    return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  function salesCsv(d) {
    const head = ['Bon', 'Typ', 'Datum', 'Uhrzeit', 'Schicht', 'Kassierer', 'Warenwert', 'Rabatt', 'Pfand', 'Gutschriften', 'Gesamt', 'Bar', 'Karte', 'Status'];
    const cashier = (id) => (d.staff.find((s) => s.id === id) || {}).name || id;
    const rows = d.sales.map((s) => {
      const t = s.totals;
      const day = new Date(s.ts);
      const sumPay = (type) => s.payments.filter((p) => p.type === type).reduce((a, p) => a + p.cents, 0);
      return [
        s.bonNr,
        s.kind === 'RETOURE' ? 'Retoure' : 'Verkauf',
        `${pad(day.getDate())}.${pad(day.getMonth() + 1)}.${day.getFullYear()}`,
        `${pad(day.getHours())}:${pad(day.getMinutes())}:${pad(day.getSeconds())}`,
        s.shiftId,
        cashier(s.cashierId),
        t.warenBrutto !== undefined ? M.formatPlain(t.warenBrutto) : '',
        t.rabatt !== undefined ? M.formatPlain(t.rabatt) : '',
        t.pfand !== undefined ? M.formatPlain(t.pfand) : '',
        t.gutschriften !== undefined ? M.formatPlain(t.gutschriften) : '',
        M.formatPlain(t.gesamt),
        M.formatPlain(sumPay('BAR')),
        M.formatPlain(sumPay('KARTE')),
        s.status,
      ];
    });
    return toCsv([head, ...rows]);
  }

  const ARTICLE_HEAD = ['ean', 'plu', 'name', 'kategorie', 'marke', 'gebinde', 'verpackung', 'verkaufspreis', 'mwst', 'bestand', 'mindestbestand', 'alter', 'pfand', 'aktiv'];

  function articlesCsv(d) {
    const rows = d.articles.map((a) => [
      a.ean, a.plu, a.name, a.category, a.brand, a.gebinde, a.packUnit, M.formatPlain(a.priceCents), a.vat, a.stock, a.minStock, a.ageCheck,
      a.pfand.map((p) => `${p.depositId}x${p.qty}`).join('+'), a.active ? 'ja' : 'nein',
    ]);
    return toCsv([ARTICLE_HEAD, ...rows]);
  }

  function splitCsvLine(line, delim) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  }

  /**
   * Artikel-CSV lesen und pruefen. Liefert Zeilen mit data oder error.
   * Pflichtspalten: name, kategorie, verkaufspreis, mwst. Optional: ean, plu, marke,
   * gebinde, verpackung, bestand, mindestbestand, alter, pfand ("MW08x12+KASTEN"), aktiv.
   */
  function parseArticleCsv(text, d) {
    const clean = text.replace(/^﻿/, '');
    const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (!lines.length) return { rows: [], fatal: 'Die Datei ist leer' };
    const delim = lines[0].includes(';') ? ';' : ',';
    const head = splitCsvLine(lines[0], delim).map((h) => h.toLowerCase());
    for (const need of ['name', 'kategorie', 'verkaufspreis', 'mwst']) {
      if (!head.includes(need)) return { rows: [], fatal: `Pflichtspalte fehlt: ${need}` };
    }
    const rows = lines.slice(1).map((line, i) => {
      const lineNo = i + 2;
      const cells = splitCsvLine(line, delim);
      const get = (k) => {
        const idx = head.indexOf(k);
        return idx >= 0 && cells[idx] !== undefined ? cells[idx] : '';
      };
      const price = M.parseEuro(get('verkaufspreis'));
      const pfandRaw = get('pfand');
      const pfand = [];
      let pfandError = null;
      if (pfandRaw) {
        for (const part of pfandRaw.split('+')) {
          const m = /^([A-Z0-9]+)x(\d{1,3})$/.exec(part.trim());
          if (!m) pfandError = `Pfand-Angabe ungültig: ${part}`;
          else pfand.push({ depositId: m[1], qty: parseInt(m[2], 10) });
        }
      }
      const data = {
        ean: get('ean'),
        plu: get('plu'),
        name: get('name'),
        category: get('kategorie'),
        brand: get('marke'),
        gebinde: get('gebinde'),
        packUnit: get('verpackung') || 'Einzel',
        priceCents: price,
        vat: parseInt(get('mwst'), 10),
        minStock: parseInt(get('mindestbestand') || '0', 10),
        ageCheck: parseInt(get('alter') || '0', 10),
        pfand,
        active: !/^(nein|0|false)$/i.test(get('aktiv') || 'ja'),
      };
      if (price === null) return { lineNo, error: 'Verkaufspreis ungültig' };
      if (pfandError) return { lineNo, error: pfandError };
      if (data.ean && !E.isValid(data.ean)) return { lineNo, error: `EAN ungültig: ${data.ean}` };
      const dup = data.ean ? d.articles.find((a) => a.ean === data.ean) : null;
      return { lineNo, data, existingId: dup ? dup.id : null };
    });
    return { rows, delim };
  }

  /** Schichtbericht als Text (Druck und Anzeige). */
  function shiftReportLines(d, shift) {
    const s = shift.report || POS.Ledger.shiftSummary(d, shift);
    const cashier = (d.staff.find((x) => x.id === shift.cashierId) || {}).name || shift.cashierId;
    const euro = (c) => M.formatPlain(c);
    const opt = (c) => (c === null || c === undefined ? '–' : euro(c));
    return [
      ['Schicht', shift.id],
      ['Kassierer', cashier],
      ['Eröffnet', new Date(shift.openedAt).toLocaleString('de-DE')],
      ['Geschlossen', shift.endedAt ? new Date(shift.endedAt).toLocaleString('de-DE') : '–'],
      ['Anfangsbestand', euro(s.startCents)],
      ['Barumsatz', euro(s.barUmsatz)],
      ['Kartenumsatz', euro(s.kartenUmsatz)],
      ['Pfandauszahlungen', euro(s.pfandAuszahlungen)],
      ['Bargeldeinlagen', euro(s.einlagen)],
      ['Bargeldentnahmen', euro(s.entnahmen)],
      ['Retouren bar', euro(s.retoureBar)],
      ['Kraftstoffumsatz', euro(s.kraftstoffUmsatz || 0)],
      ['Kraftstoff gezapft', POS.Fuel.formatMl(s.kraftstoffMl || 0)],
      ['Tankvorgänge bezahlt', String(s.tankvorgaenge || 0)],
      ...(s.kraftstoff || []).map((f) => [`  ${f.name}`, `${POS.Fuel.formatMl(f.ml)} · ${euro(f.cents)}`]),
      ['Erwarteter Endbestand', euro(s.expectedCents)],
      ['Gezählter Endbestand', shift.countedCents === null ? '–' : euro(shift.countedCents)],
      ['Kassendifferenz', shift.diffCents === null ? '–' : euro(shift.diffCents)],
      ['Anzahl Verkäufe', String(s.anzahlVerkaeufe)],
      ['Anzahl Stornos', String(s.anzahlStornos)],
      // Bargeld-Automat: getrennt von der Kassenlade (keine Doppelzählung)
      ['— Bargeld-Automat —', ''],
      ['Automat Anfangsbestand', opt(s.automatStartCents)],
      ['Umsatz BAR – AUTOMAT', opt(s.automatUmsatz)],
      ['Automat eingezahlt', opt(s.automatEingezahlt)],
      ['Automat Rückgeld', opt(s.automatRueckgeld)],
      ['Automat Erstattungen', opt(s.automatErstattet)],
      ['Automat befüllt aus Lade', opt(s.automatBefuellt)],
      ['Automat entleert in Lade', opt(s.automatEntleert)],
      ['Automat erwarteter Bestand', opt(s.automatExpectedCents)],
      ['Automat gezählter Bestand', opt(shift.machineCountedCents)],
      ['Automatendifferenz', opt(shift.machineDiffCents)],
    ];
  }

  POS.Reports = {
    localDate,
    todayStr,
    dashboard,
    reorderList,
    toCsv,
    salesCsv,
    articlesCsv,
    parseArticleCsv,
    shiftReportLines,
    ARTICLE_HEAD,
  };
})(typeof window !== 'undefined' ? window : globalThis);
