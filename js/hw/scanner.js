/**
 * USB-Barcodescanner im HID-Tastaturmodus.
 *
 * Erkennung: Ein Scanner sendet die Zeichen eines Codes in sehr kurzen Abstaenden
 * und schliesst mit Enter (oder Tab) ab. Ein Mensch tippt langsamer. Die Unterscheidung
 * erfolgt ueber den mittleren Zeichenabstand. Sie ist eine HEURISTIK:
 *  - Ein sehr schnell tippender Mensch kann als Scanner erkannt werden.
 *  - Ein langsamer Scanner (Bluetooth, Konfiguration) kann als manuell erkannt werden.
 *  - Ohne echten Scanner ist der Test im Assistenten nicht bestanden.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  /** Zeitluecke, nach der eine neue Zeichenfolge beginnt (Mensch pausiert). */
  const BURST_GAP_MS = 300;

  /** Zeitstempel eines Zeichens in den Puffer aufnehmen. Puffer wird bei Pausen neu begonnen. */
  function pushTime(times, now) {
    if (times.length && now - times[times.length - 1] > BURST_GAP_MS) times.length = 0;
    times.push(now);
    return times;
  }

  /** Klassifiziert einen Zeichenlauf. cfg: {scannerMinLen, scannerMaxAvgMs} */
  function classify(times, cfg) {
    const count = times.length;
    const avgMs = count > 1 ? (times[count - 1] - times[0]) / (count - 1) : Infinity;
    const isScanner = count >= cfg.scannerMinLen && avgMs <= cfg.scannerMaxAvgMs;
    return { source: isScanner ? 'SCANNER' : 'MANUELL', count, avgMs: Number.isFinite(avgMs) ? Math.round(avgMs) : null };
  }

  /**
   * Schutz fuer Texteingaben in Dialogen: Ein Scan, der in ein falsches Feld laeuft
   * (z. B. Betragsfeld), wird beim Enter-Abschluss wieder entfernt.
   */
  function guard(el, onReject) {
    let times = [];
    let startValue = '';
    el.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          const info = classify(times, POS.App.settings());
          times = [];
          if (info.source === 'SCANNER') {
            e.preventDefault();
            e.stopPropagation();
            el.value = startValue;
            if (onReject) onReject();
          }
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (times.length === 0) startValue = el.value;
          pushTime(times, performance.now());
        }
      },
      true
    );
  }

  POS.Scanner = { classify, pushTime, guard, BURST_GAP_MS };
})(typeof window !== 'undefined' ? window : globalThis);
