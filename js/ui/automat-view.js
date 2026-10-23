/**
 * BAR – AUTOMAT: Bedienung des virtuellen Bargeld-Einzahlautomaten (reine Simulation).
 *
 * Jede Einzahlung, jede Ablehnung, jeder Abschluss und jeder Abbruch ist eine eigene
 * Transaktion (POS.App.mutate). Die Anzeige wird immer aus dem gespeicherten Zustand gebaut,
 * damit nach einem Neustart genau dieselbe Zahlung fortgesetzt werden kann.
 *
 * Simulierte Störungen gibt es nur im Trainingsmodus mit eingeschalteter Option.
 * Im normalen Betrieb entstehen Störungen nur durch echte Zustände (voll, Stückelung gesperrt)
 * oder durch eine ausdrückliche Störungsmeldung in der Verwaltung.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast, confirmDialog, requestApproval } = POS.Ui;
  const R = POS.Rules;
  const M = POS.Money;
  const A = POS.Automat;
  const L = POS.Ledger;

  const app = () => POS.App;
  const S = () => POS.App.S;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let entry = null; // offener Dialog
  let view = null;
  let phase = null; // 'RUECKGELD' | 'ABGESCHLOSSEN' während der Abschlussanimation
  let phaseData = null;
  let busy = false;
  let message = null; // { kind, text } unter der Anzeige
  let dropValue = null; // zuletzt eingeworfenes Stück (für die Einwurf-Animation)

  const COINS = A.DENOMS.filter((x) => x.kind === 'MUENZE');
  const NOTES = A.DENOMS.filter((x) => x.kind === 'SCHEIN');

  function simulationOn(kind) {
    const s = S();
    return !!(s.settings.trainingMode && s.settings.automatSimFaults) ? A.rollFault(Math.random, s.settings.automatFaultRate, kind) : null;
  }

  function flash(kind, text) {
    message = { kind, text };
    render();
    setTimeout(() => {
      if (message && message.text === text) {
        message = null;
        render();
      }
    }, 3500);
  }

  // ------------------------------------------------------------ Öffnen

  /** Startet die Automat-Zahlung für den offenen Bon oder setzt eine laufende fort. */
  async function open() {
    const s = S();
    if (!s.automatSession) {
      const cart = s.cart;
      if (!cart || !cart.lines.length) return toast('Kein Bon vorhanden', 'warn');
      if (!L.currentShift(s)) return errorToast(R.fail('SCHICHT_NICHT_OFFEN', 'Keine offene Schicht'));
      if (cart.payments.length) return toast('Für diesen Bon ist bereits eine Zahlung erfasst', 'warn');
      if (R.computeTotals(cart).gesamt <= 0) return toast('Bei diesem Bon wird nichts über den Automaten kassiert', 'warn');
      try {
        await app().mutate((d) => L.automatStart(d, { cashierId: app().user.id }));
      } catch (err) {
        return errorToast(err);
      }
    }
    showDialog();
  }

  function showDialog() {
    if (entry) return render();
    view = h('div', { class: 'automat-view' });
    const e = openModal({
      title: 'BAR – AUTOMAT (Simulation)',
      wide: true,
      cls: 'automat',
      content: view,
      actions: [
        { label: 'Dialog schließen' },
        { label: 'Erstatten & abbrechen', danger: true, run: cancelFlow },
        { label: 'Zahlung abschließen', primary: true, run: complete },
      ],
      onClose: () => {
        entry = null;
        view = null;
        phase = null;
        phaseData = null;
        message = null;
      },
    });
    entry = e;
    render();
  }

  /** Von außen aufgerufen, wenn sich der Zustand geändert hat (z. B. nach Neustart oder Abbruch). */
  function refresh() {
    if (entry && view) render();
  }

  // ------------------------------------------------------------ Anzeige

  function stateClass(state) {
    if (state === 'STOERUNG' || state === 'AUSSER_BETRIEB') return 'bad';
    if (state === 'WARTUNG') return 'warn';
    if (state === 'ZAHLUNG_AUSREICHEND' || state === 'ZAHLUNG_ABGESCHLOSSEN') return 'ok';
    if (state === 'GELDANNAHME' || state === 'RUECKGELDAUSGABE') return 'busy';
    return '';
  }

  function planText(plan) {
    return plan.map((p) => `${p.count}× ${A.label(p.value)}`).join(' · ');
  }

  function render() {
    if (!entry || !view) return;
    const s = S();
    const sess = s.automatSession;
    if (!sess && !phase) {
      // Zahlung wurde außerhalb dieses Dialogs beendet oder abgebrochen
      entry.close();
      return;
    }
    const due = sess ? sess.dueCents : phaseData ? phaseData.sale.totals.gesamt : 0;
    const paid = sess ? A.sessionPaid(sess) : phaseData ? phaseData.paid : 0;
    const open = paid < due ? due - paid : 0;
    const change = paid > due ? paid - due : 0;
    const plan = sess && change > 0 ? A.planChange(change, A.counts(s)) : sess && open === 0 ? { ok: true, plan: [] } : null;
    const state = phase === 'ABGESCHLOSSEN' ? 'ZAHLUNG_ABGESCHLOSSEN' : phase === 'RUECKGELD' ? 'RUECKGELDAUSGABE' : A.machineState(s);
    const machineBlocked = s.automat.mode !== 'BETRIEBSBEREIT';
    const keysOn = !!sess && !phase && !machineBlocked && !busy;
    const canFinish = !!sess && !phase && open === 0 && !!plan && plan.ok && !busy;

    const warnings = A.slotWarnings(s).slice(0, 4).map((w) =>
      w.kind === 'VOLL'
        ? `Behälter ${A.label(w.value)} voll (${w.count} Stück): Wartung erforderlich`
        : `Wechselgeld knapp: ${A.label(w.value)} nur noch ${w.count} Stück`
    );

    const resultLine = () => {
      if (phase === 'RUECKGELD') {
        if (!phaseData) return h('div', { class: 'ad-big ok', text: 'Rückgeld wird ausgegeben …' });
        const coins = phaseData.plan.flatMap((p) => Array.from({ length: p.count }, () => p.value));
        return h(
          'div',
          { class: 'change-out', 'aria-label': `Rückgeld ${M.formatEuro(phaseData.change)}` },
          coins.length ? coins.map((v, i) => h('span', { class: 'change-piece ' + (A.denom(v).kind === 'SCHEIN' ? 'note' : 'coin'), style: `animation-delay:${i * 120}ms`, text: A.label(v) })) : h('span', { class: 'hint', text: 'Passend – kein Rückgeld' })
        );
      }
      if (phase === 'ABGESCHLOSSEN') return h('div', { class: 'ad-big ok', text: `Zahlung abgeschlossen · Bon ${phaseData ? phaseData.sale.bonNr : ''}` });
      if (open > 0) return h('div', { class: 'ad-big bad' }, h('span', { text: 'Noch offen' }), h('strong', { text: M.formatEuro(open) }));
      if (change === 0) return h('div', { class: 'ad-big ok' }, h('span', { text: 'Passend' }), h('strong', { text: '0,00 €' }));
      return h(
        'div',
        { class: 'ad-big ' + (plan && plan.ok ? 'ok' : 'bad') },
        h('span', { text: 'Rückgeld' }),
        h('strong', { text: M.formatEuro(change) }),
        h('div', { class: 'ad-plan', text: plan && plan.ok ? planText(plan.plan) : 'Mit dem Automatenbestand nicht exakt möglich' })
      );
    };

    const display = h(
      'div',
      { class: 'automat-display' },
      h('div', { class: 'ad-row' }, h('span', { text: 'Rechnungsbetrag' }), h('strong', { class: 'ad-val', text: M.formatEuro(due) })),
      h('div', { class: 'ad-row' }, h('span', { text: 'Eingezahlt' }), h('strong', { class: 'ad-val', text: M.formatEuro(paid) })),
      resultLine(),
      h('div', { class: 'ad-state ' + stateClass(state), role: 'status', text: 'Automat: ' + A.STATE_LABEL[state] }),
      sess && sess.deposits.length
        ? h('div', { class: 'ad-chips', 'aria-label': 'Eingezahlte Stücke' }, sess.deposits.slice(-12).map((x) => h('span', { class: 'chip', text: A.label(x.denom) })))
        : null,
      s.automat.fault ? h('div', { class: 'ad-fault' }, h('span', { text: 'Störung: ' + s.automat.fault.reason }), h('button', { class: 'btn small', type: 'button', onclick: clearFault, text: 'Störung beheben' })) : null,
      warnings.length ? h('ul', { class: 'ad-warn' }, warnings.map((w) => h('li', { text: w }))) : null,
      message ? h('div', { class: 'ad-msg ' + message.kind, role: 'status', text: message.text }) : null,
      !sess && !phase ? null : h('div', { class: 'hint', text: 'Simulation: kein echtes Geld. Die Stücke liegen im virtuellen Automatenbestand.' })
    );

    const keyBtn = (x) => {
      const sl = A.slot(s, x.value);
      const off = !keysOn || !sl || !sl.accepted;
      return h('button', {
        class: 'ak-btn ' + x.kind.toLowerCase(),
        type: 'button',
        disabled: off,
        'data-value': String(x.value),
        'aria-label': `${A.label(x.value)} einwerfen`,
        onclick: () => insertValue(x.value),
        text: A.label(x.value),
      });
    };
    const keys = h(
      'div',
      { class: 'automat-keys' },
      h('div', { class: 'ak-group' }, h('div', { class: 'ak-title', text: 'Münzen' }), h('div', { class: 'ak-grid' }, COINS.map(keyBtn))),
      h('div', { class: 'ak-group' }, h('div', { class: 'ak-title', text: 'Scheine' }), h('div', { class: 'ak-grid' }, NOTES.map(keyBtn))),
      h(
        'div',
        { class: 'ak-slot', 'aria-label': 'Einwurf' },
        dropValue !== null ? h('span', { class: 'ak-drop ' + (A.denom(dropValue).kind === 'SCHEIN' ? 'note' : 'coin'), text: A.label(dropValue) }) : h('span', { class: 'hint', text: 'Einwurf' })
      )
    );
    dropValue = null;

    view.replaceChildren(h('div', { class: 'automat-body' }, display, keys));
    if (entry.buttons) {
      entry.buttons[2].disabled = !canFinish;
      entry.buttons[1].disabled = !sess || !!phase || busy;
    }
  }

  // ------------------------------------------------------------ Aktionen

  /** Ein Geldstück einwerfen. Im Trainingsmodus kann es simuliert abgelehnt werden. */
  async function insertValue(value) {
    if (busy) return;
    busy = true;
    const kind = A.denom(value).kind;
    try {
      const fault = simulationOn(kind);
      if (fault) {
        await app().mutate((d) => L.automatReject(d, { value, reason: fault, cashierId: app().user.id }));
        POS.Sound.play('declined');
        flash('bad', `${A.label(value)} abgelehnt: ${A.FAULT_LABEL[fault]}`);
      } else {
        await app().mutate((d) => L.automatDeposit(d, { value, cashierId: app().user.id }));
        POS.Sound.play('key');
        dropValue = value;
        flash('ok', `${A.label(value)} angenommen`);
      }
    } catch (err) {
      POS.Sound.play('error');
      flash('bad', err.message);
    } finally {
      busy = false;
      render();
    }
  }

  /** Abschluss: Rückgeld aus dem Bestand, dann Animation, dann Bon und Dialog schließen. */
  async function complete() {
    if (busy) return false;
    busy = true;
    const e = entry;
    const failChange = simulationOn('WECHSEL');
    phase = 'RUECKGELD';
    phaseData = null;
    render();
    let res;
    try {
      await app().mutate((d) => {
        res = L.automatComplete(d, { cashierId: app().user.id, changeFault: !!failChange });
      });
    } catch (err) {
      phase = null;
      busy = false;
      render();
      POS.Sound.play('error');
      throw err; // Fehler wird im Dialog angezeigt, der Dialog bleibt offen
    }
    POS.Sound.play('paid');
    phaseData = { sale: res.sale, paid: res.paid, change: res.change, plan: res.plan };
    render();
    await sleep(1400);
    phase = 'ABGESCHLOSSEN';
    render();
    await sleep(900);
    busy = false;
    if (e) e.close();
    phase = null;
    phaseData = null;
    POS.Pos.showSaleDone(res.sale);
    return false;
  }

  /** Abbruch mit Erstattung der eingezahlten Stücke. Der Bon bleibt für eine andere Zahlart offen. */
  async function cancelFlow() {
    const sess = S().automatSession;
    if (!sess || busy) return false;
    const paid = A.sessionPaid(sess);
    let reason = '';
    if (paid > 0) {
      reason = await askReason(`Eingezahlt ${M.formatEuro(paid)} werden an den Kunden zurückgegeben.`);
      if (reason === null) return false;
    } else {
      const ok = await confirmDialog('Automat-Zahlung abbrechen?', 'Es wurde noch nichts eingezahlt. Der Bon bleibt offen und kann anders bezahlt werden.', 'Abbrechen der Zahlung');
      if (!ok) return false;
    }
    busy = true;
    try {
      const res = await app().mutate((d) => L.automatCancel(d, { cashierId: app().user.id, reason }));
      const back = res.refund.map((r) => `${r.count}× ${A.label(r.value)}`).join(', ');
      toast(res.refundCents ? `Erstattet ${M.formatEuro(res.refundCents)}: ${back}` : 'Automat-Zahlung abgebrochen', 'ok');
      if (entry) entry.close();
    } catch (err) {
      errorToast(err);
    } finally {
      busy = false;
    }
    return false;
  }

  function askReason(text) {
    return new Promise((resolve) => {
      let answered = false;
      const input = h('input', { type: 'text', maxlength: 80, placeholder: 'z. B. Kunde bricht ab', 'data-autofocus': true, 'aria-label': 'Grund für den Abbruch' });
      openModal({
        title: 'Abbruch mit Erstattung',
        content: h('div', { class: 'form' }, h('p', { text }), h('label', {}, 'Grund', input)),
        actions: [
          {
            label: 'Zurück',
            run: () => {
              answered = true;
              resolve(null);
            },
          },
          {
            label: 'Erstatten',
            primary: true,
            run: () => {
              const v = input.value.trim();
              if (!v) throw R.fail('GRUND_FEHLT', 'Bitte einen Grund angeben');
              answered = true;
              resolve(v);
            },
          },
        ],
        onClose: () => {
          if (!answered) resolve(null);
        },
      });
    });
  }

  async function clearFault() {
    const approver = await requestApproval('SCHICHTLEITUNG', 'Automaten-Störung beheben');
    if (!approver) return;
    try {
      await app().mutate((d) => L.automatSetMode(d, { mode: 'BETRIEBSBEREIT', cashierId: app().user.id, approverId: approver }));
      toast('Störung behoben', 'ok');
    } catch (err) {
      errorToast(err);
    }
  }

  /** Banner in der Kasse, solange eine Automat-Zahlung läuft (Neustart-Sicherheit). */
  function banner(s) {
    const sess = s.automatSession;
    if (!sess) return null;
    const paid = A.sessionPaid(sess);
    return h(
      'div',
      { class: 'automat-banner', role: 'status' },
      h('span', { text: `BAR – AUTOMAT läuft: eingezahlt ${M.formatEuro(paid)} von ${M.formatEuro(sess.dueCents)}` }),
      h('button', { class: 'btn small primary', type: 'button', onclick: () => open(), text: 'Fortsetzen' })
    );
  }

  // ------------------------------------------------------------ Verwaltung

  /** Bestand je Stückelung aus den Bewegungen (Anfang, Ein, Aus, Befüllt, Entleert, Aktuell). */
  function stockRows(s) {
    return A.DENOMS.map((x) => {
      const ms = s.automatMoves.filter((m) => m.denom === x.value);
      const sum = (types, sign = 1) => ms.filter((m) => types.includes(m.type)).reduce((a, m) => a + sign * m.count, 0);
      const slotCfg = A.slot(s, x.value);
      const aktuell = A.counts(s)[x.value] || 0;
      return {
        x,
        anfang: sum(['INITIAL']),
        ein: sum(['EINZAHLUNG']),
        aus: sum(['RUECKGELD', 'ERSTATTUNG'], -1),
        befuellt: sum(['BEFUELLUNG']),
        entleert: sum(['ENTLEERUNG'], -1),
        aktuell,
        wert: aktuell * x.value,
        cfg: slotCfg,
      };
    });
  }

  function adminView() {
    const s = S();
    const tbl = (headers, rows) =>
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, headers.map((x) => h('th', { class: x.r ? 'r' : '', text: x.label || x })))), h('tbody', {}, rows));
    const rows = stockRows(s);
    const state = A.machineState(s);
    const sec = (title, ...kids) => h('section', { class: 'card' }, h('h2', { text: title }), ...kids);
    const numInput = (label, value = '') => h('input', { type: 'text', inputmode: 'numeric', value, class: 'small-input', 'aria-label': label });
    const fillInputs = new Map();
    const countInputs = new Map();
    const cfgInputs = new Map();

    const stockTable = sec(
      'Bestand je Stückelung',
      h('p', { class: 'hint', text: `Gesamtwert im Automaten: ${M.formatEuro(A.totalCents(s))} · Zustand: ${A.STATE_LABEL[state]}` }),
      tbl(
        ['Stückelung', { label: 'Anfang', r: true }, { label: 'Eingezahlt', r: true }, { label: 'Ausgegeben', r: true }, { label: 'Befüllt', r: true }, { label: 'Entleert', r: true }, { label: 'Aktuell', r: true }, { label: 'Wert', r: true }, { label: 'Min.', r: true }, { label: 'Max.', r: true }],
        rows.map((r) => h('tr', { class: r.aktuell >= r.cfg.capacity ? 'low' : r.aktuell < r.cfg.minimum ? 'low' : '' }, h('td', { text: A.label(r.x.value) }), h('td', { class: 'r', text: String(r.anfang) }), h('td', { class: 'r', text: String(r.ein) }), h('td', { class: 'r', text: String(r.aus) }), h('td', { class: 'r', text: String(r.befuellt) }), h('td', { class: 'r', text: String(r.entleert) }), h('td', { class: 'r', text: String(r.aktuell) }), h('td', { class: 'r', text: M.formatPlain(r.wert) }), h('td', { class: 'r', text: String(r.cfg.minimum) }), h('td', { class: 'r', text: String(r.cfg.capacity) })))
      )
    );

    const fillRows = A.DENOMS.map((x) => {
      const f = numInput(`Befüllen ${A.label(x.value)}`);
      const e = numInput(`Entleeren ${A.label(x.value)}`);
      fillInputs.set(x.value, { fill: f, empty: e });
      return h('tr', {}, h('td', { text: A.label(x.value) }), h('td', { class: 'r', text: String(A.counts(s)[x.value] || 0) }), h('td', {}, f), h('td', {}, e));
    });
    const countStock = async (kind) => {
      const entries = A.DENOMS.map((x) => {
        const v = fillInputs.get(x.value)[kind].value.trim();
        if (v !== '' && !/^\d+$/.test(v)) throw R.fail('MENGE_UNGUELTIG', 'Stückzahlen müssen ganze Zahlen ab 0 sein');
        return { value: x.value, count: v === '' ? 0 : Number(v) };
      }).filter((e) => e.count > 0);
      if (!entries.length) throw R.fail('MENGE_UNGUELTIG', 'Keine Stückzahl erfasst');
      const approver = await requestApproval('SCHICHTLEITUNG', kind === 'fill' ? 'Automat befüllen (aus der Kassenlade)' : 'Automat entleeren (in die Kassenlade)');
      if (!approver) return;
      const fn = kind === 'fill' ? 'automatFill' : 'automatEmpty';
      const res = await app().mutate((d) => L[fn](d, { entries, cashierId: app().user.id, approverId: approver }));
      toast(`${kind === 'fill' ? 'Befüllt' : 'Entleert'} (${res.batch}): ${M.formatEuro(res.cents)}`, 'ok');
      fillInputs.forEach((c) => {
        c.fill.value = '';
        c.empty.value = '';
      });
    };
    const fillSec = sec(
      'Befüllen und Entleeren',
      h('p', { class: 'hint', text: 'Befüllen nimmt Bargeld aus der Kassenlade, Entleeren legt es dorthin. Beides braucht eine Freigabe durch die Schichtleitung.' }),
      tbl(['Stückelung', { label: 'Aktuell', r: true }, 'Befüllen (Stück)', 'Entleeren (Stück)'], fillRows),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: () => countStock('fill').catch(errorToast), text: 'Befüllen buchen' }), h('button', { class: 'btn', type: 'button', onclick: () => countStock('empty').catch(errorToast), text: 'Entleeren buchen' }))
    );

    const modeSel = h('select', { 'aria-label': 'Betriebszustand' }, [['BETRIEBSBEREIT', 'Betriebsbereit'], ['STOERUNG', 'Störung'], ['AUSSER_BETRIEB', 'Außer Betrieb']].map(([v, t]) => h('option', { value: v, text: t, selected: s.automat.mode === v })));
    const reasonIn = h('input', { type: 'text', placeholder: 'Grund (Pflicht bei Störung)', 'aria-label': 'Grund', maxlength: 80 });
    const modeSec = sec(
      'Betrieb und Störungen',
      h('p', { text: `Aktueller Zustand: ${A.STATE_LABEL[state]}${s.automat.fault ? ' – ' + s.automat.fault.reason : ''}` }),
      h('div', { class: 'form' }, h('label', {}, 'Betriebszustand', modeSel), h('label', {}, 'Grund', reasonIn)),
      h(
        'div',
        { class: 'toolbar' },
        h('button', {
          class: 'btn primary',
          type: 'button',
          text: 'Zustand übernehmen',
          onclick: () =>
            requestApproval('SCHICHTLEITUNG', 'Betriebszustand des Automaten ändern')
              .then((approver) => {
                if (!approver) return;
                return app().mutate((d) => L.automatSetMode(d, { mode: modeSel.value, reason: reasonIn.value, cashierId: app().user.id, approverId: approver }));
              })
              .then(() => toast('Betriebszustand gespeichert', 'ok'))
              .catch(errorToast),
        })
      )
    );

    const cfgRows = A.DENOMS.map((x) => {
      const c = A.slot(s, x.value);
      const acc = h('input', { type: 'checkbox', checked: c.accepted, 'aria-label': `Annahme ${A.label(x.value)}` });
      const cap = numInput(`Kapazität ${A.label(x.value)}`, String(c.capacity));
      const min = numInput(`Mindestbestand ${A.label(x.value)}`, String(c.minimum));
      cfgInputs.set(x.value, { acc, cap, min });
      return h('tr', {}, h('td', { text: A.label(x.value) }), h('td', {}, acc), h('td', {}, cap), h('td', {}, min));
    });
    const saveCfg = async () => {
      const approver = await requestApproval('ADMIN', 'Automat-Einstellungen ändern');
      if (!approver) return;
      await app().mutate((d) => {
        for (const x of A.DENOMS) {
          const c = cfgInputs.get(x.value);
          L.automatConfigure(d, { value: x.value, accepted: c.acc.checked, capacity: parseInt(c.cap.value, 10), minimum: parseInt(c.min.value, 10), cashierId: app().user.id });
        }
      });
      toast('Einstellungen gespeichert', 'ok');
    };
    const simOn = h('input', { type: 'checkbox', checked: !!s.settings.automatSimFaults, disabled: !s.settings.trainingMode, 'aria-label': 'Simulierte Störungen' });
    const simRate = numInput('Störungsrate', String(Math.round(s.settings.automatFaultRate * 100)));
    const saveSim = async () => {
      const pct = parseInt(simRate.value, 10);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw R.fail('STAMM_UNGUELTIG', 'Störungsrate: 0 bis 100 %');
      await app().mutate((d) => {
        d.settings.automatSimFaults = simOn.checked && !!d.settings.trainingMode;
        d.settings.automatFaultRate = pct / 100;
      });
      toast('Simulation gespeichert', 'ok');
    };
    const cfgSec = sec(
      'Einstellungen Behälter',
      h('p', { class: 'hint', text: 'Annahme, Kapazität (Stück) und Mindestbestand je Stückelung. Änderungen braucht eine Freigabe durch die Marktleitung.' }),
      tbl(['Stückelung', 'Annahme', 'Kapazität', 'Mindestbestand'], cfgRows),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: () => saveCfg().catch(errorToast), text: 'Einstellungen speichern' })),
      h('h3', { text: 'Simulierte Störungen (nur Trainingsmodus)' }),
      h('label', { class: 'check' }, simOn, ' Störungen simulieren: ', simRate, ' % je Einwurf'),
      h('p', { class: 'hint', text: s.settings.trainingMode ? 'Gilt nur im Trainingsmodus. Im normalen Betrieb werden keine Störungen erzeugt.' : 'Trainingsmodus ist aus. Die Option wirkt erst, wenn er eingeschaltet ist.' }),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: () => saveSim().catch(errorToast), text: 'Simulation speichern' }))
    );

    const countRows = A.DENOMS.map((x) => {
      const soll = A.counts(s)[x.value] || 0;
      const inp = numInput(`Zählung ${A.label(x.value)}`, String(soll));
      countInputs.set(x.value, inp);
      return h('tr', {}, h('td', { text: A.label(x.value) }), h('td', { class: 'r', text: String(soll) }), h('td', {}, inp));
    });
    const countSec = sec(
      'Bestand zählen',
      h('p', { class: 'hint', text: 'Gezählte Stückzahlen eintragen. Die Zählung bucht nichts, sie zeigt nur die Abweichung zum Soll. Bei der Schichtabschluss wird der Automatenbestand separat abgerechnet.' }),
      tbl(['Stückelung', { label: 'Soll', r: true }, 'Ist'], countRows),
      h('div', { class: 'toolbar' }, h('button', {
        class: 'btn primary',
        type: 'button',
        onclick: () => {
          let counts;
          let res;
          try {
            counts = A.DENOMS.map((x) => {
              const v = countInputs.get(x.value).value.trim();
              if (!/^\d+$/.test(v)) throw R.fail('MENGE_UNGUELTIG', `Zählung ${A.label(x.value)} ungültig`);
              return { value: x.value, count: Number(v) };
            });
          } catch (err) {
            return errorToast(err);
          }
          app()
            .mutate((d) => {
              res = L.automatCount(d, { counts, cashierId: app().user.id });
            })
            .then(() => toast(`Soll ${M.formatEuro(res.sollCents)} · Ist ${M.formatEuro(res.istCents)} · Differenz ${M.formatEuro(res.diffCents)}`, res.diffCents ? 'warn' : 'ok'))
            .catch(errorToast);
        },
        text: 'Zählung prüfen',
      })),
      h('p', { class: 'hint', text: 'Die Prüfung protokolliert die Zählung. Eine Abweichung wird nicht automatisch gebucht.' })
    );

    const journal = s.automatMoves.slice(-60).reverse();
    const journalSec = sec(
      'Bewegungsjournal (letzte 60)',
      tbl(
        ['Zeit', 'Art', { label: 'Stück', r: true }, 'Stückelung', { label: 'Betrag', r: true }, 'Beleg / Charge'],
        journal.map((m) => h('tr', {}, h('td', { text: new Date(m.ts).toLocaleString('de-DE') }), h('td', { text: m.type }), h('td', { class: 'r', text: String(m.count) }), h('td', { text: A.label(m.denom) }), h('td', { class: 'r', text: M.formatPlain(m.cents) }), h('td', { text: m.ref || '' })))
      )
    );

    return h('div', { class: 'automat-admin' }, stockTable, fillSec, modeSec, cfgSec, countSec, journalSec);
  }

  POS.AutomatView = { open, refresh, banner, adminView, insertValue, complete, cancelFlow, render };
})(typeof window !== 'undefined' ? window : globalThis);
