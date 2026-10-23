/**
 * Kraftstoff-Mathematik. Ganzzahlig, ohne Gleitkommafehler:
 *  - Menge in Millilitern (ml), ganzzahlig. 1 l = 1000 ml.
 *  - Literpreis in Milli-Euro (priceMilli), ganzzahlig. 1,759 € = 1759.
 *  - Betrag in Cent. Formel: Cent = ml × priceMilli / 10 000, kaufmännisch gerundet.
 *    (ml/1000 Liter × priceMilli/1000 € × 100 Cent)
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const M = POS.Money;

  /** Betrag in Cent für eine Menge zu einem Literpreis. */
  function amountCents(ml, priceMilli) {
    if (!Number.isInteger(ml) || ml < 0) throw new RangeError('Menge in ml muss ganzzahlig und ≥ 0 sein');
    if (!Number.isInteger(priceMilli) || priceMilli < 0) throw new RangeError('Literpreis in Milli-Euro ungültig');
    return M.divRound(ml * priceMilli, 10000);
  }

  /** 32450 → "32,450 l" */
  function formatMl(ml) {
    const sign = ml < 0 ? '-' : '';
    const abs = Math.abs(Math.round(ml));
    const liters = Math.floor(abs / 1000).toString();
    return `${sign}${liters},${String(abs % 1000).padStart(3, '0')} l`;
  }

  /** 1759 → "1,759" (ohne Einheit), für Preistafel und Bon. */
  function formatMilli(priceMilli) {
    const abs = Math.abs(Math.round(priceMilli));
    return `${Math.floor(abs / 1000)},${String(abs % 1000).padStart(3, '0')}`;
  }

  /** 1759 → "1,759 €/l" */
  function formatPricePerLiter(priceMilli) {
    return formatMilli(priceMilli) + ' €/l';
  }

  /**
   * "1,759" → 1759, "1,75" → 1750, "1" → 1000. Maximal drei Nachkommastellen.
   * Gibt null bei ungültiger Eingabe zurück.
   */
  function parsePriceMilli(text) {
    if (typeof text !== 'string') return null;
    const s = text.trim().replace(/€|\/l|\s/gi, '');
    if (!/^\d{1,2}([.,]\d{1,3})?$/.test(s)) return null;
    const [int, frac = ''] = s.split(/[.,]/);
    const value = parseInt(int, 10) * 1000 + parseInt((frac + '000').slice(0, 3), 10);
    return value > 0 && value < 10000 ? value : null;
  }

  /** "12,5" → 12500 ml, "3" → 3000 ml. Maximal drei Nachkommastellen. null bei ungültiger Eingabe. */
  function parseMl(text) {
    if (typeof text !== 'string') return null;
    const s = text.trim().replace(/\s|l$/gi, '');
    if (!/^\d{1,6}([.,]\d{1,3})?$/.test(s)) return null;
    const [int, frac = ''] = s.split(/[.,]/);
    const ml = parseInt(int, 10) * 1000 + parseInt((frac + '000').slice(0, 3), 10);
    return ml > 0 ? ml : null;
  }

  /**
   * Zuwachs seit dem letzten gespeicherten Stand. Pro Auswertung höchstens MAX_CREDIT_MS,
   * damit lange Pausen (iPadOS friert die App ein, Hintergrund) nicht nachberechnet werden.
   */
  const MAX_CREDIT_MS = 2000;

  function creditMl(tank, nowMs) {
    const dt = Math.min(Math.max(0, nowMs - Date.parse(tank.lastAt)), MAX_CREDIT_MS);
    return Math.floor((tank.flowMlPerSec * dt) / 1000);
  }

  /**
   * Aktuell gezapfte Menge: gespeicherter Stand (tank.ml) plus Zuwachs, begrenzt auf das Ziel.
   * Abgeschlossene Vorgänge liefern ihre festgeschriebene Menge.
   */
  function mlAt(tank, nowMs) {
    if (tank.status !== 'LAUFEND') return tank.mlFinal || 0;
    return Math.min(tank.targetMl, tank.ml + creditMl(tank, nowMs));
  }

  POS.Fuel = { amountCents, formatMl, formatMilli, formatPricePerLiter, parsePriceMilli, parseMl, creditMl, mlAt, MAX_CREDIT_MS };
})(typeof window !== 'undefined' ? window : globalThis);
