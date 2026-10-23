/**
 * Verwaltung (nur Marktleitung / Administrator). Alle Schreibzugriffe laufen ueber App.mutate
 * und die Transaktionslogik in js/core/ledger.js.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast, confirmDialog, requestApproval } = POS.Ui;
  const R = POS.Rules;
  const M = POS.Money;
  const L = POS.Ledger;
  const RP = POS.Reports;
  const P = POS.Printer;

  let app = null;
  let host = null;
  let nav = null;
  let current = 'dashboard';
  const state = { artFilter: '', artCat: '', stockFilter: 'alle', dashDate: null, txFilter: '' };

  /** Gruppen: ['__', Titel] ist eine Überschrift, sonst [Schlüssel, Bezeichnung]. */
  const SECTIONS = [
    ['__', 'Umsätze'],
    ['dashboard', 'Dashboard'],
    ['transaktionen', 'Transaktionen'],
    ['schichten', 'Kassenschichten'],
    ['berichte', 'Kassenberichte'],
    ['__', 'Kraftstoff'],
    ['tankstelle', 'Kraftstoffpreise & Tanklager'],
    ['__', 'Bargeld-Automat'],
    ['automat', 'Bestand, Befüllung, Störungen'],
    ['__', 'Shop'],
    ['artikel', 'Artikel'],
    ['preise', 'Shop-Preise'],
    ['kategorien', 'Kategorien'],
    ['pfand', 'Pfand'],
    ['lager', 'Lager'],
    ['__', 'Personal'],
    ['personal', 'Mitarbeiter'],
    ['__', 'Einstellungen'],
    ['drucker', 'Drucker'],
    ['scanner', 'Scanner'],
    ['tasten', 'Tastatur'],
    ['simulation', 'Simulation'],
    ['sicherung', 'Datensicherung'],
    ['systeminfo', 'Systeminfo & Offline'],
  ];

  const S = () => app.S;
  const euro = (c) => M.formatEuro(c);
  const plain = (c) => M.formatPlain(c);
  const field = (label, el, cls = '') => h('label', { class: 'field ' + cls }, h('span', { text: label }), el);
  const btn = (label, onclick, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', onclick, text: label });
  const sim = () => h('span', { class: 'badge simbadge', text: 'SIM' });
  const money = (text) => h('input', { type: 'text', inputmode: 'decimal', value: text });

  /** Teilen-Blatt (z. B. „In Dateien sichern“ oder AirPrint), sonst Datei-Download. */
  async function shareOrDownload(name, text, type) {
    try {
      const file = new File([text], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return 'geteilt';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'abgebrochen';
    }
    download(name, text, type);
    return 'gespeichert';
  }

  function download(name, text, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function table(headers, rows, cls = '') {
    return h(
      'table',
      { class: 'grid ' + cls },
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.r ? 'r' : '', text: x.label || x })))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: headers.length, class: 'hint', text: 'Keine Einträge' })))
    );
  }

  function tile(label, value, hint = '') {
    return h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: label }), h('strong', { class: 'tile-value', text: value }), hint ? h('span', { class: 'tile-hint', text: hint }) : null);
  }

  function section(title, ...kids) {
    return h('section', { class: 'card' }, h('h2', { text: title }), ...kids);
  }

  function run(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (err) {
        errorToast(err);
      }
    };
  }

  // ------------------------------------------------------------ Dashboard

  function dashboardView() {
    const date = state.dashDate || POS.Reports.todayStr();
    const dateInput = h('input', { type: 'date', value: date, onchange: (e) => { state.dashDate = e.target.value; render(); } });
    const r = RP.dashboard(S(), date);
    return h(
      'div',
      {},
      section(
        'Tagesübersicht',
        h('div', { class: 'toolbar' }, field('Datum', dateInput)),
        h(
          'div',
          { class: 'kpis' },
          tile('Tagesumsatz', euro(r.umsatz), 'Verkäufe minus Retouren'),
          tile('Anzahl Verkäufe', String(r.anzahl), `${r.retouren} Retouren`),
          tile('Ø Bonwert', euro(r.durchschnitt)),
          tile('Barumsatz', euro(r.bar)),
          tile('Kartenumsatz', euro(r.karte), 'simuliert'),
          tile('Pfand gebucht', euro(r.pfandGebucht)),
          tile('Pfandauszahlungen', euro(r.pfandAuszahlungen)),
          tile('Gutschriften', euro(r.gutschriften))
        )
      ),
      section(
        `Artikel mit niedrigem Bestand (${r.niedrigerBestand.length})`,
        table(
          ['Artikel', { label: 'Bestand', r: true }, { label: 'Mindestbestand', r: true }, { label: 'Nachbestellen (Vorschlag)', r: true }],
          r.niedrigerBestand.slice(0, 40).map((a) =>
            h('tr', {}, h('td', { text: a.name }), h('td', { class: 'r' + (a.stock < 0 ? ' neg' : ''), text: String(a.stock) }), h('td', { class: 'r', text: String(a.minStock) }), h('td', { class: 'r', text: String(Math.max(1, a.minStock * 2 - a.stock)) }))
          )
        )
      )
    );
  }

  // ------------------------------------------------------------ Artikel

  function articlesView() {
    const s = S();
    const q = h('input', { type: 'search', placeholder: 'Suche Name, EAN, PLU', value: state.artFilter, 'data-keep': 'artSearch', 'aria-label': 'Artikel suchen', oninput: (e) => { state.artFilter = e.target.value; renderBody(); } });
    const cat = h(
      'select',
      { 'aria-label': 'Kategorie', onchange: (e) => { state.artCat = e.target.value; renderBody(); } },
      h('option', { value: '', text: 'Alle Kategorien' }),
      s.categories.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === state.artCat }))
    );
    const q2 = state.artFilter.trim().toLowerCase();
    const list = s.articles.filter((a) => (!state.artCat || a.category === state.artCat) && (!q2 || a.name.toLowerCase().includes(q2) || a.ean.includes(q2) || a.plu.includes(q2)));
    const fileIn = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'CSV-Datei wählen', onchange: run((e) => importArticles(e.target.files[0])) });
    const rows = list.slice(0, 300).map((a) =>
      h(
        'tr',
        { class: a.active ? '' : 'muted' },
        h('td', { text: a.plu }),
        h('td', { class: 'mono', text: a.ean }),
        h('td', {}, a.name, a.simulation ? sim() : null),
        h('td', { text: catName(a.category) }),
        h('td', { text: a.gebinde }),
        h('td', { text: a.packUnit }),
        h('td', { class: 'r', text: plain(a.priceCents) }),
        h('td', { class: 'r', text: a.vat + ' %' }),
        h('td', { text: a.pfand.map((p) => `${p.depositId}×${p.qty}`).join(' + ') || '–' }),
        h('td', { class: 'r' + (a.stock <= a.minStock ? ' warn' : ''), text: String(a.stock) }),
        h('td', { class: 'r', text: String(a.minStock) }),
        h('td', { text: a.ageCheck ? a.ageCheck + '+' : '–' }),
        h('td', { text: a.active ? 'aktiv' : 'inaktiv' }),
        h('td', {}, btn('Bearbeiten', () => articleForm(a), 'small'))
      )
    );
    return h(
      'div',
      {},
      section(
        `Artikel (${list.length} von ${s.articles.length})`,
        h('div', { class: 'toolbar' }, q, cat, btn('Neuer Artikel', () => articleForm(null), 'primary'), btn('CSV-Export', () => download('artikel.csv', RP.articlesCsv(S()))), field('CSV-Import', fileIn, 'inline')),
        h('p', { class: 'hint', text: 'Import: Spalten ean;plu;name;kategorie;marke;gebinde;verpackung;verkaufspreis;mwst;bestand;mindestbestand;alter;pfand;aktiv. Bestehende Artikel werden über die EAN erkannt. Pfand als MW08x12+KASTEN.' }),
        h('div', { class: 'scroll' }, table(['PLU', 'EAN', 'Artikel', 'Kategorie', 'Gebinde', 'Verpackung', { label: 'VK €', r: true }, { label: 'MwSt', r: true }, 'Pfand', { label: 'Bestand', r: true }, { label: 'Min', r: true }, 'Alter', 'Status', ''], rows)),
        list.length > 300 ? h('p', { class: 'hint', text: 'Es werden die ersten 300 Treffer angezeigt. Suche verfeinern.' }) : null
      )
    );
  }

  function catName(id) {
    const c = S().categories.find((x) => x.id === id);
    return c ? c.name : id;
  }

  function articleForm(article) {
    const s = S();
    const v = article || { name: '', brand: '', category: s.categories[0].id, gebinde: '', packUnit: 'Einzel', priceCents: 0, vat: 19, pfand: [], ageCheck: 0, minStock: 5, ean: '', plu: '', active: true };
    const f = {
      name: h('input', { type: 'text', value: v.name, 'data-autofocus': true }),
      brand: h('input', { type: 'text', value: v.brand }),
      category: h('select', {}, s.categories.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === v.category }))),
      gebinde: h('input', { type: 'text', value: v.gebinde }),
      packUnit: h('input', { type: 'text', value: v.packUnit }),
      price: money(article ? plain(v.priceCents) : ''),
      vat: h('select', {}, [7, 19].map((r) => h('option', { value: String(r), text: r + ' %', selected: r === v.vat }))),
      ageCheck: h('select', {}, [0, 16, 18].map((r) => h('option', { value: String(r), text: r ? `ab ${r} Jahren` : 'keine', selected: r === v.ageCheck }))),
      minStock: h('input', { type: 'text', inputmode: 'numeric', value: String(v.minStock) }),
      ean: h('input', { type: 'text', inputmode: 'numeric', value: v.ean, placeholder: 'leer = fiktiver Testcode' }),
      plu: h('input', { type: 'text', inputmode: 'numeric', value: v.plu, placeholder: 'leer = automatisch' }),
      active: h('input', { type: 'checkbox', checked: v.active }),
    };
    const pfandRows = h('div', { class: 'pfand-rows' });
    const addPfandRow = (p = { depositId: s.deposits[0].id, qty: 1 }) => {
      const sel = h('select', {}, s.deposits.map((d) => h('option', { value: d.id, text: `${d.name} (${plain(d.cents)} €)`, selected: d.id === p.depositId })));
      const qty = h('input', { type: 'text', inputmode: 'numeric', value: String(p.qty), class: 'small-input' });
      const row = h('div', { class: 'pfand-row' }, sel, h('span', { text: '×' }), qty, btn('Entfernen', () => row.remove(), 'small danger'));
      row._read = () => ({ depositId: sel.value, qty: parseInt(qty.value, 10) });
      pfandRows.append(row);
    };
    (v.pfand.length ? v.pfand : []).forEach((p) => addPfandRow(p));
    const preview = h('div', { class: 'hint' });
    const save = async () => {
      const priceCents = M.parseEuro(f.price.value);
      if (priceCents === null) throw R.fail('BETRAG_UNGUELTIG', 'Verkaufspreis ungültig');
      const data = {
        id: article ? article.id : undefined,
        name: f.name.value,
        brand: f.brand.value,
        category: f.category.value,
        gebinde: f.gebinde.value,
        packUnit: f.packUnit.value,
        priceCents,
        vat: parseInt(f.vat.value, 10),
        ageCheck: parseInt(f.ageCheck.value, 10),
        minStock: parseInt(f.minStock.value, 10),
        ean: f.ean.value.trim(),
        plu: f.plu.value.trim(),
        active: f.active.checked,
        pfand: [...pfandRows.children].map((r) => r._read()),
      };
      await app.mutate((d) => L.upsertArticle(d, data, { cashierId: null }));
      toast(article ? 'Artikel gespeichert' : 'Artikel angelegt', 'ok');
    };
    openModal({
      title: article ? `Artikel bearbeiten · ${article.name}` : 'Neuer Artikel',
      wide: true,
      content: h(
        'div',
        { class: 'form grid2' },
        field('Bezeichnung', f.name),
        field('Marke', f.brand),
        field('Kategorie', f.category),
        field('Gebinde', f.gebinde),
        field('Verpackungseinheit', f.packUnit),
        field('Verkaufspreis (€, brutto)', f.price),
        field('MwSt.-Satz', f.vat),
        field('Altersprüfung', f.ageCheck),
        field('Mindestbestand', f.minStock),
        field('PLU', f.plu),
        field('EAN (eigene Hersteller-EAN hier eintragen)', f.ean),
        h('label', { class: 'check' }, f.active, ' aktiv'),
        h('div', { class: 'full' }, h('span', { class: 'field-label', text: 'Pfand je Packung (Gebindeart und Anzahl)' }), pfandRows, btn('Pfandzeile hinzufügen', () => addPfandRow(), 'small')),
        preview,
        article ? h('div', { class: 'full hint', text: `Bestand ${article.stock} wird im Menü „Lager“ geändert. Simulation: ${article.simulation ? 'ja' : 'nein'}.` }) : null
      ),
      actions: [{ label: 'Abbrechen' }, { label: 'Speichern', primary: true, run: run(save) }],
    });
  }

  async function importArticles(file) {
    if (!file) return;
    const text = await file.text();
    const parsed = RP.parseArticleCsv(text, S());
    if (parsed.fatal) return errorToast(new Error(parsed.fatal));
    const ok = parsed.rows.filter((r) => !r.error);
    const bad = parsed.rows.filter((r) => r.error);
    openModal({
      title: 'CSV-Import prüfen',
      wide: true,
      content: h(
        'div',
        {},
        h('p', { text: `${ok.length} Zeilen gültig (${ok.filter((r) => r.existingId).length} aktualisieren, ${ok.filter((r) => !r.existingId).length} neu), ${bad.length} fehlerhaft.` }),
        bad.length ? h('ul', { class: 'errors' }, bad.slice(0, 30).map((r) => h('li', { text: `Zeile ${r.lineNo}: ${r.error}` }))) : null,
        h('p', { class: 'hint', text: 'Fehlerhafte Zeilen werden übersprungen. Gültige Zeilen werden in einem Schritt gespeichert.' })
      ),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Importieren',
          primary: true,
          run: async () => {
            if (!ok.length) throw R.fail('IMPORT_LEER', 'Keine gültigen Zeilen');
            await app.mutate((d) => {
              for (const r of ok) {
                const data = { ...r.data, id: r.existingId || undefined };
                if (r.existingId) data.ean = r.data.ean;
                L.upsertArticle(d, data, { cashierId: null });
              }
              L.logEvent(d, { type: 'CSV_IMPORT', text: `Artikel-CSV importiert: ${ok.length} Zeilen` });
            });
            toast(`${ok.length} Artikel importiert`, 'ok');
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------ Preise

  function pricesView() {
    const s = S();
    const cat = h('select', { 'aria-label': 'Kategorie', onchange: (e) => { state.artCat = e.target.value; renderBody(); } }, h('option', { value: '', text: 'Alle Kategorien' }), s.categories.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === state.artCat })));
    const pct = h('input', { type: 'text', inputmode: 'numeric', value: '0', class: 'small-input', 'aria-label': 'Prozent' });
    const list = s.articles.filter((a) => !state.artCat || a.category === state.artCat);
    const rows = list.slice(0, 300).map((a) => {
      const inp = money(plain(a.priceCents));
      return h(
        'tr',
        {},
        h('td', { text: a.name }),
        h('td', { class: 'r' }, inp),
        h('td', {}, btn('Speichern', run(async () => {
          const cents = M.parseEuro(inp.value);
          if (cents === null) throw R.fail('BETRAG_UNGUELTIG', 'Preis ungültig');
          await app.mutate((d) => {
            const art = d.articles.find((x) => x.id === a.id);
            const before = art.priceCents;
            L.upsertArticle(d, { ...art, priceCents: cents, pfand: art.pfand, id: art.id, ean: art.ean, plu: art.plu }, {});
            if (before !== cents) L.logEvent(d, { type: 'PREISAENDERUNG', text: `${art.name}: ${euro(before)} → ${euro(cents)}` });
          });
          toast('Preis gespeichert', 'ok');
        }), 'small')));
    });
    return h(
      'div',
      {},
      section(
        'Verkaufspreise',
        h('div', { class: 'toolbar' }, field('Kategorie', cat), field('Prozentuale Änderung (±)', pct), btn('Kategorie anpassen', run(async () => {
          const p = parseInt(pct.value, 10);
          if (!Number.isInteger(p) || p < -50 || p > 100) throw R.fail('RABATT_UNGUELTIG', 'Prozent zwischen -50 und 100');
          if (!state.artCat) throw R.fail('STAMM_UNGUELTIG', 'Bitte zuerst eine Kategorie wählen');
          await app.mutate((d) => {
            let n = 0;
            for (const art of d.articles.filter((x) => x.category === state.artCat)) {
              const before = art.priceCents;
              art.priceCents = M.divRound(before * (100 + p), 100);
              if (art.priceCents !== before) n++;
            }
            L.logEvent(d, { type: 'PREISAENDERUNG', text: `Kategorie ${catName(state.artCat)}: ${p > 0 ? '+' : ''}${p} % auf ${n} Artikel` });
          });
          toast('Preise angepasst', 'ok');
        }), 'primary')),
        h('div', { class: 'scroll' }, table(['Artikel', { label: 'VK €', r: true }, ''], rows))
      )
    );
  }

  // ------------------------------------------------------------ Kategorien

  function categoriesView() {
    const s = S();
    const rows = s.categories.map((c) => {
      const name = h('input', { type: 'text', value: c.name, 'aria-label': 'Kategoriename' });
      const count = s.articles.filter((a) => a.category === c.id).length;
      return h(
        'tr',
        {},
        h('td', { class: 'mono', text: c.id }),
        h('td', {}, name),
        h('td', { class: 'r', text: String(count) }),
        h('td', {}, btn('Umbenennen', run(async () => {
          const n = name.value.trim();
          if (n.length < 2) throw R.fail('STAMM_UNGUELTIG', 'Name zu kurz');
          await app.mutate((d) => {
            d.categories.find((x) => x.id === c.id).name = n;
            L.logEvent(d, { type: 'KATEGORIE', text: `Kategorie umbenannt: ${n}` });
          });
          toast('Gespeichert', 'ok');
        }), 'small'), ' ', btn('Löschen', run(async () => {
          if (count) throw R.fail('KATEGORIE_BELEGT', 'Kategorie hat Artikel und kann nicht gelöscht werden');
          if (!(await confirmDialog('Kategorie löschen', `„${c.name}“ wirklich löschen?`, 'Löschen', true))) return;
          await app.mutate((d) => {
            d.categories = d.categories.filter((x) => x.id !== c.id);
          });
          toast('Kategorie gelöscht', 'ok');
        }), 'small danger'))
      );
    });
    const newName = h('input', { type: 'text', placeholder: 'Neue Kategorie' });
    return h(
      'div',
      {},
      section(
        'Artikelkategorien',
        table(['ID', 'Name', { label: 'Artikel', r: true }, ''], rows),
        h('div', { class: 'toolbar' }, field('Neue Kategorie', newName), btn('Anlegen', run(async () => {
          const n = newName.value.trim();
          if (n.length < 2) throw R.fail('STAMM_UNGUELTIG', 'Name zu kurz');
          await app.mutate((d) => {
            const id = 'K' + L.nextId(d, 'cat');
            d.categories.push({ id, name: n, sort: d.categories.length + 1 });
          });
          toast('Kategorie angelegt', 'ok');
        }), 'primary'))
      )
    );
  }

  // ------------------------------------------------------------ Pfand

  function depositView() {
    const s = S();
    const rows = s.deposits.map((dep) => {
      const name = h('input', { type: 'text', value: dep.name, 'aria-label': 'Name' });
      const cents = money(plain(dep.cents));
      const used = s.articles.filter((a) => a.pfand.some((p) => p.depositId === dep.id)).length;
      return h(
        'tr',
        {},
        h('td', { class: 'mono', text: dep.id }),
        h('td', {}, name),
        h('td', { text: dep.kind }),
        h('td', { class: 'r' }, cents),
        h('td', { class: 'r', text: String(used) }),
        h('td', {}, btn('Speichern', run(async () => {
          const c = M.parseEuro(cents.value);
          await app.mutate((d) => L.upsertDeposit(d, { id: dep.id, name: name.value, cents: c }, {}));
          toast('Pfand gespeichert', 'ok');
        }), 'small'))
      );
    });
    const open = s.vouchers.filter((v) => v.status === 'OFFEN');
    const vrows = [...s.vouchers].reverse().slice(0, 100).map((v) => h('tr', {}, h('td', { class: 'mono', text: v.code }), h('td', { class: 'r', text: euro(v.cents) }), h('td', { text: v.status }), h('td', { text: v.usedIn || '–' }), h('td', { text: new Date(v.createdAt).toLocaleString('de-DE') })));
    return h(
      'div',
      {},
      section('Pfandarten (Beträge je Gebindeart)', h('p', { class: 'hint', text: 'Änderungen wirken nur auf neue Scans. Bereits gebuchte Bons behalten ihren Betrag.' }), table(['ID', 'Name', 'Art', { label: 'Betrag €', r: true }, { label: 'Artikel', r: true }, ''], rows)),
      section(
        `Pfandbons (${open.length} offen, ${euro(open.reduce((a, v) => a + v.cents, 0))})`,
        h('div', { class: 'scroll' }, table(['Code', { label: 'Wert', r: true }, 'Status', 'Eingelöst in', 'Erstellt'], vrows))
      )
    );
  }

  // ------------------------------------------------------------ Lager

  function stockView() {
    const s = S();
    const reason = h('input', { type: 'text', placeholder: 'Grund für Korrektur (Pflicht)', 'aria-label': 'Grund' });
    const filterSel = h('select', { 'aria-label': 'Filter', onchange: (e) => { state.stockFilter = e.target.value; renderBody(); } }, h('option', { value: 'alle', text: 'Alle Artikel' }), h('option', { value: 'niedrig', selected: state.stockFilter === 'niedrig', text: 'Nur niedriger Bestand' }));
    const list = s.articles.filter((a) => state.stockFilter !== 'niedrig' || a.stock <= a.minStock);
    const rows = list.slice(0, 300).map((a) => {
      const qty = h('input', { type: 'text', inputmode: 'numeric', value: '1', class: 'small-input', 'aria-label': 'Menge' });
      return h(
        'tr',
        { class: a.stock <= a.minStock ? 'low' : '' },
        h('td', { text: a.name }),
        h('td', { class: 'r' + (a.stock < 0 ? ' neg' : ''), text: String(a.stock) }),
        h('td', { class: 'r', text: String(a.minStock) }),
        h('td', {}, qty),
        h('td', {}, btn('Zugang', run(async () => {
          const n = parseInt(qty.value, 10);
          await app.mutate((d) => L.receiveStock(d, { articleId: a.id, qty: n, reason: reason.value.trim() || 'Warenzugang', cashierId: null }));
          toast('Zugang gebucht', 'ok');
        }), 'small'), ' ', btn('Auf Menge setzen', run(async () => {
          const n = parseInt(qty.value, 10);
          await app.mutate((d) => L.correctStock(d, { articleId: a.id, newQty: n, reason: reason.value, cashierId: null }));
          toast('Bestand korrigiert', 'ok');
        }), 'small'))
      );
    });
    const moves = [...s.stockMoves].reverse().slice(0, 150).map((m) => h('tr', {}, h('td', { text: new Date(m.ts).toLocaleString('de-DE') }), h('td', { text: m.articleName }), h('td', { text: m.type }), h('td', { class: 'r', text: (m.qty > 0 ? '+' : '') + m.qty }), h('td', { class: 'r', text: String(m.after) }), h('td', { text: m.ref || m.reason || '' })));
    const nachbestellen = RP.reorderList(s).slice(0, 100).map((x) => h('tr', {}, h('td', { text: x.article.name }), h('td', { class: 'r', text: String(x.article.stock) }), h('td', { class: 'r', text: String(x.article.minStock) }), h('td', { class: 'r', text: String(x.order) })));
    return h(
      'div',
      {},
      section(
        'Lagerbestände',
        h('div', { class: 'toolbar' }, filterSel, field('Grund / Referenz', reason), btn('Inventur (Zählliste)', () => inventoryDialog(), 'primary'), btn('Lager-CSV exportieren', () => download('artikel-lager.csv', RP.articlesCsv(S())))),
        h('div', { class: 'scroll' }, table(['Artikel', { label: 'Bestand', r: true }, { label: 'Min', r: true }, 'Menge', ''], rows))
      ),
      section('Nachbestellhinweise', table(['Artikel', { label: 'Bestand', r: true }, { label: 'Min', r: true }, { label: 'Vorschlag', r: true }], nachbestellen)),
      section('Lagerbewegungen (letzte 150)', h('div', { class: 'scroll' }, table(['Zeit', 'Artikel', 'Art', { label: 'Menge', r: true }, { label: 'Neu', r: true }, 'Referenz / Grund'], moves)))
    );
  }

  function inventoryDialog() {
    const inputs = S().articles.filter((a) => a.active).map((a) => ({ a, input: h('input', { type: 'text', inputmode: 'numeric', value: String(a.stock), class: 'small-input', 'aria-label': `Zählmenge ${a.name}` }) }));
    openModal({
      title: 'Inventur',
      wide: true,
      content: h('div', { class: 'scroll tall' }, h('p', { class: 'hint', text: 'Gezählte Mengen eintragen. Abweichungen werden als Inventurbuchung gespeichert.' }), table(['Artikel', { label: 'Soll', r: true }, { label: 'Gezählt', r: true }], inputs.map((x) => h('tr', {}, h('td', { text: x.a.name }), h('td', { class: 'r', text: String(x.a.stock) }), h('td', { class: 'r' }, x.input))))),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Inventur buchen',
          primary: true,
          run: run(async () => {
            const counts = inputs.map((x) => ({ articleId: x.a.id, qty: parseInt(x.input.value, 10) }));
            let changed = 0;
            await app.mutate((d) => {
              changed = L.inventory(d, { counts, cashierId: null });
            });
            toast(`Inventur gebucht: ${changed} Abweichungen`, 'ok');
          }),
        },
      ],
    });
  }

  // ------------------------------------------------------------ Personal

  function staffView() {
    const s = S();
    const rows = s.staff.map((p) =>
      h('tr', { class: p.active ? '' : 'muted' }, h('td', { class: 'mono', text: p.nr }), h('td', { text: p.name }), h('td', { text: R.ROLE_LABEL[p.role] }), h('td', { text: p.active ? 'aktiv' : 'gesperrt' }), h('td', {}, btn('Bearbeiten', () => staffForm(p), 'small')))
    );
    return h('div', {}, section('Mitarbeiter', h('p', { class: 'hint', text: 'Die PIN ist eine Simulationskennung, keine sichere Authentifizierung. Bitte Standard-PINs nach dem ersten Start ändern.' }), table(['Personalnr.', 'Name', 'Rolle', 'Status', ''], rows), h('div', { class: 'toolbar' }, btn('Neuer Mitarbeiter', () => staffForm(null), 'primary'))));
  }

  function staffForm(p) {
    const v = p || { nr: '', name: '', pin: '', role: 'KASSIERER', active: true };
    const f = {
      nr: h('input', { type: 'text', inputmode: 'numeric', value: v.nr, 'data-autofocus': true }),
      name: h('input', { type: 'text', value: v.name }),
      pin: h('input', { type: 'password', inputmode: 'numeric', value: v.pin, autocomplete: 'off' }),
      role: h('select', {}, Object.keys(R.ROLE_LEVEL).map((r) => h('option', { value: r, text: R.ROLE_LABEL[r], selected: r === v.role }))),
      active: h('input', { type: 'checkbox', checked: v.active }),
    };
    openModal({
      title: p ? `Mitarbeiter · ${p.name}` : 'Neuer Mitarbeiter',
      content: h('div', { class: 'form' }, field('Personalnummer', f.nr), field('Name', f.name), field('PIN (4–8 Ziffern)', f.pin), field('Rolle', f.role), h('label', { class: 'check' }, f.active, ' aktiv')),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Speichern',
          primary: true,
          run: run(async () => {
            const data = { id: p ? p.id : undefined, nr: f.nr.value.trim(), name: f.name.value, pin: f.pin.value, role: f.role.value, active: f.active.checked };
            await app.mutate((d) => {
              if (p && p.role === 'ADMIN' && p.active && (!data.active || data.role !== 'ADMIN') && d.staff.filter((x) => x.role === 'ADMIN' && x.active).length <= 1) {
                throw R.fail('LETZTER_ADMIN', 'Der letzte aktive Administrator kann nicht gesperrt oder herabgestuft werden');
              }
              L.upsertStaff(d, data, {});
            });
            toast('Mitarbeiter gespeichert', 'ok');
          }),
        },
      ],
    });
  }

  // ------------------------------------------------------------ Schichten

  function shiftsView() {
    const s = S();
    const rows = [...s.shifts].reverse().map((sh) => {
      const who = (s.staff.find((x) => x.id === sh.cashierId) || {}).name || sh.cashierId;
      const sum = sh.report || (sh.status === 'OFFEN' ? L.shiftSummary(s, sh) : null);
      return h(
        'tr',
        {},
        h('td', { class: 'mono', text: sh.id }),
        h('td', { text: who }),
        h('td', { text: new Date(sh.openedAt).toLocaleString('de-DE') }),
        h('td', { text: sh.endedAt ? new Date(sh.endedAt).toLocaleString('de-DE') : '–' }),
        h('td', { class: 'r', text: euro(sh.startCents) }),
        h('td', { class: 'r', text: sum ? String(sum.anzahlVerkaeufe) : '–' }),
        h('td', { class: 'r', text: sh.countedCents === null ? '–' : euro(sh.countedCents) }),
        h('td', { class: 'r' + (sh.diffCents ? ' warn' : ''), text: sh.diffCents === null ? '–' : euro(sh.diffCents) }),
        h('td', { text: sh.status }),
        h('td', {}, btn('Bericht', () => shiftDetail(sh), 'small'))
      );
    });
    return h('div', {}, section('Kassenschichten', h('div', { class: 'scroll' }, table(['Schicht', 'Kassierer', 'Beginn', 'Ende', { label: 'Anfang', r: true }, { label: 'Verkäufe', r: true }, { label: 'Ist', r: true }, { label: 'Differenz', r: true }, 'Status', ''], rows))));
  }

  function shiftDetail(sh) {
    const s = S();
    const lines = RP.shiftReportLines(s, sh);
    openModal({
      title: `Schichtbericht ${sh.id}`,
      wide: true,
      content: h('table', { class: 'simple' }, h('tbody', {}, lines.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'r', text: v }))))),
      actions: [{ label: 'Drucken', run: () => { P.print(P.shiftText(lines, s.settings, 'SCHICHTBERICHT'), s.settings); return false; } }, { label: 'Schließen', primary: true }],
    });
  }

  // ------------------------------------------------------------ Transaktionen

  function transactionsView() {
    const s = S();
    const filter = h('input', { type: 'search', placeholder: 'Bon-Nr. oder Typ (Verkauf/Retoure)', value: state.txFilter, 'data-keep': 'txSearch', 'aria-label': 'Transaktionen filtern', oninput: (e) => { state.txFilter = e.target.value; renderBody(); } });
    const q = state.txFilter.trim().toLowerCase();
    const list = [...s.sales].reverse().filter((x) => !q || x.bonNr.toLowerCase().includes(q) || (x.kind === 'RETOURE' ? 'retoure' : 'verkauf').includes(q)).slice(0, 200);
    const rows = list.map((x) => {
      const cashier = (s.staff.find((c) => c.id === x.cashierId) || {}).name || '–';
      return h(
        'tr',
        { class: 'click', onclick: () => saleDetail(x.id) },
        h('td', { class: 'mono', text: x.bonNr }),
        h('td', { text: x.kind === 'RETOURE' ? 'Retoure' : 'Verkauf' }),
        h('td', { text: new Date(x.ts).toLocaleString('de-DE') }),
        h('td', { text: cashier }),
        h('td', { class: 'r', text: plain(x.totals.gesamt) }),
        h('td', { text: x.payments.map((p) => p.type).join(' + ') || '–' }),
        h('td', { text: x.status + (x.training ? ` · Training ${x.training.score}` : '') })
      );
    });
    return h('div', {}, section('Transaktionen (letzte 200)', h('div', { class: 'toolbar' }, filter, btn('Verkäufe CSV-Export', () => download('umsatz.csv', RP.salesCsv(S())))), h('div', { class: 'scroll' }, table(['Bon', 'Typ', 'Zeit', 'Kassierer', { label: 'Betrag €', r: true }, 'Zahlart', 'Status'], rows))));
  }

  function saleDetail(id) {
    const s = S();
    const x = s.sales.find((y) => y.id === id);
    if (!x) return;
    const actions = [{ label: 'Drucken', run: () => { P.print(P.receiptText(P.saleFromRecord(x, s), s.settings), s.settings); return false; } }];
    if (x.kind === 'VERKAUF' && x.status !== 'RETOURIERT') actions.push({ label: 'Retoure erfassen', run: () => { returnDialog(x); return false; } });
    actions.push({ label: 'Schließen', primary: true });
    openModal({
      title: `${x.kind === 'RETOURE' ? 'Retoure' : 'Verkauf'} ${x.bonNr}`,
      wide: true,
      content: h(
        'div',
        {},
        h('p', { text: `${new Date(x.ts).toLocaleString('de-DE')} · Status ${x.status}${x.reason ? ' · ' + x.reason : ''}` }),
        table(['Artikel', { label: 'Menge', r: true }, { label: 'Betrag €', r: true }], x.lines.map((l) => h('tr', {}, h('td', { text: l.name || l.label || l.voucherCode }), h('td', { class: 'r', text: l.qty !== undefined ? String(l.qty) : '' }), h('td', { class: 'r', text: plain(l.kind === 'ART' && l.unitCents !== undefined ? R.lineGrossCents(l) : l.cents) })))),
        h('p', { class: 'hint', text: 'Zahlungen: ' + x.payments.map((p) => `${p.type} ${plain(p.cents)} €`).join(' · ') })
      ),
      actions,
    });
  }

  function returnDialog(sale) {
    const s = S();
    const rowsDef = sale.lines.filter((l) => l.kind === 'ART').map((l) => {
      const avail = l.qty - (l.returnedQty || 0);
      const inp = h('input', { type: 'text', inputmode: 'numeric', value: '0', class: 'small-input', 'aria-label': `Retourenmenge ${l.name}` });
      return { l, avail, inp };
    });
    const restock = h('input', { type: 'checkbox', checked: true });
    const method = h('select', {}, h('option', { value: 'BAR', text: 'bar auszahlen' }), h('option', { value: 'KARTE', text: 'auf Karte erstatten (Simulation)' }));
    const reason = h('input', { type: 'text', placeholder: 'Grund (Pflicht)' });
    openModal({
      title: `Retoure zu ${sale.bonNr}`,
      wide: true,
      content: h(
        'div',
        { class: 'form' },
        table(['Artikel', { label: 'verfügbar', r: true }, { label: 'zurück', r: true }], rowsDef.filter((x) => x.avail > 0).map((x) => h('tr', {}, h('td', { text: x.l.name }), h('td', { class: 'r', text: String(x.avail) }), h('td', { class: 'r' }, x.inp)))),
        h('label', { class: 'check' }, restock, ' wieder in den Bestand buchen (Ware unbeschädigt)'),
        field('Erstattung', method),
        field('Grund', reason),
        h('p', { class: 'hint', text: 'Retouren benötigen eine Freigabe durch die Schichtleitung.' })
      ),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Freigeben und erstatten',
          primary: true,
          run: run(async () => {
            const approver = await requestApproval('SCHICHTLEITUNG', `Retoure zu ${sale.bonNr}`);
            if (!approver) return false;
            const items = rowsDef.map((x) => ({ lineId: x.l.id, qty: parseInt(x.inp.value, 10) || 0 })).filter((i) => i.qty > 0);
            if (!L.currentShift(s)) throw R.fail('SCHICHT_NICHT_OFFEN', 'Retouren nur in einer offenen Schicht');
            await app.mutate((d) => L.returnSale(d, { bonNr: sale.bonNr, items, restock: restock.checked, refund: method.value, approverId: approver, cashierId: app.user.id, reason: reason.value }));
            toast('Retoure gebucht', 'ok');
          }),
        },
      ],
    });
  }

  // ------------------------------------------------------------ Berichte

  function reportsView() {
    const s = S();
    const trainingRows = [...s.trainingResults].reverse().slice(0, 200).map((t) => h('tr', {}, h('td', { text: new Date(t.ts).toLocaleString('de-DE') }), h('td', { text: t.customer }), h('td', { text: POS.Training.DIFFICULTY[t.difficulty].label }), h('td', { class: 'r', text: `${t.score}` }), h('td', { text: t.fehler.join(' · ') || 'alles korrekt' })));
    const avg = s.trainingResults.length ? Math.round(s.trainingResults.reduce((a, t) => a + t.score, 0) / s.trainingResults.length) : null;
    const events = [...s.events].reverse().slice(0, 200).map((e) => h('tr', {}, h('td', { text: new Date(e.ts).toLocaleString('de-DE') }), h('td', { class: 'mono', text: e.type }), h('td', { text: e.text })));
    return h(
      'div',
      {},
      section('Exporte', h('div', { class: 'toolbar' }, btn('Umsatz (CSV)', () => download('umsatz.csv', RP.salesCsv(S()))), btn('Artikel (CSV)', () => download('artikel.csv', RP.articlesCsv(S()))), btn('Protokoll (CSV)', () => download('protokoll.csv', RP.toCsv([['Zeit', 'Typ', 'Text'], ...s.events.map((e) => [e.ts, e.type, e.text])]))))),
      section(
        'Training',
        h('p', { text: avg === null ? 'Noch keine Trainingsergebnisse.' : `Durchschnitt ${avg} von 100 Punkten aus ${s.trainingResults.length} Kunden.` }),
        h('div', { class: 'scroll' }, table(['Zeit', 'Kunde', 'Stufe', { label: 'Punkte', r: true }, 'Fehler'], trainingRows))
      ),
      section('Ereignisprotokoll (letzte 200)', h('div', { class: 'scroll' }, table(['Zeit', 'Typ', 'Vorgang'], events)))
    );
  }

  // ------------------------------------------------------------ Drucker

  function printerView() {
    const s = S();
    const width = h('select', { 'aria-label': 'Papierbreite' }, h('option', { value: '80', text: '80 mm (Standard)', selected: s.settings.paperWidth === 80 }), h('option', { value: '58', text: '58 mm', selected: s.settings.paperWidth === 58 }));
    const auto = h('input', { type: 'checkbox', checked: s.settings.autoPrint });
    const market = h('input', { type: 'text', value: s.settings.marketName });
    const addr = h('input', { type: 'text', value: s.settings.marketAddress });
    const kasse = h('input', { type: 'text', value: s.settings.kassenNr });
    return h(
      'div',
      {},
      section(
        'Bondrucker (Browserdruck)',
        h('p', { class: 'hint', text: P.status() + '. Der Drucker wird über den Druckdialog des Browsers angesprochen. Eine Hardwareprüfung gilt erst als bestanden, wenn der Testbon physisch geprüft wurde.' }),
        h('div', { class: 'form grid2' }, field('Papierbreite', width), h('label', { class: 'check' }, auto, ' Druckdialog nach erfolgreicher Zahlung automatisch öffnen'), field('Marktname (fiktiv)', market), field('Anschrift (fiktiv)', addr), field('Kassennummer', kasse)),
        h('div', { class: 'toolbar' }, btn('Einstellungen speichern', run(async () => {
          await app.mutate((d) => {
            Object.assign(d.settings, { paperWidth: parseInt(width.value, 10), autoPrint: auto.checked, marketName: market.value.trim(), marketAddress: addr.value.trim(), kassenNr: kasse.value.trim() });
          });
          toast('Druckereinstellungen gespeichert', 'ok');
        }), 'primary'), btn('Testbon drucken', () => POS.Printer.print(P.testText(S().settings), S().settings), ''), btn('Beispielbon anzeigen', () => sampleBon()))
      ),
      section('ESC/POS-Anbindung', h('p', { text: 'Nicht implementiert. Vorbereitet ist die Trennung in js/hw/printer.js (Bonaufbau als Text). Ein späterer Druckertreiber für ESC/POS würde nur die Funktion print() ersetzen. Die Anwendung bleibt ohne lokalen Dienst lauffähig.' }))
    );
  }

  function sampleBon() {
    const s = S();
    const sample = [...s.sales].reverse().find((x) => x.kind === 'VERKAUF');
    const text = sample ? P.receiptText(P.saleFromRecord(sample, s), s.settings) : P.testText(s.settings);
    openModal({ title: sample ? `Bonvorschau ${sample.bonNr}` : 'Bonvorschau (Testbon)', wide: true, content: h('pre', { class: 'receipt-preview', text }), actions: [{ label: 'Schließen', primary: true }] });
  }

  // ------------------------------------------------------------ Scanner

  function scannerView() {
    const s = S();
    const suffix = h('select', { 'aria-label': 'Scanner-Suffix' }, h('option', { value: 'Enter', text: 'Enter (Standard)', selected: s.settings.scannerSuffix === 'Enter' }), h('option', { value: 'Tab', text: 'Tab', selected: s.settings.scannerSuffix === 'Tab' }));
    const minLen = h('input', { type: 'text', inputmode: 'numeric', value: String(s.settings.scannerMinLen), class: 'small-input' });
    const maxAvg = h('input', { type: 'text', inputmode: 'numeric', value: String(s.settings.scannerMaxAvgMs), class: 'small-input' });
    return h(
      'div',
      {},
      section(
        'USB-Barcodescanner (HID-Tastaturmodus)',
        h('p', { class: 'hint', text: `Status: ${s.settings.scannerVerified ? 'mit Assistent geprüft' : 'NICHT geprüft'}. Erkennung über den Zeichenabstand (Heuristik, siehe README).` }),
        h('div', { class: 'form grid2' }, field('Abschlusszeichen', suffix), field('Mindestlänge (Zeichen)', minLen), field('Max. mittlerer Zeichenabstand (ms)', maxAvg)),
        h('div', { class: 'toolbar' }, btn('Einstellungen speichern', run(async () => {
          const ml = parseInt(minLen.value, 10);
          const ma = parseInt(maxAvg.value, 10);
          if (!(ml >= 4 && ml <= 20)) throw R.fail('STAMM_UNGUELTIG', 'Mindestlänge 4 bis 20');
          if (!(ma >= 5 && ma <= 300)) throw R.fail('STAMM_UNGUELTIG', 'Zeichenabstand 5 bis 300 ms');
          await app.mutate((d) => Object.assign(d.settings, { scannerSuffix: suffix.value, scannerMinLen: ml, scannerMaxAvgMs: ma }));
          toast('Scannereinstellungen gespeichert', 'ok');
        }), 'primary'), btn('Scanner-Assistent starten', () => scannerWizard(), 'primary'))
      )
    );
  }

  function scannerWizard() {
    const s = S();
    const input = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Testbarcode hier scannen', 'data-autofocus': true, 'data-allow-scan': true, 'aria-label': 'Testbarcode' });
    const out = h('div', { class: 'wizard-out' }, h('p', { text: 'Schritt 1: Bitte einen beliebigen Barcode mit dem Scanner scannen. Das Feld ist für den Test freigegeben.' }));
    let times = [];
    let result = null;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const code = input.value;
        const info = POS.Scanner.classify(times, { scannerMinLen: 1, scannerMaxAvgMs: Infinity });
        const fast = POS.Scanner.classify(times, s.settings);
        const digits = /^\d+$/.test(code);
        const valid = digits && (code.length === 8 || code.length === 13) ? POS.Ean.isValid(code) : null;
        const checks = [
          ['Zeichen erkannt', String(code.length)],
          ['Mittlerer Zeichenabstand', info.avgMs === null ? 'nur ein Zeichen' : `${info.avgMs} ms`],
          ['Abschlusszeichen', e.key === 'Tab' ? 'Tab' : 'Enter'],
          ['Eingabe', fast.source === 'SCANNER' && code.length >= s.settings.scannerMinLen ? 'Scanner (schnell)' : 'manuell (langsam)'],
          ['Prüfziffer EAN', valid === null ? 'nicht zutreffend' : valid ? 'gültig' : 'ungültig'],
        ];
        const passed = fast.source === 'SCANNER' && code.length >= s.settings.scannerMinLen && valid !== false && code.length > 0;
        result = { passed, suffix: e.key === 'Tab' ? 'Tab' : 'Enter', minLen: code.length, avg: info.avgMs };
        out.replaceChildren(
          h('table', { class: 'simple' }, h('tbody', {}, checks.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'r', text: v }))))),
          h('p', { class: passed ? 'ok-text' : 'bad-text', text: passed ? 'Test bestanden: Scanner erkannt. Einstellung kann gespeichert werden.' : 'Test nicht bestanden. Bitte mit dem angeschlossenen Scanner wiederholen. Manuelle Eingaben gelten nicht als Scannertest.' })
        );
        input.value = '';
        times = [];
        return;
      }
      if (e.key.length === 1) times = POS.Scanner.pushTime(times, performance.now());
    });
    openModal({
      title: 'Scanner-Einrichtungsassistent',
      wide: true,
      content: h('div', { class: 'wizard' }, h('p', { text: 'Dieser Test prüft die Eingabe, nicht den Scanner selbst. Ohne angeschlossenen Scanner schlägt er fehl.' }), input, out),
      actions: [
        { label: 'Schließen' },
        {
          label: 'Als Scanner-Einstellung speichern',
          primary: true,
          run: run(async () => {
            if (!result || !result.passed) throw R.fail('SCANNER_TEST', 'Der Test ist noch nicht bestanden');
            await app.mutate((d) => {
              d.settings.scannerSuffix = result.suffix;
              d.settings.scannerMinLen = Math.min(result.minLen, d.settings.scannerMinLen);
              d.settings.scannerVerified = true;
              L.logEvent(d, { type: 'SCANNER_TEST', text: `Scanner-Test bestanden (Suffix ${result.suffix})` });
            });
            toast('Scanner-Einstellung gespeichert', 'ok');
          }),
        },
      ],
    });
    setTimeout(() => input.focus(), 0);
  }

  // ------------------------------------------------------------ Tastatur

  function keymapView() {
    const s = S();
    const rows = Object.keys(s.settings.keymap).map((action) => {
      const keyCell = h('span', { class: 'mono key', text: s.settings.keymap[action] });
      return h('tr', {}, h('td', { text: actionTitle(action) }), h('td', {}, keyCell), h('td', {}, btn('Ändern', () => captureKey(action), 'small')));
    });
    return h(
      'div',
      {},
      section(
        'Tastaturbelegung',
        h('p', { class: 'hint', text: 'Taste wählen, dann die neue Taste drücken. Belegte Tasten werden getauscht. Esc bricht ab. Browser- und Systemtasten (z. B. Strg+R, F12) lassen sich nicht zuverlässig abfangen.' }),
        table(['Funktion', 'Taste', ''], rows),
        h('div', { class: 'toolbar' }, btn('Standardbelegung wiederherstellen', run(async () => {
          if (!(await confirmDialog('Standardbelegung', 'Alle Tasten auf die Standardbelegung zurücksetzen?', 'Zurücksetzen', true))) return;
          await app.mutate((d) => {
            d.settings.keymap = POS.Seed.defaultSettings().keymap;
          });
          toast('Standardbelegung wiederhergestellt', 'ok');
        }), 'danger'))
      )
    );
  }

  function actionTitle(a) {
    const titles = { SUCHE: 'Artikelsuche', MENGE: 'Menge ändern', PREIS: 'Preisabfrage', POS_STORNO: 'Position stornieren', LEERGUT: 'Leergut', ZWISCHENSUMME: 'Zwischensumme', BAR: 'Barzahlung', KARTE: 'Kartenzahlung', BON_DRUCKEN: 'Bon drucken', KASSIERERWECHSEL: 'Kassiererwechsel', VOLLBILD: 'Browser-Vollbild', BON_STORNO: 'Bon stornieren', KASSENLADE: 'Kassenlade', SCHICHTENDE: 'Schichtende', ESC: 'Dialog schließen / abbrechen' };
    return titles[a] || a;
  }

  function captureKey(action) {
    let entry = null;
    const listener = async (e) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', listener, true);
      if (e.key === 'Escape' && !e.shiftKey) {
        entry.close();
        return;
      }
      const combo = (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key;
      if (e.key.length === 1 && (e.ctrlKey || e.altKey)) {
        toast('Bitte eine Funktionstaste oder Sondertaste wählen', 'warn');
      }
      entry.close();
      try {
        await app.mutate((d) => {
          const map = d.settings.keymap;
          const other = Object.keys(map).find((k) => map[k] === combo && k !== action);
          if (other) map[other] = map[action];
          map[action] = combo;
        });
        toast(`${actionTitle(action)}: ${combo}`, 'ok');
      } catch (err) {
        errorToast(err);
      }
    };
    entry = openModal({
      title: 'Taste zuweisen',
      content: h('p', { text: `Neue Taste für „${actionTitle(action)}“ drücken …` }),
      actions: [{ label: 'Abbrechen' }],
      onClose: () => window.removeEventListener('keydown', listener, true),
    });
    window.addEventListener('keydown', listener, true);
  }

  // ------------------------------------------------------------ Sicherung

  function backupView() {
    const s = S();
    const restore = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Sicherungsdatei wählen', onchange: (e) => restoreBackup(e.target.files[0]) });
    return h(
      'div',
      {},
      section(
        'Gesamtsicherung',
        h('p', { class: 'hint', text: `Letzte Sicherung: ${s.settings.lastBackupAt ? new Date(s.settings.lastBackupAt).toLocaleString('de-DE') : 'noch keine'} · Speicher: ${POS.Store.mode === 'indexeddb' ? 'IndexedDB' : POS.Store.mode}` }),
        h('div', { class: 'toolbar' }, btn('Sicherung erstellen (JSON)', run(async () => {
          const text = POS.Store.exportBackup(S());
          const how = await shareOrDownload(`getraenkemarkt-pos-sicherung-${stamp()}.json`, text, 'application/json');
          if (how === 'abgebrochen') return;
          await app.mutate((d) => {
            d.settings.lastBackupAt = new Date().toISOString();
            d.settings.salesSinceBackup = 0;
          });
          toast(how === 'geteilt' ? 'Sicherung geteilt. Im Teilen-Menü „In Dateien sichern“ wählen.' : 'Sicherung gespeichert', 'ok');
        }), 'primary')),
        h('p', { class: 'hint', text: 'Auf dem iPad: Im Teilen-Menü „In Dateien sichern“ wählen, damit die Datei außerhalb der App liegt.' }),
        field('JSON-Wiederherstellung (ersetzt alle Daten)', restore)
      ),
      section(
        'Exporte',
        h('div', { class: 'toolbar' }, btn('Umsatz-CSV', () => download('umsatz.csv', RP.salesCsv(S()))), btn('Artikel-CSV', () => download('artikel.csv', RP.articlesCsv(S()))))
      ),
      section(
        'Zurücksetzen',
        h('p', { class: 'hint', text: 'Trainingsdaten löschen oder den gesamten Werksstand herstellen. Vorher Sicherung herunterladen.' }),
        h('div', { class: 'toolbar' }, btn('Trainingsdaten zurücksetzen', run(async () => {
          if (!(await confirmDialog('Trainingsdaten', 'Alle Trainingsergebnisse und den wartenden Trainingskunden löschen?', 'Löschen', true))) return;
          await app.mutate((d) => {
            d.trainingResults = [];
            d.trainingCustomer = null;
          });
          toast('Trainingsdaten zurückgesetzt', 'ok');
        }), 'danger'), btn('Werksreset …', () => factoryReset(), 'danger'))
      )
    );
  }

  async function restoreBackup(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const next = POS.Store.parseBackup(text);
      const ok = await confirmDialog('Wiederherstellung', `Aktuelle Daten werden durch den Stand aus „${file.name}“ ersetzt (${next.sales.length} Verkäufe, ${next.articles.length} Artikel). Fortfahren?`, 'Wiederherstellen', true);
      if (!ok) return;
      await POS.Store.save(next);
      app.S = next;
      app.render();
      toast('Datensicherung wiederhergestellt', 'ok');
    } catch (err) {
      errorToast(err);
    }
  }

  function factoryReset() {
    const word = h('input', { type: 'text', placeholder: 'LÖSCHEN eingeben', 'aria-label': 'Bestätigungswort' });
    openModal({
      title: 'Werksreset',
      content: h('div', { class: 'form' }, h('p', { class: 'warn-text', text: 'Alle Verkäufe, Schichten, Bestände, Mitarbeiter und Einstellungen werden gelöscht und durch den Werksstand ersetzt. Das lässt sich nicht rückgängig machen.' }), field('Zur Bestätigung „LÖSCHEN“ eingeben', word)),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Werksreset ausführen',
          danger: true,
          run: run(async () => {
            if (word.value.trim() !== 'LÖSCHEN') throw R.fail('BESTAETIGUNG', 'Bestätigungswort stimmt nicht');
            const fresh = POS.Seed.createInitialState();
            await POS.Store.save(fresh);
            app.S = fresh;
            app.user = null;
            app.showLogin('Werksreset durchgeführt. Bitte neu anmelden.');
          }),
        },
      ],
    });
  }

  // ------------------------------------------------------------ Simulation

  function simView() {
    const s = S();
    const reject = h('input', { type: 'range', min: '0', max: '50', step: '1', value: String(Math.round(s.settings.cardRejectRate * 100)), 'aria-label': 'Ablehnungsquote' });
    const rejectOut = h('span', { text: `${Math.round(s.settings.cardRejectRate * 100)} %` });
    reject.addEventListener('input', () => (rejectOut.textContent = reject.value + ' %'));
    const soundOn = h('input', { type: 'checkbox', checked: s.settings.soundOn });
    const keys = h('input', { type: 'checkbox', checked: s.settings.soundKeys });
    const vol = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(s.settings.soundVolume * 100)), 'aria-label': 'Lautstärke' });
    const training = h('input', { type: 'checkbox', checked: s.settings.trainingMode });
    const diff = h('select', {}, Object.entries(POS.Training.DIFFICULTY).map(([k, v]) => h('option', { value: k, text: v.label, selected: k === s.settings.trainingDifficulty })));
    const favs = s.settings.favorites.slice(0, 12);
    const favSelects = Array.from({ length: 12 }, (_, i) =>
      h('select', { 'aria-label': `Schnelltaste ${i + 1}` }, h('option', { value: '', text: '– leer –' }), s.articles.map((a) => h('option', { value: a.id, text: a.name, selected: a.id === favs[i] })))
    );
    const testSound = (name) => () => POS.Sound.play(name, { force: true });
    const display = h(
      'select',
      { 'aria-label': 'Darstellung' },
      [['auto', 'Automatisch (nach Bildschirmgröße)'], ['kompakt', 'Kompakt (kleines iPad)'], ['standard', 'Standard (großer Bildschirm)']].map(([v, t]) =>
        h('option', { value: v, text: t, selected: (s.settings.displayMode || 'auto') === v })
      )
    );
    return h(
      'div',
      {},
      section(
        'Simulation und Training',
        h('div', { class: 'form grid2' }, field('Kartenablehnung (Simulation)', h('span', { class: 'range-row' }, reject, rejectOut)), h('label', { class: 'check' }, training, ' Trainingsmodus aktiv'), field('Trainingsstufe', diff)),
        h('p', { class: 'hint', text: 'Ohne Trainingsmodus funktioniert die Kasse ohne Aufgaben.' })
      ),
      section(
        'Darstellung',
        h('div', { class: 'form' }, field('Layout der Kasse', display), h('p', { class: 'hint', text: 'Automatisch wählt das Layout nach der verfügbaren Bildschirmgröße. Kompakt spart Platz auf kleinen iPads, Standard nutzt große Bildschirme voll aus. Die Touchflächen bleiben in beiden Varianten groß.' }))
      ),
      section(
        'Akustik',
        h('div', { class: 'form grid2' }, h('label', { class: 'check' }, soundOn, ' Sounds aktiv'), h('label', { class: 'check' }, keys, ' Tastendruck-Ton'), field('Lautstärke', vol)),
        h('div', { class: 'toolbar' }, ...['scan', 'unknown', 'key', 'error', 'paid', 'declined', 'drawer'].map((n) => btn(`Test: ${n}`, testSound(n), 'small')))
      ),
      section(
        'Schnelltasten (Bedienfeld)',
        h('div', { class: 'fav-edit' }, favSelects.map((sel, i) => field(`Taste ${i + 1}`, sel)))
      ),
      h('div', { class: 'toolbar' }, btn('Simulationseinstellungen speichern', run(async () => {
        const rate = parseInt(reject.value, 10) / 100;
        const favorites = favSelects.map((x) => x.value).filter(Boolean);
        await app.mutate((d) => {
          Object.assign(d.settings, { displayMode: display.value, cardRejectRate: rate, soundOn: soundOn.checked, soundKeys: keys.checked, soundVolume: parseInt(vol.value, 10) / 100, trainingMode: training.checked, trainingDifficulty: diff.value, favorites });
        });
        toast('Gespeichert', 'ok');
      }), 'primary'))
    );
  }

  // ------------------------------------------------------------ Tankstelle

  function tankstelleView() {
    const s = S();
    const F = POS.Fuel;
    const fuelRows = s.fuels.map((f) => {
      const price = money(F.formatMilli(f.priceMilli));
      const liters = h('input', { type: 'text', inputmode: 'decimal', value: '', placeholder: 'Liter', class: 'small-input', 'aria-label': `Tankzug ${f.name}` });
      return h(
        'tr',
        { class: f.stockMl <= f.minMl ? 'low' : '' },
        h('td', { text: f.name }),
        h('td', { class: 'r' }, price, ' €/l'),
        h('td', { class: 'r', text: f.vat + ' %' }),
        h('td', { class: 'r' + (f.stockMl <= 0 ? ' neg' : ''), text: F.formatMl(f.stockMl) }),
        h('td', { class: 'r', text: F.formatMl(f.minMl) }),
        h('td', {}, liters, ' ', btn('Tankzug buchen', run(async () => {
          const ml = F.parseMl(liters.value);
          if (!ml) throw R.fail('MENGE_UNGUELTIG', 'Liter ungültig (z. B. 5000 oder 5000,5)');
          await app.mutate((d) => {
            const fuel = d.fuels.find((x) => x.id === f.id);
            fuel.stockMl += ml;
            L.logEvent(d, { type: 'TANKZUG', text: `Tankzug ${fuel.name}: +${F.formatMl(ml)}`, cashierId: app.user.id });
          });
          liters.value = '';
          toast('Tankzug gebucht', 'ok');
        }), 'small')),
        h('td', {}, btn('Preis speichern', run(async () => {
          const v = F.parsePriceMilli(price.value);
          if (!v) throw R.fail('BETRAG_UNGUELTIG', 'Literpreis ungültig (z. B. 1,759)');
          await app.mutate((d) => {
            const fuel = d.fuels.find((x) => x.id === f.id);
            const before = fuel.priceMilli;
            fuel.priceMilli = v;
            if (before !== v) L.logEvent(d, { type: 'KRAFTSTOFFPREIS', text: `${fuel.name}: ${F.formatPricePerLiter(before)} → ${F.formatPricePerLiter(v)}`, cashierId: app.user.id });
          });
          toast('Literpreis gespeichert (laufende Tankvorgänge behalten ihren Preis)', 'ok');
        }), 'small'))
      );
    });

    const pumpRows = s.pumps.map((p) => {
      const sel = h('select', { 'aria-label': `Kraftstoff ${p.name}` }, s.fuels.map((f) => h('option', { value: f.id, text: f.name, selected: f.id === p.fuelId })));
      return h(
        'tr',
        {},
        h('td', { text: p.name }),
        h('td', { text: POS.Pumps.LABEL[p.status] || p.status }),
        h('td', {}, sel),
        h('td', {}, btn('Zuordnung speichern', run(async () => {
          if (p.status !== 'FREI' && p.status !== 'GESPERRT') throw R.fail('ZAPFSAEULE_AKTIV', 'Zuordnung nur bei freier oder gesperrter Zapfsäule');
          await app.mutate((d) => {
            const pump = d.pumps.find((x) => x.id === p.id);
            pump.fuelId = sel.value;
            L.logEvent(d, { type: 'ZAPFSAEULE_KONFIG', text: `${pump.name}: Kraftstoff ${POS.Pumps.fuelOf(d, sel.value).name}`, cashierId: app.user.id });
          });
          toast('Zuordnung gespeichert', 'ok');
        }), 'small'))
      );
    });

    const auto = h('input', { type: 'checkbox', checked: s.settings.fuelAuto });
    const arrivals = h('input', { type: 'text', inputmode: 'numeric', value: String(s.settings.fuelArrivalPerMin), class: 'small-input', 'aria-label': 'Kunden pro Minute' });
    const faults = h('input', { type: 'text', inputmode: 'numeric', value: String(s.settings.fuelFaultPerHour), class: 'small-input', 'aria-label': 'Störungen pro Stunde' });

    const tankRows = [...s.tanks].reverse().slice(0, 200).map((t) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono', text: t.id }),
        h('td', { text: 'Zapfsäule ' + t.pumpId }),
        h('td', { text: t.fuelName }),
        h('td', { text: new Date(t.startedAt).toLocaleString('de-DE') }),
        h('td', { class: 'r', text: t.mlFinal === null ? '–' : F.formatMl(t.mlFinal) }),
        h('td', { class: 'r', text: F.formatMilli(t.priceMilli) }),
        h('td', { class: 'r', text: euro(t.amountCents || 0) }),
        h('td', { text: t.status }),
        h('td', { class: 'mono', text: t.bonNr || (t.cartId ? 'im Bon' : '–') })
      )
    );

    return h(
      'div',
      {},
      section(
        'Kraftstoffe, Literpreise und Tankinhalt',
        h('p', { class: 'hint', text: 'Literpreise mit drei Nachkommastellen (z. B. 1,759). Tankzug in Litern (z. B. 5000 oder 5000,5). Laufende Tankvorgänge behalten ihren Preis.' }),
        h('div', { class: 'scroll' }, table(['Kraftstoff', { label: 'Literpreis', r: true }, { label: 'MwSt.', r: true }, { label: 'Tankinhalt', r: true }, { label: 'Mindestbestand', r: true }, 'Tankzug', 'Preis'], fuelRows))
      ),
      section('Zapfsäulen-Zuordnung', h('div', { class: 'scroll' }, table(['Zapfsäule', 'Status', 'Kraftstoff', ''], pumpRows))),
      section(
        'Automatik und Simulation',
        h('div', { class: 'form grid2' }, h('label', { class: 'check' }, auto, ' Automatikmodus (Kunden kommen selbstständig)'), field('Kunden pro Minute (bei Automatik)', arrivals), field('Zufallsstörungen pro Stunde (Simulation)', faults)),
        h('div', { class: 'toolbar' }, btn('Einstellungen speichern', run(async () => {
          const perMin = parseInt(arrivals.value, 10);
          const perHour = parseInt(faults.value, 10);
          if (!(perMin >= 0 && perMin <= 30)) throw R.fail('STAMM_UNGUELTIG', 'Kunden pro Minute: 0 bis 30');
          if (!(perHour >= 0 && perHour <= 60)) throw R.fail('STAMM_UNGUELTIG', 'Störungen pro Stunde: 0 bis 60');
          await app.mutate((d) => Object.assign(d.settings, { fuelAuto: auto.checked, fuelArrivalPerMin: perMin, fuelFaultPerHour: perHour }));
          toast('Gespeichert', 'ok');
        }), 'primary'))
      ),
      section(
        'Tankvorgänge (letzte 200)',
        h('div', { class: 'scroll' }, table(['Vorgang', 'Zapfsäule', 'Kraftstoff', 'Start', { label: 'Liter', r: true }, { label: 'Preis €/l', r: true }, { label: 'Betrag', r: true }, 'Status', 'Bon'], tankRows))
      )
    );
  }

  // ------------------------------------------------------------ Systeminfo und Offline

  function systemInfoView() {
    const st = POS.Pwa.state;
    const resultBox = h('div', { class: 'checks' });
    const renderResult = (r) => {
      if (!r) {
        resultBox.replaceChildren(h('p', { class: 'hint', text: 'Noch nicht geprüft.' }));
        return;
      }
      resultBox.replaceChildren(
        h('div', { class: 'big-change ' + (r.ready ? 'ok' : 'bad'), text: r.ready ? 'Offline bereit' : 'Noch nicht offline bereit' }),
        h('table', { class: 'simple' }, h('tbody', {}, r.checks.map((c) => h('tr', {}, h('td', { text: (c.ok ? '✔ ' : c.required ? '✘ ' : '– ') + c.label }), h('td', { class: 'r hint', text: c.detail })))))
      );
    };
    renderResult(st.lastResult);
    const lastReady = POS.Pwa.lastReadyTime();
    return h(
      'div',
      {},
      section(
        'Offline-Betrieb',
        h('p', { text: st.supported ? 'Service Worker aktiv. Die App-Dateien liegen auf diesem Gerät.' : st.reason || 'Service Worker nicht aktiv.' }),
        h('p', { class: 'hint', text: lastReady ? `Zuletzt erfolgreich geprüft: ${new Date(lastReady).toLocaleString('de-DE')}` : 'Noch keine erfolgreiche Prüfung gespeichert.' }),
        h('div', { class: 'toolbar' }, btn('Offline-Selbsttest starten', run(async () => {
          const r = await POS.Pwa.selfTest();
          renderResult(r);
          app.render();
          toast(r.ready ? 'Offline bereit' : 'Nicht alle Pflichtprüfungen bestanden', r.ready ? 'ok' : 'warn');
        }), 'primary')),
        resultBox
      ),
      section(
        'Speicher',
        h('p', { text: `Speicherort: ${POS.Store.mode === 'indexeddb' ? 'IndexedDB auf diesem Gerät' : POS.Store.mode === 'localstorage' ? 'localStorage (Ausweichlösung)' : 'nur Arbeitsspeicher (Daten gehen beim Schließen verloren)'}` }),
        h('p', { text: st.persisted === true ? 'Dauerhafte Speicherung: von iPadOS bestätigt.' : 'Dauerhafte Speicherung: nicht bestätigt. iPadOS kann Browserdaten unter Speicherdruck löschen. Deshalb regelmäßig sichern (siehe Datensicherung).' })
      ),
      section(
        'Aktualisierung',
        h('p', { class: 'hint', text: 'Updates werden erst auf Bestätigung übernommen und nie mitten in einem Tankvorgang ohne Hinweis.' }),
        h('p', { text: `Version der Offline-Dateien: ${st.version || 'wird nach dem Selbsttest angezeigt'}` })
      )
    );
  }

  // ------------------------------------------------------------ Gerüst

  const VIEWS = {
    dashboard: dashboardView,
    artikel: articlesView,
    preise: pricesView,
    tankstelle: tankstelleView,
    kategorien: categoriesView,
    pfand: depositView,
    lager: stockView,
    personal: staffView,
    schichten: shiftsView,
    transaktionen: transactionsView,
    berichte: reportsView,
    drucker: printerView,
    scanner: scannerView,
    tasten: keymapView,
    sicherung: backupView,
    simulation: simView,
    automat: () => POS.AutomatView.adminView(),
    systeminfo: systemInfoView,
  };

  /** Inhalt neu aufbauen. Suchfelder mit data-keep behalten Fokus und Cursor. */
  function renderBody() {
    const body = host.querySelector('.admin-body');
    if (!body) return;
    const active = document.activeElement;
    const keep = active && active.dataset ? active.dataset.keep : undefined;
    const caret = keep ? active.selectionStart : null;
    body.replaceChildren(VIEWS[current]());
    if (keep) {
      const el = body.querySelector(`[data-keep="${keep}"]`);
      if (el) {
        el.focus();
        if (caret !== null) el.setSelectionRange(caret, caret);
      }
    }
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.section === current));
  }

  function render() {
    renderBody();
  }

  function init(application) {
    app = application;
    host = document.getElementById('view-admin');
    nav = h(
      'nav',
      { class: 'admin-nav', 'aria-label': 'Verwaltungsbereiche' },
      SECTIONS.map(([key, label]) =>
        key === '__' ? h('div', { class: 'nav-group', text: label }) : h('button', { type: 'button', 'data-section': key, onclick: () => { current = key; renderBody(); }, text: label })
      )
    );
    host.replaceChildren(h('div', { class: 'admin-wrap' }, nav, h('div', { class: 'admin-body' })));
  }

  function show() {
    renderBody();
  }

  /** Bereich direkt öffnen (z. B. aus dem Shop). */
  function goto(key) {
    current = key;
    renderBody();
  }

  function isVisible() {
    return !!host && !host.hidden;
  }

  POS.Admin = { init, show, render, isVisible, goto };
})(typeof window !== 'undefined' ? window : globalThis);
