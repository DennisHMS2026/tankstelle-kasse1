/**
 * Geldbetraege: intern IMMER ganzzahlige Cent. Keine Gleitkomma-Betraege.
 * Rundung: kaufmaennisch (.5 aufwaerts, betragsmaessig).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  /** Ganzzahlige Division mit kaufmaennischer Rundung, ohne Gleitkommafehler. */
  function divRound(num, den) {
    if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0) {
      throw new TypeError('divRound erwartet ganze Zahlen und positiven Nenner');
    }
    const sign = num < 0 ? -1 : 1;
    const a = Math.abs(num);
    return sign * Math.floor((2 * a + den) / (2 * den));
  }

  /** "38,76", "38.76", "38", "38,5 €" -> 3876 | null bei ungueltiger Eingabe. */
  function parseEuro(text) {
    if (typeof text !== 'string') return null;
    const s = text.replace(/€/g, '').replace(/\s/g, '');
    if (!/^-?\d{1,7}([.,]\d{1,2})?$/.test(s)) return null;
    const negative = s.startsWith('-');
    const [intPart, fracRaw = ''] = s.replace('-', '').split(/[.,]/);
    const frac = parseInt((fracRaw + '00').slice(0, 2), 10);
    const cents = parseInt(intPart, 10) * 100 + frac;
    return negative ? -cents : cents;
  }

  /** 3876 -> "38,76 €" mit Tausenderpunkt. */
  function formatEuro(cents) {
    return formatPlain(cents) + ' €';
  }

  /** 3876 -> "38,76" (ohne Waehrungszeichen, fuer Tabellen und Bons). */
  function formatPlain(cents) {
    const c = Math.round(cents);
    const sign = c < 0 ? '-' : '';
    const abs = Math.abs(c);
    const euro = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}${euro},${String(abs % 100).padStart(2, '0')}`;
  }

  /** Prozentualer Anteil eines Betrags, gerundet. pct ist eine ganze Zahl (z. B. 10 fuer 10 %). */
  function percentOf(cents, pct) {
    return divRound(cents * pct, 100);
  }

  /** Steueranteil aus einem Bruttobetrag (MwSt. ist im Preis enthalten). */
  function taxOf(gross, ratePct) {
    return divRound(gross * ratePct, 100 + ratePct);
  }

  function assertCents(value, name = 'Betrag') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${name} muss ganzzahlig in Cent sein, erhalten: ${value}`);
    }
    return value;
  }

  POS.Money = { divRound, parseEuro, formatEuro, formatPlain, percentOf, taxOf, assertCents };
})(typeof window !== 'undefined' ? window : globalThis);
