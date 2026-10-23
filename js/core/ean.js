/**
 * EAN-8 / EAN-13 Pruefziffer und fiktive Testcodes.
 *
 * Fiktive Codes: Praefix 200-299 ist fuer interne Verwendung reserviert und
 * wird hier ausschliesslich fuer Simulationsdaten genutzt. Die Codes sind
 * gueltig berechnet, gehoeren aber keinem Hersteller.
 * Praefix 200 = Simulationsartikel, Praefix 299 = Pfandbons (Gutschriften).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  /** Pruefziffer fuer einen Code ohne Pruefziffer (Gewichtung 1/3 von rechts). */
  function checkDigit(body) {
    const len = body.length;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const weight = (len - i) % 2 === 1 ? 3 : 1;
      sum += Number(body[i]) * weight;
    }
    return String((10 - (sum % 10)) % 10);
  }

  function isValid(code) {
    if (typeof code !== 'string' || !/^\d+$/.test(code)) return false;
    if (code.length !== 8 && code.length !== 13) return false;
    return checkDigit(code.slice(0, -1)) === code.slice(-1);
  }

  function withCheck(body) {
    return body + checkDigit(body);
  }

  /** Fiktiver EAN-13: 3-stelliger Praefix + 9-stellige laufende Nummer + Pruefziffer. */
  function simulationEan13(prefix3, seq) {
    if (!/^\d{3}$/.test(prefix3)) throw new TypeError('Praefix muss 3 Ziffern haben');
    if (!Number.isInteger(seq) || seq < 1 || seq > 999999999) throw new RangeError('Laufnummer ungueltig');
    return withCheck(prefix3 + String(seq).padStart(9, '0'));
  }

  function isVoucherCode(code) {
    return isValid(code) && code.length === 13 && code.startsWith('299');
  }

  POS.Ean = { checkDigit, isValid, withCheck, simulationEan13, isVoucherCode };
})(typeof window !== 'undefined' ? window : globalThis);
