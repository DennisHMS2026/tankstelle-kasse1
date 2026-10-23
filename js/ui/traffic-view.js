/**
 * Verwaltung: Verkehr und Zahlungssimulation (Schwierigkeit, Geschwindigkeit, Störungen,
 * Warteschlange, Ereignisse) sowie der aktuelle Stand der Betriebsphase.
 * Speichert ausschließlich Einstellungen über POS.App.mutate.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h, toast, errorToast, requestApproval } = POS.Ui;
  const R = POS.Rules;
  const T = POS.Traffic;
  const app = () => POS.App;
  const S = () => POS.App.S;

  const field = (label, el) => h('label', { class: 'field' }, h('span', { text: label }), el);
  const check = (checked, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, 'aria-label': label }), ' ' + label);
  const select = (options, value, label) => h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: String(v), text: t, selected: String(v) === String(value) })));
  const numInput = (value, label) => h('input', { type: 'text', inputmode: 'numeric', value: String(value), class: 'small-input', 'aria-label': label });

  function adminView() {
    const s = S();
    const cfg = s.settings;
    const shift = POS.Ledger.currentShift(s);
    const f = {
      paymentAuto: check(cfg.paymentAuto !== false, 'Bezahlvorgang automatisch ablaufen lassen'),
      difficulty: select(POS.Sim.difficultyOptions().map((x) => [x.key, x.label]), cfg.difficulty, 'Schwierigkeitsgrad'),
      simSpeed: select([[1, '1× (Echtzeit)'], [2, '2×'], [5, '5×'], [10, '10×']], cfg.simSpeed || 1, 'Simulationsgeschwindigkeit'),
      payFaults: select([[0, 'Keine'], [0.5, 'Selten'], [1, 'Normal'], [2, 'Häufig']], cfg.payFaults ?? 1, 'Häufigkeit von Zahlungsstörungen'),
      trafficOn: check(cfg.trafficOn !== false, 'Betriebsphasen und Kundenverkehr aktiv'),
      queueMax: numInput(cfg.queueMax ?? 3, 'Maximale Warteschlange'),
      queueWaitMin: numInput(cfg.queueWaitMin ?? 4, 'Wartezeit bis zum Wegfahren in Minuten'),
      evCashFaults: check(cfg.evCashFaults !== false, 'Ereignisse Bargeldzahlung (Abweisung, Nichterkennung, Störung)'),
      evCardFaults: check(cfg.evCardFaults !== false, 'Ereignisse Kartenzahlung (nicht erkannt, Ablehnung, Wechsel)'),
      evSlowPayments: check(cfg.evSlowPayments !== false, 'Verzögerte Zahlungen (langsame Annahme, langes Rückgeld)'),
    };
    const save = async () => {
      const queueMax = parseInt(f.queueMax.value, 10);
      const wait = parseInt(f.queueWaitMin.value, 10);
      if (!Number.isInteger(queueMax) || queueMax < 0 || queueMax > 10) throw R.fail('STAMM_UNGUELTIG', 'Warteschlange: 0 bis 10 Plätze');
      if (!Number.isInteger(wait) || wait < 1 || wait > 15) throw R.fail('STAMM_UNGUELTIG', 'Wartezeit: 1 bis 15 simulierte Minuten');
      const approver = await requestApproval('SCHICHTLEITUNG', 'Verkehrs- und Zahlungssimulation ändern');
      if (!approver) return;
      await app().mutate((d) => {
        Object.assign(d.settings, {
          paymentAuto: f.paymentAuto.querySelector('input').checked,
          difficulty: f.difficulty.value,
          simSpeed: Number(f.simSpeed.value),
          payFaults: Number(f.payFaults.value),
          trafficOn: f.trafficOn.querySelector('input').checked,
          queueMax,
          queueWaitMin: wait,
          evCashFaults: f.evCashFaults.querySelector('input').checked,
          evCardFaults: f.evCardFaults.querySelector('input').checked,
          evSlowPayments: f.evSlowPayments.querySelector('input').checked,
        });
      });
      toast('Simulation gespeichert', 'ok');
    };

    const traffic = s.traffic || T.initialState();
    const today = shift ? T.shiftStats(s, shift) : null;
    const status = h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Aktueller Betrieb' }),
      h(
        'table',
        { class: 'grid' },
        h('tbody', {}, [
          ['Betriebsphase', T.PHASE_LABEL[traffic.phase] || traffic.phase],
          ['Tageszeit', T.DAYPART_LABEL[T.daypart(new Date().getHours())]],
          ['Warteschlange', String(traffic.queue.length)],
          ['Kunden in dieser Schicht', today ? String(today.kunden) : '–'],
          ['Wegfahrer in dieser Schicht', today ? String(today.wegfahrer) : '–'],
          ['Längste Warteschlange', today ? String(today.warteschlangeMax) : '–'],
          ['Durchschnittliche Wartezeit', today && today.wartezeitSchnitt !== null ? `${Math.round(today.wartezeitSchnitt / 1000)} s` : '–'],
          ['Stoßzeiten in dieser Schicht', today ? String(today.stoss) : '–'],
        ].map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { class: 'r', text: v }))))
      )
    );

    const settingsSec = h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Einstellungen' }),
      h('p', { class: 'hint', text: 'Alle Werte sind Simulationsparameter, keine realen Branchenstatistiken. Änderungen braucht eine Freigabe durch die Schichtleitung.' }),
      h('div', { class: 'form' }, f.paymentAuto, field('Schwierigkeitsgrad', f.difficulty), field('Simulationsgeschwindigkeit', f.simSpeed), field('Häufigkeit von Zahlungsstörungen', f.payFaults), f.trafficOn, field('Maximale Warteschlange', f.queueMax), field('Wartezeit bis zum Wegfahren (simulierte Minuten)', f.queueWaitMin), f.evCashFaults, f.evCardFaults, f.evSlowPayments),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', text: 'Einstellungen speichern', onclick: () => save().catch(errorToast) }))
    );

    const phaseSec = h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Betriebsphasen' }),
      h('p', { class: 'hint', text: 'Ruhig (5–20 min), Normal (8–25 min), Stoßzeit (4–12 min), Extrembetrieb (2–6 min). Nach intensiven Phasen folgen häufiger ruhige Phasen. Verpasste Phasenwechsel werden nach einer Pause nicht nachgeholt.' })
    );

    return h('div', { class: 'traffic-admin' }, status, settingsSec, phaseSec);
  }

  POS.TrafficView = { adminView };
})(typeof window !== 'undefined' ? window : globalThis);
