/**
 * Hauptansicht der Kasse: Bonanzeige, Bedienfeld, Statusleiste, Funktionstasten, Kassierdialoge.
 * Alle Zustandsaenderungen laufen ueber POS.App.mutate() und damit ueber die Transaktionslogik.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast, confirmDialog, requestApproval } = POS.Ui;
  const R = POS.Rules;
  const M = POS.Money;
  const C = POS.Cart;
  const L = POS.Ledger;
  const P = POS.Printer;

  const app = () => POS.App;
  const S = () => POS.App.S;

  // Funktionstasten der Kassiererfunktionen (Reihenfolge wie im Pflichtenheft)
  const BOTTOM_BAR = [
    ['BON_STORNO', 'BON STORNO'],
    ['POS_STORNO', 'POSITION STORNO'],
    ['MENGE', 'MENGE'],
    ['PREIS', 'PREISABFRAGE'],
    ['LEERGUT', 'LEERGUT'],
    ['ZWISCHENSUMME', 'ZWISCHENSUMME'],
    ['BAR', 'BAR'],
    ['KARTE', 'KARTE'],
    ['KASSENLADE', 'KASSENLADE'],
    ['BON_DRUCKEN', 'BON DRUCKEN'],
    ['KASSIERERWECHSEL', 'KASSIERERWECHSEL'],
    ['SCHICHTENDE', 'SCHICHTENDE'],
  ];

  const ACTION_LABEL = {
    SUCHE: 'Artikelsuche',
    MENGE: 'Menge ändern',
    PREIS: 'Preisabfrage',
    POS_STORNO: 'Position stornieren',
    LEERGUT: 'Leergut',
    ZWISCHENSUMME: 'Zwischensumme',
    BAR: 'Barzahlung',
    KARTE: 'Kartenzahlung',
    BON_DRUCKEN: 'Bon drucken',
    KASSIERERWECHSEL: 'Kassiererwechsel',
    VOLLBILD: 'Browser-Vollbild',
    BON_STORNO: 'Bon stornieren',
    KASSENLADE: 'Kassenlade',
    SCHICHTENDE: 'Schichtende',
    ESC: 'Dialog schließen / abbrechen',
  };

  const els = {};
  let barcodeTimes = [];
  const ui = {
    mode: null, // 'PREIS' = Preisabfrage aktiv
    selectedLineId: null,
    lastSource: null,
    lastScanOk: null,
    pendingQty: 1,
  };

  // ------------------------------------------------------------ Aufbau

  function buildStatusbar() {
    els.market = h('span', { class: 'sb-market' });
    els.kasse = h('span', { class: 'sb-kasse' });
    els.kassierer = h('span', { class: 'sb-kassierer' });
    els.schicht = h('span', { class: 'sb-schicht' });
    els.scanner = h('span', { class: 'sb-scanner' });
    els.drucker = h('span', { class: 'sb-drucker', title: P.status() });
    els.bonnr = h('span', { class: 'sb-bonnr' });
    els.clock = h('span', { class: 'sb-clock' });
    els.badges = h('span', { class: 'sb-badges' });
    return h(
      'header',
      { class: 'statusbar', id: 'statusbar' },
      h('div', { class: 'sb-left' }, els.market),
      h('div', { class: 'sb-cells' }, cell('Kasse', els.kasse), cell('Kassierer', els.kassierer), cell('Schicht', els.schicht), cell('Scanner', els.scanner), cell('Drucker', els.drucker), cell('Bon', els.bonnr), cell('Datum / Zeit', els.clock)),
      h('div', { class: 'sb-right' }, els.badges)
    );
  }

  function cell(label, valueEl) {
    return h('div', { class: 'sb-cell' }, h('span', { class: 'sb-label', text: label }), valueEl);
  }

  function buildBon() {
    els.training = h('div', { class: 'training-box', hidden: true });
    els.lines = h('div', { class: 'bon-lines', role: 'listbox', 'aria-label': 'Bonpositionen', tabindex: '-1' });
    els.lineActions = h(
      'div',
      { class: 'line-actions', hidden: true },
      h('span', { class: 'hint', text: 'Gewählte Position:' }),
      h('button', { class: 'btn', type: 'button', onclick: changeQtyAction, text: 'Menge (F2)' }),
      h('button', { class: 'btn', type: 'button', onclick: priceChangeAction, text: 'Preis ändern (Freigabe)' }),
      h('button', { class: 'btn', type: 'button', onclick: discountAction, text: 'Rabatt (Freigabe)' }),
      h('button', { class: 'btn danger', type: 'button', onclick: positionStorno, text: 'Position stornieren (F4)' })
    );
    els.totals = h('div', { class: 'bon-totals' });
    return h(
      'section',
      { class: 'bon-panel', 'aria-label': 'Bonanzeige' },
      h(
        'div',
        { class: 'bon-head' },
        h('span', { text: 'Pos' }),
        h('span', { text: 'Menge' }),
        h('span', { text: 'Artikel' }),
        h('span', { class: 'r', text: 'Einzelpreis' }),
        h('span', { class: 'r', text: 'Summe' })
      ),
      els.lines,
      els.lineActions,
      els.training,
      els.totals
    );
  }

  function buildSide() {
    els.barcode = h('input', {
      id: 'barcode',
      class: 'big-input',
      type: 'text',
      inputmode: 'none',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Scannen oder Code eingeben',
      'aria-label': 'Barcode-Eingabe',
    });
    els.plu = h('input', { id: 'plu', type: 'text', inputmode: 'none', autocomplete: 'off', placeholder: 'PLU', 'aria-label': 'PLU-Eingabe' });
    els.qty = h('input', { id: 'qty', type: 'text', inputmode: 'none', autocomplete: 'off', value: '1', 'aria-label': 'Mengenfeld' });

    els.barcode.addEventListener('keydown', onBarcodeKeydown);
    els.qty.addEventListener('input', () => setPendingQty(els.qty.value));
    const pluSubmit = () => {
      const v = els.plu.value.trim();
      els.plu.value = '';
      if (v) handleCode(v, 'PLU');
    };
    els.pluBtn = h('button', { class: 'btn big wide', type: 'button', onclick: pluSubmit, text: 'PLU übernehmen' });

    return h(
      'aside',
      { class: 'side-panel', 'aria-label': 'Kassenbedienung' },
      h(
        'div',
        { class: 'scanbox' },
        h('label', { class: 'field-label', for: 'barcode', text: 'Barcode / Scan' }),
        els.barcode,
        h('div', { class: 'hint', text: 'Bluetooth-Scanner: einfach scannen. Ohne Scanner: Code eingeben.' }),
        h('button', { class: 'btn big wide', type: 'button', onclick: () => manualCode(), text: 'Code eingeben' })
      ),
      h('div', { class: 'row2' }, h('button', { class: 'btn big wide', type: 'button', onclick: () => openSearch(''), text: 'Artikelsuche' }), h('button', { class: 'btn big wide', type: 'button', onclick: () => POS.App.showView('shop'), text: 'Shop öffnen' })),
      h('div', { class: 'section-title', text: 'Menge für den nächsten Artikel' }),
      els.qty,
      h('div', { class: 'section-title', text: 'PLU-Nummer' }),
      els.plu,
      els.pluBtn,
      POS.Ui.numpad([els.qty, els.plu], { decimal: false, maxLen: 6 })
    );
  }

  function buildActionbar() {
    els.actions = BOTTOM_BAR.map(([action, label]) =>
      h('button', { class: 'fn-btn', type: 'button', 'data-action': action, onclick: () => runAction(action) }, h('span', { class: 'k' }), h('span', { class: 'l', text: label }))
    );
    return h('footer', { class: 'actionbar', 'aria-label': 'Kassiererfunktionen' }, els.actions);
  }

  /** Einmaliger Aufbau der Kassenansicht. Danach aktualisiert render() nur die Inhalte. */
  function init() {
    document.getElementById('topbar-status').replaceChildren(buildStatusbar());
    document.getElementById('view-kasse').replaceChildren(h('div', { class: 'pos-main' }, buildBon(), buildSide()), buildActionbar());
    document.getElementById('view-pumps').replaceChildren(POS.PumpView.build());
    document.getElementById('view-shop').replaceChildren(POS.ShopView.build());

    document.addEventListener('keydown', onGlobalKeydown, true);
    setInterval(tickClock, 1000);
    tickClock();
    render();
    els.barcode.focus();
  }

  function tickClock() {
    if (els.clock) {
      const now = new Date();
      els.clock.textContent = now.toLocaleDateString('de-DE') + ' ' + now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  }

  // ------------------------------------------------------------ Darstellung

  function keyOf(action) {
    return S().settings.keymap[action] || '–';
  }

  function render() {
    if (!els.lines) return;
    const s = S();
    const cart = s.cart;
    const cashier = app().user;
    const shift = L.currentShift(s);

    els.market.textContent = s.settings.marketName;
    els.kasse.textContent = s.settings.kassenNr;
    els.kassierer.textContent = cashier ? cashier.name : '–';
    els.schicht.textContent = shift ? `offen seit ${new Date(shift.openedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'keine Schicht';
    els.schicht.className = 'sb-schicht ' + (shift ? 'ok' : 'warn');
    els.scanner.textContent = (s.settings.scannerVerified ? 'getestet' : 'nicht getestet') + (ui.lastSource ? ` · zuletzt ${ui.lastSource === 'SCANNER' ? 'Scanner' : 'manuell'}` : '');
    els.drucker.textContent = 'Browserdruck';
    els.bonnr.textContent = cart ? `${cart.lines.length} Pos. · offen` : `nächste ${'B-' + String((s.counters.bon || 0) + 1).padStart(6, '0')}`;
    els.badges.replaceChildren(
      ...[
        ui.mode === 'PREIS' ? h('span', { class: 'badge amber', text: 'PREISABFRAGE' }) : null,
        ui.pendingQty > 1 ? h('span', { class: 'badge', text: `MENGE ${ui.pendingQty}x` }) : null,
        s.settings.trainingMode ? h('span', { class: 'badge violet', text: 'TRAINING' }) : null,
        POS.Store.mode === 'memory' ? h('span', { class: 'badge red', text: 'NUR ARBEITSSPEICHER' }) : null,
        POS.Store.mode === 'localstorage' ? h('span', { class: 'badge amber', text: 'localStorage' }) : null,
        h('span', { class: 'badge simbadge', text: 'SIMULATION' }),
      ].filter(Boolean)
    );

    renderLines(cart);
    els.lineActions.hidden = !selectedLine();
    renderTotals(cart);
    renderTraining(s);
    els.actions.forEach((btn) => {
      const action = btn.dataset.action;
      btn.querySelector('.k').textContent = keyOf(action);
      btn.classList.toggle('active', action === 'PREIS' && ui.mode === 'PREIS');
      btn.disabled = !shift && !['KASSIERERWECHSEL', 'BON_DRUCKEN'].includes(action);
    });
    renderSide(s);
    POS.PumpView.update(s);
  }

  function renderLines(cart) {
    const lines = cart ? cart.lines : [];
    if (ui.selectedLineId && !lines.some((l) => l.id === ui.selectedLineId)) ui.selectedLineId = null;
    if (!lines.length) {
      els.lines.replaceChildren(h('div', { class: 'bon-empty', text: 'Bereit. Artikel scannen oder über das Bedienfeld erfassen.' }));
      return;
    }
    const rows = [];
    lines.forEach((line, idx) => {
      const sel = line.id === ui.selectedLineId;
      if (line.kind === 'KRAFTSTOFF') {
        rows.push(
          h(
            'div',
            { class: 'bon-line fuel' + (sel ? ' sel' : ''), role: 'option', 'aria-selected': sel ? 'true' : 'false', 'data-id': line.id, onclick: () => selectLine(line.id) },
            h('span', { class: 'c-pos', text: String(idx + 1) }),
            h('span', { class: 'c-qty', text: '1x' }),
            h('span', { class: 'c-name', text: line.name }),
            h('span', { class: 'c-unit r' }),
            h('span', { class: 'c-sum r', text: M.formatPlain(line.unitCents) })
          )
        );
        rows.push(sub(`${POS.Fuel.formatMl(line.ml)} à ${POS.Fuel.formatPricePerLiter(line.priceMilli)} · festgeschrieben`, ''));
      } else if (line.kind === 'ART') {
        const gross = R.lineGrossCents(line);
        rows.push(
          h(
            'div',
            { class: 'bon-line' + (sel ? ' sel' : ''), role: 'option', 'aria-selected': sel ? 'true' : 'false', 'data-id': line.id, onclick: () => selectLine(line.id) },
            h('span', { class: 'c-pos', text: String(idx + 1) }),
            h('span', { class: 'c-qty', text: `${line.qty}x` }),
            h('span', { class: 'c-name' }, line.name, line.ageVerified ? h('em', { class: 'tag', text: `Alter ${line.ageCheck}+ geprüft` }) : null, line.priceChanged ? h('em', { class: 'tag warn', text: 'Preis geändert' }) : null),
            h('span', { class: 'c-unit r', text: M.formatPlain(line.unitCents) }),
            h('span', { class: 'c-sum r', text: M.formatPlain(gross) })
          )
        );
        if (line.discountPct) rows.push(sub(`Rabatt ${line.discountPct} % ${line.discountReason ? '(' + line.discountReason + ')' : ''}`, '-' + M.formatPlain(R.lineDiscountCents(line)), 'neg'));
        for (const p of line.pfand || []) rows.push(sub(`Pfand ${p.qty * line.qty}x ${p.name}`, M.formatPlain(p.cents * p.qty * line.qty)));
      } else {
        rows.push(
          h(
            'div',
            { class: 'bon-line gut' + (sel ? ' sel' : ''), role: 'option', 'aria-selected': sel ? 'true' : 'false', 'data-id': line.id, onclick: () => selectLine(line.id) },
            h('span', { class: 'c-pos', text: String(idx + 1) }),
            h('span', { class: 'c-qty', text: '' }),
            h('span', { class: 'c-name', text: line.label || `Pfandbon ${line.voucherCode}` }),
            h('span', { class: 'c-unit' }),
            h('span', { class: 'c-sum r neg', text: M.formatPlain(line.cents) })
          )
        );
      }
    });
    els.lines.replaceChildren(...rows);
    const selEl = els.lines.querySelector('.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  function sub(label, amount, cls = '') {
    return h('div', { class: 'bon-sub ' + cls }, h('span', { text: label }), h('span', { class: 'r', text: amount }));
  }

  function renderTotals(cart) {
    const t = cart ? R.computeTotals(cart) : null;
    const paid = cart ? C.paidSum(cart) : 0;
    const due = t ? t.gesamt - paid : 0;
    const row = (label, value, cls = '') => h('div', { class: 'tot-row ' + cls }, h('span', { text: label }), h('strong', { class: 'r', text: value }));
    const payments = cart
      ? cart.payments.map((p) =>
          h('div', { class: 'pay-row' }, h('span', { text: p.type === 'BAR' ? `Bar${p.given !== undefined ? ` (gegeben ${M.formatPlain(p.given)})` : ''}` : p.type === 'KARTE' ? 'Karte (Simulation)' : 'Auszahlung' }), h('span', { class: 'r', text: M.formatPlain(p.cents) })))
      : [];
    // replaceChildren() schreibt null als Text „null“, daher leere Teile vorher herausfiltern
    els.totals.replaceChildren(...[
      h(
        'div',
        { class: 'tot-grid' },
        row('Warenwert brutto', M.formatPlain(t ? t.warenBrutto : 0)),
        row('Rabatt', t && t.rabatt ? '-' + M.formatPlain(t.rabatt) : '0,00'),
        row('Pfand', M.formatPlain(t ? t.pfand : 0)),
        row('Gutschriften (Leergut / Pfandbon)', M.formatPlain(t ? t.gutschriften : 0)),
        row('Zwischensumme', M.formatPlain(t ? t.zwischensumme : 0), 'zs')
      ),
      h(
        'div',
        { class: 'gesamt' + (t && t.gesamt < 0 ? ' neg' : '') },
        h('span', { text: t && t.gesamt < 0 ? 'AUSZAHLUNG AN KUNDE' : 'GESAMTBETRAG' }),
        h('strong', { text: M.formatEuro(t ? t.gesamt : 0) })
      ),
      payments.length ? h('div', { class: 'payments' }, payments) : null,
      cart
        ? h(
            'div',
            { class: 'rest' + (due === 0 ? ' done' : '') },
            h('span', { text: due === 0 ? 'Bon ausgeglichen' : due > 0 ? 'Noch offen' : 'Auszahlen' }),
            h('strong', { text: M.formatEuro(Math.abs(due)) })
          )
        : null,
    ].filter(Boolean));
  }

  function renderTraining(s) {
    const c = s.trainingCustomer;
    if (!s.settings.trainingMode) {
      els.training.hidden = true;
      return;
    }
    els.training.hidden = false;
    if (!c) {
      els.training.replaceChildren(
        h('div', { class: 'tr-head' }, h('strong', { text: 'Training' }), h('span', { text: ' – kein Kunde wartet.' })),
        h('button', { class: 'btn primary', type: 'button', onclick: startTrainingCustomer, text: 'Nächsten Kunden holen' })
      );
      return;
    }
    els.training.replaceChildren(
      h('div', { class: 'tr-head' }, h('strong', { text: `${c.name} (${POS.Training.DIFFICULTY[c.difficulty].label})` }), h('span', { text: ` · zahlt ${c.payment === 'BAR' ? 'bar' : 'mit Karte'}${c.givenCents ? ` (${M.formatEuro(c.givenCents)} gibt er/sie)` : ''}` })),
      h('ul', { class: 'tr-list' }, c.list.map((i) => h('li', { text: `${i.qty}x ${i.name}` })), c.leergut.map((e) => h('li', { class: 'lg', text: `Leergut zurück: ${e.qty}x ${S().deposits.find((d) => d.id === e.depositId).name}` })))
    );
  }

  function renderSide(s) {
    if (els.pluBtn) els.pluBtn.disabled = !els.plu.value;
  }

  function setPendingQty(text) {
    const n = parseInt(text, 10);
    ui.pendingQty = Number.isInteger(n) && n >= 1 && n <= 999 ? n : 1;
    els.qty.value = String(ui.pendingQty);
    render();
  }

  function selectLine(id) {
    ui.selectedLineId = ui.selectedLineId === id ? null : id;
    render();
  }

  // ------------------------------------------------------------ Eingaben

  function onBarcodeKeydown(e) {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const code = els.barcode.value.trim();
      const info = POS.Scanner.classify(barcodeTimes, app().settings());
      barcodeTimes = [];
      els.barcode.value = '';
      if (code) handleCode(code, info.source, info);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      barcodeTimes = POS.Scanner.pushTime(barcodeTimes, performance.now());
    }
  }

  /** Globale Tastatursteuerung: Funktionstasten, Auswahl, Scanner-Eingabe ohne Fokus. */
  function onGlobalKeydown(e) {
    const combo = keyCombo(e);
    const action = actionFor(combo);
    // Belegte Funktionstasten nie an den Browser weiterreichen (z. B. F5 = Neuladen), auch in der Verwaltung
    if (action) e.preventDefault();
    if (!app().user || POS.Ui.modalOpen() || document.getElementById('view-kasse').hidden) return;
    if (action) {
      runAction(action);
      return;
    }
    if (e.target === els.barcode) return;
    const ae = document.activeElement;
    const inField = ae && (ae.matches('input, textarea, select') || ae.isContentEditable);
    if (inField) return;
    if (e.key === 'Escape') {
      cancelMode();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      els.barcode.focus();
      els.barcode.value += e.key;
      barcodeTimes = POS.Scanner.pushTime(barcodeTimes, performance.now());
    }
  }

  function keyCombo(e) {
    if (e.key.length > 1) {
      return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key;
    }
    return null;
  }

  function actionFor(combo) {
    if (!combo) return null;
    for (const [action, key] of Object.entries(S().settings.keymap)) {
      if (key === combo) return action;
    }
    return null;
  }

  function moveSelection(step) {
    const lines = app().S.cart ? app().S.cart.lines : [];
    if (!lines.length) return;
    const idx = lines.findIndex((l) => l.id === ui.selectedLineId);
    const next = idx < 0 ? (step > 0 ? 0 : lines.length - 1) : Math.min(lines.length - 1, Math.max(0, idx + step));
    ui.selectedLineId = lines[next].id;
    render();
  }

  function cancelMode() {
    ui.mode = null;
    ui.selectedLineId = null;
    setPendingQty('1');
    render();
  }

  /** Einheitlicher Einstieg fuer Scan, PLU und Texteingabe. */
  async function handleCode(raw, source) {
    const code = raw.trim();
    ui.lastSource = source;
    const s = S();
    if (/^\d+$/.test(code) && code.length > 6) {
      if (!POS.Ean.isValid(code)) return failScan(`Ungültige Prüfziffer oder Länge: ${code}`);
      if (POS.Ean.isVoucherCode(code)) return redeemVoucherCode(code);
      const art = s.articles.find((a) => a.ean === code);
      if (!art) return failScan(`Unbekannter Barcode ${code} (fiktiv? Artikel in der Verwaltung anlegen)`);
      return articleScanned(art, source);
    }
    if (/^\d{1,6}$/.test(code)) {
      const art = s.articles.find((a) => a.plu === code);
      if (!art) return failScan(`PLU ${code} nicht gefunden`);
      return articleScanned(art, source);
    }
    return openSearch(code);
  }

  function failScan(message) {
    ui.lastScanOk = false;
    POS.Sound.play('unknown');
    toast(message, 'error');
    render();
  }

  function articleClicked(id) {
    const art = S().articles.find((a) => a.id === id);
    if (art) articleScanned(art, 'MANUELL');
  }

  async function articleScanned(art, source) {
    if (ui.mode === 'PREIS') {
      ui.mode = null;
      render();
      return showPriceInfo(art);
    }
    ui.lastScanOk = true;
    return addArticle(art, ui.pendingQty, source);
  }

  async function addArticle(art, qty, source) {
    if (art.ageCheck) {
      const ok = await ageCheckDialog(art);
      if (!ok) return;
    }
    try {
      await app().mutate((d) => {
        const shift = L.requireShift(d);
        const current = d.articles.find((a) => a.id === art.id);
        if (!current) throw R.fail('ARTIKEL_NICHT_GEFUNDEN', 'Artikel nicht gefunden');
        const cart = d.cart || C.newCart({ cashierId: app().user.id, shiftId: shift.id, kassenNr: d.settings.kassenNr });
        d.cart = C.addArticle(cart, current, d.deposits, qty, { source, ageVerified: !!art.ageCheck });
        if (art.ageCheck) L.logEvent(d, { type: 'ALTERSPRUEFUNG', text: `Altersprüfung ${art.ageCheck}+ bestätigt: ${current.name}`, cashierId: app().user.id, shiftId: shift.id });
      });
      POS.Sound.play('scan');
      if (art.stock - qty < 0) toast(`Bestand reicht nicht (Lager ${art.stock}). Verkauf trotzdem möglich (Simulation).`, 'warn');
      else toast(`${qty}x ${art.name}`, 'ok');
    } catch (err) {
      errorToast(err);
    } finally {
      setPendingQty('1');
      render();
    }
  }

  function ageCheckDialog(art) {
    return new Promise((resolve) => {
      let answered = false;
      openModal({
        title: `Altersprüfung ${art.ageCheck}+`,
        content: h(
          'div',
          {},
          h('p', { class: 'big-text', text: art.name }),
          h('p', { text: `Dieser Artikel darf nur an Personen ab ${art.ageCheck} Jahren abgegeben werden. Alter prüfen, dann bestätigen.` })
        ),
        actions: [
          { label: 'Abbrechen', run: () => { answered = true; resolve(false); } },
          { label: 'Altersprüfung bestanden', primary: true, run: () => { answered = true; resolve(true); } },
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  function showPriceInfo(art) {
    openModal({
      title: 'Preisabfrage',
      content: h(
        'div',
        { class: 'price-info' },
        h('p', { class: 'big-text', text: art.name }),
        h('div', { class: 'big-price', text: M.formatEuro(art.priceCents) }),
        h('p', { text: `MwSt. ${art.vat} % · Pfand ${art.pfand.length ? 'ja' : 'nein'} · Lager ${art.stock}` }),
        art.ageCheck ? h('p', { class: 'hint', text: `Altersprüfung ab ${art.ageCheck} Jahren` }) : null
      ),
      actions: [{ label: 'OK', primary: true }],
    });
  }

  async function redeemVoucherCode(code) {
    try {
      await app().mutate((d) => {
        L.requireShift(d);
        const v = L.findVoucher(d, code);
        const shift = L.currentShift(d);
        d.cart = C.addVoucher(d.cart || C.newCart({ cashierId: app().user.id, shiftId: shift.id, kassenNr: d.settings.kassenNr }), v);
      });
      POS.Sound.play('scan');
      toast(`Pfandbon ${code} übernommen (wird beim Abschluss eingelöst)`, 'ok');
    } catch (err) {
      errorToast(err);
    }
  }

  // ------------------------------------------------------------ Aktionen

  /** Manuelle Barcodeeingabe über das Zahlenfeld (13 oder 8 Stellen, oder PLU). */
  function manualCode() {
    if (!app().user) return;
    const input = h('input', { type: 'text', inputmode: 'none', placeholder: 'EAN oder PLU', 'aria-label': 'Code', 'data-autofocus': true, class: 'code-input' });
    openModal({
      title: 'Code manuell eingeben',
      content: h('div', { class: 'form' }, h('p', { class: 'hint', text: 'Für Codes, die der Scanner nicht lesen kann. EAN mit 8 oder 13 Stellen, PLU bis 6 Stellen.' }), input, POS.Ui.numpad(input, { decimal: false, maxLen: 13 })),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Übernehmen',
          primary: true,
          run: async () => {
            const code = input.value.trim();
            if (!code) throw R.fail('CODE_LEER', 'Bitte einen Code eingeben');
            await handleCode(code, 'MANUELL');
          },
        },
      ],
    });
  }

  function runAction(action) {
    switch (action) {
      case 'SUCHE':
        return openSearch('');
      case 'MENGE':
        return changeQtyAction();
      case 'PREIS':
        ui.mode = ui.mode === 'PREIS' ? null : 'PREIS';
        toast(ui.mode ? 'Preisabfrage: Artikel scannen (Esc bricht ab)' : 'Preisabfrage beendet', 'info');
        return render();
      case 'POS_STORNO':
        return positionStorno();
      case 'LEERGUT':
        return openLeergut();
      case 'ZWISCHENSUMME':
        return openTotalsDialog();
      case 'BAR':
        return openCash();
      case 'KARTE':
        return openCard();
      case 'BON_DRUCKEN':
        return printBon();
      case 'BON_STORNO':
        return bonStorno();
      case 'KASSENLADE':
        return openDrawer();
      case 'KASSIERERWECHSEL':
        return app().logout();
      case 'SCHICHTENDE':
        return shiftEnd();
      case 'VOLLBILD':
        return toggleFullscreen();
      case 'ESC':
        return cancelMode();
      default:
        return undefined;
    }
  }

  function selectedLine() {
    const cart = S().cart;
    if (!cart || !ui.selectedLineId) return null;
    return cart.lines.find((l) => l.id === ui.selectedLineId) || null;
  }

  function changeQtyAction() {
    const line = selectedLine();
    if (!line) {
      els.qty.focus();
      els.qty.select();
      return toast('Menge für den nächsten Artikel eintragen, dann scannen. Oder eine Position wählen.', 'info');
    }
    if (line.kind !== 'ART') return toast('Gutschriften können nicht geändert werden', 'warn');
    const input = h('input', { type: 'text', inputmode: 'numeric', value: String(line.qty), 'data-autofocus': true, 'aria-label': 'Neue Menge' });
    openModal({
      title: 'Menge ändern',
      content: h('div', { class: 'form' }, h('p', { text: line.name }), h('label', {}, 'Neue Menge', input), POS.Ui.numpad(input, { decimal: false, maxLen: 3 })),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Übernehmen',
          primary: true,
          run: async () => {
            const qty = parseInt(input.value, 10);
            await app().mutate((d) => {
              d.cart = C.setQty(d.cart, line.id, qty);
            });
            render();
          },
        },
      ],
    });
  }

  function positionStorno() {
    const line = selectedLine();
    if (!line) return toast('Erst eine Position auswählen (Pfeiltasten oder Klick)', 'warn');
    const amount = line.kind === 'ART' ? M.formatEuro(R.lineGrossCents(line)) : M.formatEuro(line.cents);
    const name = line.kind === 'ART' ? `${line.qty}x ${line.name}` : line.label || 'Gutschrift';
    confirmDialog('Position stornieren', `${name} (${amount}) aus dem Bon entfernen?`, 'Stornieren', true).then(async (ok) => {
      if (!ok) return;
      try {
        await app().mutate((d) => {
          L.removePosition(d, { lineId: line.id, cashierId: app().user.id });
        });
        ui.selectedLineId = null;
        toast('Position storniert', 'ok');
      } catch (err) {
        errorToast(err);
      } finally {
        render();
      }
    });
  }

  async function priceChangeAction() {
    const line = selectedLine();
    if (!line || line.kind !== 'ART') return toast('Erst eine Artikelposition wählen', 'warn');
    const approver = await requestApproval('SCHICHTLEITUNG', `Preisänderung für ${line.name}`);
    if (!approver) return;
    const priceInput = h('input', { type: 'text', inputmode: 'decimal', 'data-autofocus': true, placeholder: M.formatPlain(line.unitCents), 'aria-label': 'Neuer Preis' });
    const reasonInput = h('input', { type: 'text', placeholder: 'Grund (Pflicht)', 'aria-label': 'Grund' });
    priceInput._enterNext = reasonInput;
    openModal({
      title: 'Preisänderung',
      content: h('div', { class: 'form' }, h('p', { text: `${line.name} · bisher ${M.formatEuro(line.unitCents)}` }), h('label', {}, 'Neuer Einzelpreis (€)', priceInput), POS.Ui.numpad(priceInput, { decimal: true, maxDecimals: 2 }), h('label', {}, 'Grund', reasonInput)),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Preis übernehmen',
          primary: true,
          run: async () => {
            const cents = M.parseEuro(priceInput.value);
            if (cents === null) throw R.fail('BETRAG_UNGUELTIG', 'Preis ungültig');
            await app().mutate((d) => {
              const shift = L.requireShift(d);
              const { cart } = C.setPrice(d.cart, line.id, cents, reasonInput.value);
              d.cart = cart;
              L.logEvent(d, { type: 'PREISAENDERUNG', text: `Preisänderung ${line.name}: ${M.formatEuro(line.unitCents)} → ${M.formatEuro(cents)} (${reasonInput.value.trim()})`, cashierId: app().user.id, approverId: approver, shiftId: shift.id });
            });
            render();
          },
        },
      ],
    });
  }

  async function discountAction() {
    const line = selectedLine();
    if (!line || line.kind !== 'ART') return toast('Erst eine Artikelposition wählen', 'warn');
    const approver = await requestApproval('SCHICHTLEITUNG', `Rabatt für ${line.name}`);
    if (!approver) return;
    const pctInput = h('input', { type: 'text', inputmode: 'numeric', 'data-autofocus': true, value: String(line.discountPct || 0), 'aria-label': 'Rabatt in Prozent' });
    const reasonInput = h('input', { type: 'text', placeholder: 'Grund (Pflicht)', 'aria-label': 'Grund' });
    openModal({
      title: 'Rabatt auf Position',
      content: h('div', { class: 'form' }, h('p', { text: line.name }), h('label', {}, 'Rabatt in %', pctInput), POS.Ui.numpad(pctInput, { decimal: false, maxLen: 3 }), h('label', {}, 'Grund', reasonInput)),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Rabatt setzen',
          primary: true,
          run: async () => {
            const pct = parseInt(pctInput.value, 10);
            await app().mutate((d) => {
              const shift = L.requireShift(d);
              const { cart } = C.setDiscount(d.cart, line.id, pct, reasonInput.value);
              d.cart = cart;
              L.logEvent(d, { type: 'RABATT', text: `Rabatt ${pct} % auf ${line.name} (${reasonInput.value.trim()})`, cashierId: app().user.id, approverId: approver, shiftId: shift.id });
            });
            render();
          },
        },
      ],
    });
  }

  function openTotalsDialog() {
    const cart = S().cart;
    if (!cart || !cart.lines.length) return toast('Kein Bon vorhanden', 'warn');
    const t = R.computeTotals(cart);
    openModal({
      title: 'Zwischensumme',
      content: h(
        'div',
        { class: 'totals-dialog' },
        ...[
          ['Warenwert brutto', t.warenBrutto],
          ['Rabatt', -t.rabatt],
          ['Pfand', t.pfand],
          ['Gutschriften', t.gutschriften],
        ].map(([l, v]) => h('div', { class: 'tot-row' }, h('span', { text: l }), h('strong', { class: 'r', text: M.formatPlain(v) }))),
        h('div', { class: 'gesamt' }, h('span', { text: 'Zwischensumme' }), h('strong', { text: M.formatEuro(t.zwischensumme) })),
        h('div', { class: 'hint', text: 'MwSt. je Satz: ' + t.mwst.map((m) => `${m.rate} %: ${M.formatEuro(m.steuer)}`).join(' · ') })
      ),
      actions: [{ label: 'Zurück' }, { label: 'Zur Barzahlung (F7)', primary: true, run: () => openCash() }],
    });
  }

  // ------------------------------------------------------------ Bar und Karte

  function openCash() {
    const s = S();
    const cart = s.cart;
    if (!cart || !cart.lines.length) return toast('Kein Bon vorhanden', 'warn');
    if (!L.currentShift(s)) return errorToast(R.fail('SCHICHT_NICHT_OFFEN', 'Keine offene Schicht'));
    const totals = R.computeTotals(cart);
    if (totals.gesamt < 0) return payoutDialog(totals.gesamt);

    const due = C.dueCents(cart);
    const givenInput = h('input', { type: 'text', inputmode: 'decimal', 'data-autofocus': true, placeholder: M.formatPlain(due), 'aria-label': 'Gegebener Betrag' });
    const changeOut = h('div', { class: 'big-change', role: 'status' });
    const suggestion = h('div', { class: 'hint' });
    const composeBox = h('input', { type: 'checkbox', id: 'compose' });
    const denomCounts = R.DENOMINATIONS.map((v) => ({ value: v, input: h('input', { type: 'text', inputmode: 'numeric', value: '0', 'aria-label': `Anzahl ${M.formatPlain(v)} €` }) }));
    const composeCheck = h('div', { class: 'hint', text: '' });
    const composePanel = h('div', { class: 'compose', hidden: true }, h('div', { class: 'denom-grid' }, denomCounts.map((d) => h('label', { class: 'denom' }, h('span', { text: M.formatPlain(d.value) + ' €' }), d.input))), composeCheck);

    const quickValues = [5, 10, 20, 50, 100, 200, 500];
    const update = () => {
      const given = M.parseEuro(givenInput.value);
      if (given === null) {
        changeOut.textContent = 'Betrag eingeben';
        changeOut.className = 'big-change';
        suggestion.textContent = '';
        return;
      }
      if (given < due) {
        changeOut.textContent = `Zu wenig: fehlen ${M.formatEuro(due - given)}`;
        changeOut.className = 'big-change bad';
        suggestion.textContent = '';
        return;
      }
      const change = given - due;
      changeOut.textContent = `Rückgeld ${M.formatEuro(change)}`;
      changeOut.className = 'big-change ok';
      suggestion.textContent = change ? 'Vorschlag: ' + R.changeBreakdown(change).map((b) => `${b.count}× ${M.formatPlain(b.value)} €`).join(', ') : 'Passend, kein Rückgeld';
      if (composeBox.checked) {
        suggestion.textContent = '';
        for (const d of denomCounts) d.input.value = '0';
        for (const b of R.changeBreakdown(change)) denomCounts.find((d) => d.value === b.value).input.value = String(b.count);
        checkComposition(change);
      }
    };
    const checkComposition = (change) => {
      const composed = denomCounts.map((d) => ({ value: d.value, count: parseInt(d.input.value, 10) || 0 }));
      const check = R.checkComposition(composed, change);
      const sum = M.formatEuro(check.sum);
      composeCheck.textContent = check.ok ? `Zusammenstellung ${sum} – korrekt` : `Zusammenstellung ${sum} – ${check.diff > 0 ? 'es fehlen ' : 'zu viel '}${M.formatEuro(Math.abs(check.diff))}`;
      composeCheck.className = 'hint ' + (check.ok ? 'ok' : 'bad');
      return check;
    };
    givenInput.addEventListener('input', update);
    composeBox.addEventListener('change', () => {
      composePanel.hidden = !composeBox.checked;
      update();
    });
    for (const d of denomCounts) d.input.addEventListener('input', () => {
      const given = M.parseEuro(givenInput.value);
      if (given !== null && given >= due) checkComposition(given - due);
    });

    const content = h(
      'div',
      { class: 'cash' },
      h('div', { class: 'cash-due' }, h('span', { text: 'Gesamtbetrag' }), h('strong', { text: M.formatEuro(due) })),
      h('label', { class: 'field-label', text: 'Gegeben (€)' }),
      givenInput,
      POS.Ui.numpad([givenInput, ...denomCounts.map((d) => d.input)], { decimal: true }),
      h('div', { class: 'quick' }, h('button', { class: 'btn', type: 'button', onclick: () => { givenInput.value = M.formatPlain(due); update(); }, text: 'Passend' }), quickValues.map((v) => h('button', { class: 'btn', type: 'button', onclick: () => { givenInput.value = String(v); update(); }, text: `${v} €` }))),
      changeOut,
      suggestion,
      h('label', { class: 'check' }, composeBox, ' Rückgeld selbst zusammenstellen (wird geprüft)'),
      composePanel,
      h('div', { class: 'hint', text: 'Hinweis: Teilzahlungen in bar sind nicht vorgesehen. Gegebener Betrag muss den Gesamtbetrag decken.' })
    );

    openModal({
      title: 'Barzahlung (F7)',
      wide: true,
      content,
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Zahlung bestätigen',
          primary: true,
          run: async () => {
            const given = M.parseEuro(givenInput.value);
            if (given === null) throw R.fail('BETRAG_UNGUELTIG', 'Gegebener Betrag ist ungültig');
            if (given < due) throw R.fail('ZAHLBETRAG_ZU_NIEDRIG', `Zahlbetrag unzureichend, es fehlen ${M.formatEuro(due - given)}`);
            if (composeBox.checked) {
              const check = checkComposition(given - due);
              if (!check.ok) throw R.fail('RUECKGELD_FALSCH', 'Rückgeld-Zusammenstellung stimmt nicht');
            }
            const sale = await commitPayment((cart2) => C.addCash(cart2, given));
            POS.Sound.play('paid');
            showSaleDone(sale);
          },
        },
      ],
    });
    update();
  }

  function payoutDialog(gesamt) {
    confirmDialog('Auszahlung an Kunden', `Bon ist negativ. Betrag ${M.formatEuro(-gesamt)} an den Kunden auszahlen?`, 'Auszahlen').then(async (ok) => {
      if (!ok) return;
      try {
        const sale = await commitPayment((cart) => C.addPayout(cart));
        POS.Sound.play('paid');
        showSaleDone(sale);
      } catch (err) {
        errorToast(err);
      }
    });
  }

  /** Zahlung an den Warenkorb haengen und den Verkauf in EINER Transaktion buchen. */
  async function commitPayment(addPayment) {
    let sale;
    await app().mutate((d) => {
      d.cart = addPayment(d.cart);
      sale = L.finalizeSale(d, { cashierId: app().user.id });
    });
    return sale;
  }

  function showSaleDone(sale) {
    const change = sale.payments.find((p) => p.type === 'BAR' && p.change !== undefined);
    const changeCents = change ? change.change : 0;
    const tr = sale.training;
    const body = h(
      'div',
      { class: 'done' },
      sale.totals.gesamt < 0 ? h('div', { class: 'big-change ok', text: `Auszahlung ${M.formatEuro(-sale.totals.gesamt)}` }) : null,
      changeCents ? h('div', { class: 'big-change ok', text: `Rückgeld ${M.formatEuro(changeCents)}` }) : null,
      changeCents ? h('div', { class: 'hint', text: R.changeBreakdown(changeCents).map((b) => `${b.count}× ${M.formatPlain(b.value)} €`).join(', ') }) : null,
      h('p', { text: `Bon ${sale.bonNr} · Gesamt ${M.formatEuro(sale.totals.gesamt)}` }),
      h('p', { class: 'hint', text: 'SIMULATION – keine echte Zahlung' }),
      tr
        ? h('div', { class: 'tr-result' }, h('strong', { text: `Training: ${tr.score} von 100 Punkten` }), h('ul', {}, (tr.fehler || []).map((f) => h('li', { text: f }))), !(tr.fehler || []).length ? h('p', { text: 'Alles korrekt.' }) : null)
        : null
    );
    if (S().settings.autoPrint) printSale(sale);
    openModal({
      title: 'Zahlung erfolgreich',
      content: body,
      actions: [
        { label: 'Bon drucken (F9)', run: () => { printSale(sale); return false; } },
        { label: 'Nächster Kunde', primary: true },
      ],
      onClose: () => {
        render();
        els.barcode.focus();
      },
    });
    render();
  }

  function openCard() {
    const s = S();
    const cart = s.cart;
    if (!cart || !cart.lines.length) return toast('Kein Bon vorhanden', 'warn');
    if (!L.currentShift(s)) return errorToast(R.fail('SCHICHT_NICHT_OFFEN', 'Keine offene Schicht'));
    const totals = R.computeTotals(cart);
    if (totals.gesamt <= 0) return toast('Bei diesem Bon wird nichts per Karte kassiert', 'warn');
    const due = C.dueCents(cart);
    const screen = h('div', { class: 'terminal-screen', role: 'status' });
    const status = h('div', { class: 'terminal-status' });
    const setScreen = (lines, cls = '') => {
      screen.className = 'terminal-screen ' + cls;
      screen.replaceChildren(...lines.map((l) => h('div', { text: l })));
    };
    setScreen(['SIMULATION – KEINE ECHTE ZAHLUNG', `Betrag: ${M.formatEuro(due)}`, 'Karte vorhalten oder einstecken']);
    let processing = false;
    let entry = null;
    const start = () => {
      if (processing) return false;
      processing = true;
      setScreen(['Zahlung wird verarbeitet …', `Betrag: ${M.formatEuro(due)}`], 'busy');
      entry.buttons[1].disabled = true;
      setTimeout(async () => {
        const result = R.simulateCard(Math.random, S().settings.cardRejectRate);
        if (result.approved) {
          try {
            const sale = await commitPayment((c) => C.addCard(c, result.ref));
            entry.close();
            POS.Sound.play('paid');
            showSaleDone(sale);
          } catch (err) {
            processing = false;
            entry.buttons[1].disabled = false;
            setScreen([`Buchung fehlgeschlagen: ${err.message}`, 'Kein Umsatz gebucht.'], 'bad');
          }
          return;
        }
        POS.Sound.play('declined');
        processing = false;
        setScreen(['ZAHLUNG ABGELEHNT', result.reason, 'Anderes Zahlungsmittel wählen oder erneut versuchen'], 'bad');
        entry.buttons[1].disabled = false;
        entry.buttons[1].textContent = 'Erneut versuchen';
      }, 1200);
      return false;
    };
    entry = openModal({
      title: 'Kartenzahlung (F8) – Simulation',
      wide: true,
      content: h('div', { class: 'terminal' }, screen, status, h('p', { class: 'hint', text: 'Die Kundin bzw. der Kunde bestätigt die simulierte Zahlung mit „Zahlung starten“. Es findet keine reale Transaktion statt.' })),
      actions: [
        { label: 'Abbrechen' },
        { label: 'Zahlung starten', primary: true, run: start },
        { label: 'Bar stattdessen', run: () => { entry.close(); openCash(); } },
      ],
    });
  }

  // ------------------------------------------------------------ Leergut

  function openLeergut() {
    const s = S();
    if (!L.currentShift(s)) return errorToast(R.fail('SCHICHT_NICHT_OFFEN', 'Keine offene Schicht'));
    const inputs = s.deposits.map((dep) => ({ dep, input: h('input', { type: 'text', inputmode: 'numeric', value: '0', 'aria-label': `Anzahl ${dep.name}` }) }));
    const sumOut = h('div', { class: 'big-change' });
    const entriesNow = () => inputs.map((x) => ({ depositId: x.dep.id, qty: parseInt(x.input.value, 10) || 0 }));
    const update = () => {
      const cents = entriesNow().reduce((sum, e) => sum + e.qty * s.deposits.find((d) => d.id === e.depositId).cents, 0);
      sumOut.textContent = `Leergutwert ${M.formatEuro(cents)}`;
    };
    inputs.forEach((x) => x.input.addEventListener('input', update));
    const voucherInput = h('input', { type: 'text', placeholder: 'Pfandbon-Code scannen', 'aria-label': 'Pfandbon-Code' });
    update();

    const create = async (mode) => {
      const entries = entriesNow();
      let voucher;
      await app().mutate((d) => {
        voucher = L.createVoucher(d, { entries, cashierId: app().user.id });
        if (mode === 'BON') {
          const shift = L.requireShift(d);
          d.cart = C.addVoucher(d.cart || C.newCart({ cashierId: app().user.id, shiftId: shift.id, kassenNr: d.settings.kassenNr }), voucher);
        }
        if (mode === 'AUSZAHLUNG') L.payoutVoucher(d, { code: voucher.code, cashierId: app().user.id });
      });
      return voucher;
    };

    const content = h(
      'div',
      { class: 'leergut' },
      h('p', { class: 'hint', text: 'Leergut erfassen. Jede Rückgabe erzeugt einen eindeutigen Leergutbon.' }),
      h(
        'table',
        { class: 'simple' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Pfandart' }), h('th', { class: 'r', text: 'Betrag' }), h('th', { class: 'r', text: 'Anzahl' }))),
        h('tbody', {}, inputs.map((x) => h('tr', {}, h('td', { text: x.dep.name }), h('td', { class: 'r', text: M.formatPlain(x.dep.cents) + ' €' }), h('td', { class: 'r' }, x.input))))
      ),
      sumOut,
      POS.Ui.numpad(inputs.map((x) => x.input), { decimal: false, maxLen: 4 }),
      h('div', { class: 'form' }, h('label', {}, 'Pfandbon einlösen (Code)', voucherInput), h('div', { class: 'hint', text: 'Gutschrift wird im Bon verrechnet und beim Abschluss eingelöst.' }))
    );

    openModal({
      title: 'Leergut (F5)',
      wide: true,
      content,
      actions: [
        { label: 'Schließen' },
        {
          label: 'Einlösen (Bon)',
          run: async () => {
            const code = voucherInput.value.trim();
            if (!code) throw R.fail('PFANDBON_NICHT_GEFUNDEN', 'Bitte Pfandbon-Code eingeben');
            await redeemVoucherCode(code);
            return true;
          },
        },
        {
          label: 'Auszahlen',
          run: async () => {
            const v = await create('AUSZAHLUNG');
            toast(`Ausgezahlt: ${M.formatEuro(v.cents)}`, 'ok');
            POS.Sound.play('drawer');
            return true;
          },
        },
        {
          label: 'Gutschrift in Bon',
          run: async () => {
            const v = await create('BON');
            toast(`Gutschrift ${M.formatEuro(v.cents)} im Bon (${v.code})`, 'ok');
            return true;
          },
        },
        {
          label: 'Leergutbon erstellen',
          primary: true,
          run: async () => {
            const v = await create('BON_OFFEN');
            voucherDone(v);
            return true;
          },
        },
      ],
    });
    update();
  }

  function voucherDone(v) {
    openModal({
      title: 'Leergutbon erstellt',
      content: h('div', {}, h('div', { class: 'big-change ok', text: M.formatEuro(v.cents) }), h('p', { text: `Code ${v.code}` }), h('p', { class: 'hint', text: 'Der Bon ist offen und kann genau einmal eingelöst oder ausgezahlt werden.' })),
      actions: [
        { label: 'Drucken', run: () => { POS.Printer.print(P.voucherText(v, S().settings), S().settings); return false; } },
        { label: 'OK', primary: true },
      ],
    });
  }

  // ------------------------------------------------------------ Suche

  function openSearch(query, categoryId = '') {
    const input = h('input', { type: 'text', value: query, placeholder: 'Name, Marke, EAN oder PLU', autocomplete: 'off', 'data-autofocus': true, 'aria-label': 'Artikelsuche' });
    const catSel = h('select', { 'aria-label': 'Kategorie' }, h('option', { value: '', text: 'Alle Kategorien' }), S().categories.map((c) => h('option', { value: c.id, text: c.name, selected: c.id === categoryId })));
    const list = h('div', { class: 'results', role: 'listbox' });
    let active = 0;
    let matches = [];

    const refresh = () => {
      const q = input.value.trim().toLowerCase();
      const cat = catSel.value;
      matches = S()
        .articles.filter((a) => a.active && (!cat || a.category === cat))
        .filter((a) => !q || a.name.toLowerCase().includes(q) || a.brand.toLowerCase().includes(q) || a.ean === q || a.plu === q)
        .slice(0, 80);
      active = Math.min(active, Math.max(0, matches.length - 1));
      list.replaceChildren(
        ...matches.map((a, i) =>
          h(
            'button',
            { class: 'res' + (i === active ? ' active' : ''), type: 'button', role: 'option', onclick: () => pick(a), onmouseenter: () => { active = i; refresh(); } },
            h('span', { class: 'res-name', text: a.name }),
            h('span', { class: 'res-meta', text: `PLU ${a.plu} · ${a.ean} · Lager ${a.stock}` }),
            h('span', { class: 'res-price', text: M.formatEuro(a.priceCents) })
          )
        )
      );
      if (!matches.length) list.replaceChildren(h('div', { class: 'hint', text: 'Keine Treffer' }));
    };

    const pick = (a) => {
      entry.close();
      articleScanned(a, 'SUCHE');
    };

    input.addEventListener('input', () => {
      active = 0;
      refresh();
    });
    catSel.addEventListener('change', () => {
      active = 0;
      refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(matches.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        refresh();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (matches[active]) pick(matches[active]);
      }
    });

    const entry = openModal({
      title: 'Artikelsuche (F1)',
      wide: true,
      dismissible: true,
      content: h('div', { class: 'search' }, h('div', { class: 'search-bar' }, input, catSel), list, h('div', { class: 'hint', text: 'Pfeiltasten wählen, Enter übernimmt. Menge aus dem Mengenfeld gilt.' })),
      actions: [{ label: 'Schließen' }],
    });
    refresh();
  }

  // ------------------------------------------------------------ Bon, Storno, Schublade

  function printSale(sale) {
    const cfg = S().settings;
    P.print(P.receiptText(P.saleFromRecord(sale, S()), cfg), cfg);
  }

  /** F9: offenen Bon als Vorschau drucken, sonst letzten Verkaufsbon erneut drucken. */
  function printBon() {
    const s = S();
    const cfg = s.settings;
    if (s.cart && s.cart.lines.length) return P.print(P.cartPreview(s.cart, s, cfg), cfg);
    const last = [...s.sales].reverse().find((x) => x.kind === 'VERKAUF');
    if (!last) return toast('Noch kein Bon vorhanden', 'warn');
    printSale(last);
  }

  async function bonStorno() {
    const s = S();
    if (!s.cart || !s.cart.lines.length) return toast('Kein Bon zum Stornieren', 'warn');
    const approver = await requestApproval('SCHICHTLEITUNG', 'Bon-Storno: gesamten offenen Bon verwerfen');
    if (!approver) return;
    const reason = h('input', { type: 'text', placeholder: 'Grund (Pflicht)', 'data-autofocus': true, 'aria-label': 'Grund' });
    openModal({
      title: 'Bon stornieren',
      content: h('div', { class: 'form' }, h('p', { class: 'warn-text', text: `Offener Bon mit ${s.cart.lines.length} Positionen wird verworfen. Die Storno-Freigabe wird protokolliert.` }), h('label', {}, 'Grund', reason)),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Bon stornieren',
          danger: true,
          run: async () => {
            await app().mutate((d) => L.cancelBon(d, { cashierId: app().user.id, approverId: approver, reason: reason.value }));
            ui.selectedLineId = null;
            toast('Bon storniert', 'ok');
            render();
          },
        },
      ],
    });
  }

  async function openDrawer() {
    const kind = h('select', { 'aria-label': 'Buchungsart' }, h('option', { value: 'OPEN', text: 'Kasse öffnen (ohne Buchung)' }), h('option', { value: 'EINLAGE', text: 'Bargeldeinlage' }), h('option', { value: 'ENTNAHME', text: 'Bargeldentnahme (Freigabe)' }));
    const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Betrag (€)', 'aria-label': 'Betrag' });
    const reason = h('input', { type: 'text', placeholder: 'Grund', 'aria-label': 'Grund' });
    openModal({
      title: 'Kassenlade',
      content: h('div', { class: 'form' }, h('label', {}, 'Vorgang', kind), h('label', {}, 'Betrag (€)', amount), POS.Ui.numpad(amount, { decimal: true }), h('label', {}, 'Grund', reason), h('div', { class: 'hint', text: 'Hinweis: Eine physische Kassenlade wird nicht angesteuert (siehe README).' })),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Ausführen',
          primary: true,
          run: async () => {
            const type = kind.value;
            let approver = null;
            if (type === 'ENTNAHME') {
              approver = await requestApproval('SCHICHTLEITUNG', 'Bargeldentnahme aus der Kassenlade');
              if (!approver) return false;
            }
            const cents = type === 'OPEN' ? 0 : M.parseEuro(amount.value);
            if (type !== 'OPEN' && (cents === null || cents <= 0)) throw R.fail('BETRAG_UNGUELTIG', 'Betrag ungültig');
            await app().mutate((d) => {
              const shift = L.requireShift(d);
              if (type === 'OPEN') L.logEvent(d, { type: 'KASSENLADE', text: `Kassenlade geöffnet: ${reason.value || 'ohne Grund'}`, cashierId: app().user.id, shiftId: shift.id });
              if (type === 'EINLAGE') L.cashMove(d, { type: 'EINLAGE', cents, cashierId: app().user.id, shiftId: shift.id, reason: reason.value });
              if (type === 'ENTNAHME') L.cashMove(d, { type: 'ENTNAHME', cents: -cents, cashierId: app().user.id, shiftId: shift.id, reason: reason.value });
              if (type !== 'OPEN') L.logEvent(d, { type: type === 'EINLAGE' ? 'EINLAGE' : 'ENTNAHME', text: `${type === 'EINLAGE' ? 'Einlage' : 'Entnahme'} ${M.formatEuro(cents)} – ${reason.value}`, cashierId: app().user.id, approverId: approver, shiftId: shift.id });
            });
            POS.Sound.play('drawer');
            toast('Kassenlade: Vorgang gebucht', 'ok');
            render();
          },
        },
      ],
    });
  }

  async function shiftEnd() {
    const s = S();
    const shift = L.currentShift(s);
    if (!shift) return toast('Keine offene Schicht', 'warn');
    if (s.cart && s.cart.lines.length) return toast('Erst den offenen Bon abschließen oder stornieren', 'warn');
    const approver = await requestApproval('SCHICHTLEITUNG', 'Schichtende und Kassenabschluss');
    if (!approver) return;
    const counted = h('input', { type: 'text', inputmode: 'decimal', 'data-autofocus': true, placeholder: 'z. B. 250,00', 'aria-label': 'Gezählter Kassenbestand' });
    openModal({
      title: 'Kassenabschluss',
      content: h('div', { class: 'form' }, h('p', { text: 'Bargeld in der Lade zählen und eingeben. Der Sollbestand wird nach dem Abschluss angezeigt.' }), h('label', {}, 'Istbestand (€)', counted), POS.Ui.numpad(counted, { decimal: true })),
      actions: [
        { label: 'Abbrechen' },
        {
          label: 'Schicht abschließen',
          primary: true,
          run: async () => {
            const cents = M.parseEuro(counted.value);
            if (cents === null || cents < 0) throw R.fail('BETRAG_UNGUELTIG', 'Istbestand ungültig');
            let closed;
            await app().mutate((d) => {
              closed = L.closeShift(d, { countedCents: cents, approverId: approver, cashierId: app().user.id });
            });
            showShiftReport(closed, () => app().logout());
            return true;
          },
        },
      ],
    });
  }

  function showShiftReport(shift, onClose) {
    const s = S();
    const lines = POS.Reports.shiftReportLines(s, shift);
    const body = h('table', { class: 'simple' }, h('tbody', {}, lines.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'r', text: v })))));
    const diff = shift.diffCents;
    openModal({
      title: `Kassenabschluss ${shift.id}`,
      wide: true,
      content: h(
        'div',
        {},
        h('div', { class: 'big-change ' + (diff === 0 ? 'ok' : 'bad'), text: `Differenz ${M.formatEuro(diff)}` }),
        body,
        h('p', { class: 'hint', text: diff === 0 ? 'Kassenbestand stimmt.' : diff > 0 ? 'Mehr Bargeld als erwartet.' : 'Weniger Bargeld als erwartet.' })
      ),
      actions: [
        { label: 'Bericht drucken', run: () => { P.print(P.shiftText(lines, s.settings, 'SCHICHTABSCHLUSS'), s.settings); return false; } },
        { label: 'OK', primary: true },
      ],
      onClose,
    });
  }

  function toggleFullscreen() {
    const doc = document;
    if (!doc.fullscreenElement) doc.documentElement.requestFullscreen?.().catch(() => toast('Vollbild nicht möglich', 'warn'));
    else doc.exitFullscreen?.();
  }

  // ------------------------------------------------------------ Training

  async function startTrainingCustomer() {
    try {
      await app().mutate((d) => {
        if (d.trainingCustomer) throw R.fail('TRAINING', 'Es wartet bereits ein Kunde');
        d.trainingCustomer = POS.Training.generateCustomer(Math.random, {
          articles: d.articles,
          deposits: d.deposits,
          difficulty: d.settings.trainingDifficulty,
          index: d.trainingResults.length + 1,
          now: new Date(),
        });
      });
      toast('Neuer Trainingskunde', 'info');
    } catch (err) {
      errorToast(err);
    }
  }

  POS.Pos = {
    init,
    render,
    runAction,
    handleCode,
    articleClicked,
    manualCode,
    startTrainingCustomer,
    focusBarcode() {
      if (els.barcode && !POS.Ui.modalOpen()) els.barcode.focus();
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
