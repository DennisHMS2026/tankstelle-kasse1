/**
 * Digitale Kraftstoffpreistafel. Vollbildansicht mit großen Preisen (drei Nachkommastellen),
 * nur Anzeige. Preisänderungen erfolgen in der Verwaltung.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h } = POS.Ui;
  const F = POS.Fuel;

  let host = null;
  let grid = null;

  function build() {
    grid = h('div', { class: 'board-grid' });
    host = h(
      'div',
      { class: 'board' },
      h(
        'div',
        { class: 'board-head' },
        h('div', {}, h('div', { class: 'board-title', text: 'KRAFTSTOFFPREISE' }), h('div', { class: 'board-sub', id: 'board-market' })),
        h('button', { class: 'btn', type: 'button', onclick: () => POS.App.showView('kasse'), text: 'Zurück zur Kasse (Esc)' })
      ),
      grid,
      h('div', { class: 'board-foot', text: 'Preise je Liter in Euro, inklusive Umsatzsteuer. Simulation.' })
    );
    return host;
  }

  function update(S) {
    if (!grid) return;
    const market = document.getElementById('board-market');
    if (market) market.textContent = S.settings.marketName;
    grid.replaceChildren(
      ...S.fuels.map((f) => {
        const pumps = S.pumps.filter((p) => p.fuelId === f.id).map((p) => p.id);
        const [euro, rest] = F.formatMilli(f.priceMilli).split(',');
        return h(
          'div',
          { class: 'board-card' },
          h('div', { class: 'board-fuel', text: f.name }),
          h('div', { class: 'board-price' }, h('span', { class: 'bp-euro', text: euro }), h('span', { class: 'bp-sep', text: ',' }), h('span', { class: 'bp-rest', text: rest }), h('span', { class: 'bp-unit', text: '€/l' })),
          h('div', { class: 'board-pumps', text: pumps.length ? `Zapfsäule ${pumps.join(', ')}` : 'keine Zapfsäule' })
        );
      })
    );
  }

  POS.Board = { build, update };
})(typeof window !== 'undefined' ? window : globalThis);
