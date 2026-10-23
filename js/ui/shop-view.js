/**
 * Shop-Ansicht: Kategorien, Schnelltasten, Artikelsuche und Kacheln zum Erfassen.
 * Ein Tipp auf eine Kachel legt den Artikel in den Bon (Menge aus dem Mengenfeld der Kasse).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const { h } = POS.Ui;
  const M = POS.Money;

  let el = null;
  let catBox = null;
  let favBox = null;
  let gridBox = null;
  let search = null;
  let state = { cat: null, query: '' };
  let catSig = '';
  let gridSig = '';

  function build() {
    search = h('input', {
      type: 'search',
      class: 'shop-search',
      placeholder: 'Artikel suchen (Name, EAN, PLU)',
      autocomplete: 'off',
      'aria-label': 'Artikelsuche',
      oninput: (e) => {
        state.query = e.target.value.trim().toLowerCase();
        update(POS.App.S);
      },
    });
    catBox = h('div', { class: 'shop-cats' });
    favBox = h('div', { class: 'shop-favs' });
    gridBox = h('div', { class: 'shop-grid' });
    el = h(
      'section',
      { class: 'shop-view', 'aria-label': 'Shop' },
      h(
        'div',
        { class: 'shop-top' },
        search,
        h('button', { class: 'btn big', type: 'button', onclick: () => POS.Pos.manualCode(), text: 'Code eingeben' }),
        h('button', { class: 'btn big', type: 'button', onclick: () => POS.App.openAdmin('artikel'), text: 'Artikelverwaltung' })
      ),
      h('div', { class: 'shop-fav-title', text: 'Schnelltasten' }),
      favBox,
      h('div', { class: 'shop-body' }, h('aside', { class: 'shop-side' }, catBox), h('div', { class: 'shop-main' }, gridBox))
    );
    return el;
  }

  function update(S) {
    if (!el || !S) return;
    // Kategorien nur neu aufbauen, wenn sich ihre Zusammensetzung ändert
    const sig = S.categories.map((c) => c.id + c.name).join('|');
    if (sig !== catSig) {
      catSig = sig;
      catBox.replaceChildren(
        ...[{ id: null, name: 'Alle' }, ...S.categories].map((c) =>
          h('button', {
            class: 'cat-tile' + (state.cat === c.id ? ' active' : ''),
            type: 'button',
            'aria-pressed': state.cat === c.id ? 'true' : 'false',
            onclick: () => {
              state.cat = c.id;
              update(POS.App.S);
            },
            text: c.name,
          })
        )
      );
    }
    // Schnelltasten
    favBox.replaceChildren(
      ...S.settings.favorites
        .map((id) => S.articles.find((a) => a.id === id))
        .filter(Boolean)
        .map((a) =>
          h(
            'button',
            { class: 'fav-tile', type: 'button', onclick: () => POS.Pos.articleClicked(a.id) },
            h('span', { class: 'fav-name', text: a.name }),
            h('span', { class: 'fav-price', text: M.formatEuro(a.priceCents) })
          )
        )
    );
    // Artikelkacheln
    const list = S.articles
      .filter((a) => a.active)
      .filter((a) => !state.cat || a.category === state.cat)
      .filter((a) => !state.query || a.name.toLowerCase().includes(state.query) || a.ean === state.query || a.plu === state.query)
      .slice(0, 120);
    const gsig = list.map((a) => a.id + a.priceCents + a.stock).join('|');
    if (gsig === gridSig) return;
    gridSig = gsig;
    gridBox.replaceChildren(
      ...(list.length
        ? list.map((a) =>
            h(
              'button',
              { class: 'art-tile' + (a.stock <= a.minStock ? ' low' : ''), type: 'button', onclick: () => POS.Pos.articleClicked(a.id) },
              h('span', { class: 'art-name', text: a.name }),
              h('span', { class: 'art-foot' }, h('span', { class: 'art-price', text: M.formatEuro(a.priceCents) }), a.pfand.length ? h('span', { class: 'tag', text: 'Pfand' }) : null)
            )
          )
        : [h('div', { class: 'hint big-hint', text: 'Keine Treffer.' })])
    );
    if (S.categories.length) gridBox.dataset.count = String(list.length);
  }

  POS.ShopView = { build, update };
})(typeof window !== 'undefined' ? window : globalThis);
