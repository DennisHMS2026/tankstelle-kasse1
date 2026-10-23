/**
 * KARTE: virtuelles Kartenterminal mit automatischem Ablauf (reine Simulation, keine echte Zahlung).
 *
 * Der Kunde zahlt selbstständig: vorhalten oder einstecken, PIN (verdeckt), Verarbeitung, Ergebnis.
 * Gebucht wird erst bei genehmigter Zahlung, in einer einzigen Transaktion (POS.Pos.finishCard).
 * Abbruch oder Unterbrechung vor der Genehmigung hinterlässt keine Buchung, der Bon bleibt offen.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, openModal, toast, errorToast } = POS.Ui;
  const M = POS.Money;
  const R = POS.Rules;
  const C = POS.Cart;
  const L = POS.Ledger;

  const app = () => POS.App;
  const S = () => POS.App.S;

  let entry = null;
  let screen = null;
  let pinBox = null;
  let timers = [];
  let plan = null;
  let speed = 1;

  const DIFFICULTY_OF = (s) => POS.Sim.DIFFICULTY[s.settings.difficulty] || POS.Sim.DIFFICULTY.REALISTISCH;

  function stop() {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
  }

  function later(fn, ms) {
    timers.push(setTimeout(fn, Math.max(0, ms) / speed));
  }

  /** Anzeige des Terminals. Die PIN wird nur als Punkte gezeigt, niemals als Ziffern. */
  function show(lines, cls = '', pinCount = null) {
    if (!screen) return;
    screen.className = 'terminal-screen ' + cls;
    screen.replaceChildren(...lines.map((l) => h('div', { text: l })));
    if (pinBox) {
      const n = plan ? plan.pinLength : 4;
      pinBox.hidden = pinCount === null;
      pinBox.replaceChildren(...Array.from({ length: n }, (_, i) => h('span', { class: 'pin-dot' + (pinCount !== null && i < pinCount ? ' on' : ''), text: '●' })));
    }
  }

  /** Zeitplan des Ablaufs aus dem Kartenplan. Jeder Schritt hat einen Zeitpunkt, ab dem er gilt. */
  function buildSteps(p) {
    const steps = [];
    let t = 0;
    const add = (ms, lines, cls, extra = {}) => {
      t += ms;
      steps.push({ at: t, lines, cls, ...extra });
    };
    const amount = `Betrag: ${M.formatEuro(p.dueCents)}`;
    steps.push({ at: 0, lines: [p.hold, amount], cls: 'idle' });
    if (p.notRecognized) add(1000, ['Karte nicht erkannt', 'Bitte erneut vorhalten'], 'bad');
    add(p.notRecognized ? 1200 : 700, ['Karte erkannt', p.methodLabel], 'ok');
    if (p.pinRequired) {
      add(500, ['PIN eingeben'], 'busy', { pinCount: 0 });
      for (let k = 1; k <= p.pinLength; k++) add(Math.round(p.pinMs / p.pinLength), ['PIN eingeben'], 'busy', { pinCount: k });
    }
    const detect = Math.min(1500, Math.round(p.durationMs * 0.2));
    const processing = Math.max(1000, p.durationMs - detect + p.slowMs);
    p.attempts.forEach((res, i) => {
      add(i === 0 ? processing : Math.round(processing * 0.6), ['Zahlung wird verarbeitet …', amount], 'busy');
      if (res === 'GENEHMIGT') {
        steps.push({ at: t, lines: ['Zahlung erfolgreich', amount], cls: 'ok', approved: true });
      } else {
        steps.push({ at: t, lines: ['Zahlung abgelehnt', 'Kartenzahlung nicht genehmigt'], cls: 'bad', declined: true });
        if (i < p.attempts.length - 1) add(1500, ['Kunde versucht es erneut …'], 'busy');
      }
    });
    if (p.outcome === 'WECHSEL') steps.push({ at: t + 1200, lines: ['Kunde wechselt die Zahlungsart', 'Bitte Zahlungsart wählen'], cls: 'bad', final: true });
    else if (p.outcome === 'ABGELEHNT') steps.push({ at: t, lines: ['Zahlung nicht möglich', 'Anderes Zahlungsmittel wählen'], cls: 'bad', final: true });
    return steps;
  }

  function open() {
    const s = S();
    const cart = s.cart;
    if (!cart || !cart.lines.length) return toast('Kein Bon vorhanden', 'warn');
    if (!L.currentShift(s)) return errorToast(R.fail('SCHICHT_NICHT_OFFEN', 'Keine offene Schicht'));
    if (s.automatSession) return toast('Automat-Zahlung läuft – bitte dort abschließen oder abbrechen', 'warn');
    const due = C.dueCents(cart);
    if (R.computeTotals(cart).gesamt <= 0 || due <= 0) return toast('Bei diesem Bon wird nichts per Karte kassiert', 'warn');
    speed = s.settings.simSpeed || 1;
    plan = POS.Sim.planCard(Math.random, {
      dueCents: due,
      difficulty: DIFFICULTY_OF(s),
      declineRate: s.settings.cardRejectRate,
      events: { cards: s.settings.evCardFaults !== false, slow: s.settings.evSlowPayments !== false },
      faults: s.settings.payFaults ?? 1,
    });
    screen = h('div', { class: 'terminal-screen', role: 'status' });
    pinBox = h('div', { class: 'pin-dots', 'aria-label': 'PIN (verdeckt)', hidden: true });
    const body = h(
      'div',
      { class: 'terminal' },
      screen,
      pinBox,
      h('p', { class: 'hint', text: 'Simulation: Der Ablauf läuft automatisch. Es findet keine echte Transaktion statt.' })
    );
    entry = openModal({
      title: 'Kartenzahlung (Simulation)',
      wide: true,
      cls: 'terminal-dialog',
      content: body,
      actions: [
        { label: 'Abbrechen', run: () => cancel() },
        {
          label: 'Zahlungsart wechseln',
          primary: true,
          run: () => {
            stop();
            entry.close();
            POS.Pos.runAction('AUTOMAT');
            return false;
          },
        },
      ],
      onClose: () => {
        stop();
        entry = null;
      },
    });
    entry.buttons[1].disabled = true;
    show([plan.hold, `Betrag: ${M.formatEuro(due)}`], 'idle');
    for (const st of buildSteps(plan).slice(1)) {
      later(() => playStep(st), st.at);
    }
  }

  function playStep(st) {
    show(st.lines, st.cls, st.pinCount ?? null);
    if (st.declined) recordDecline(st.lines);
    if (st.approved) {
      later(() => approve(), 1200);
    }
    if (st.final && entry && entry.buttons) entry.buttons[1].disabled = false;
  }

  /** Abgelehnter Versuch als Ereignis festhalten. Keine Buchung. */
  function recordDecline() {
    const cashierId = app().user.id;
    app()
      .mutate((d) => {
        const shift = L.currentShift(d);
        L.logEvent(d, { type: 'KARTE_ABGELEHNT', text: `Kartenzahlung abgelehnt (Simulation): ${plan.methodLabel}`, cashierId, shiftId: shift ? shift.id : null, data: { method: plan.method } });
      })
      .catch(errorToast);
  }

  /** Genehmigt: einmalig buchen, dann zur Kasse zurückkehren. */
  async function approve() {
    const ref = 'AUT-SIM' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const durationMs = plan.durationMs + plan.pinMs + plan.slowMs;
    stop();
    const e = entry;
    entry = null;
    if (e) e.close();
    try {
      await POS.Pos.finishCard(ref, durationMs);
    } catch (err) {
      errorToast(err);
    }
  }

  /** Abbruch durch den Kassierer. Vor der Genehmigung gibt es nichts zurückzunehmen. */
  function cancel() {
    stop();
  }

  POS.TerminalView = { open };
})(typeof window !== 'undefined' ? window : globalThis);
