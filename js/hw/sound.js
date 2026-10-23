/**
 * Kassensounds ueber die Web Audio API. Vollstaendig offline, keine Audiodateien.
 * Lautstaerke und Ein/Aus kommen aus den Einstellungen (Funktion getConfig).
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  let ctx = null;
  let getConfig = () => ({ soundOn: true, soundVolume: 0.5 });

  function audio() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(a, freq, dur, type, at, gain) {
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(a, dur, gain) {
    const buffer = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = a.createBufferSource();
    const g = a.createGain();
    g.gain.value = Math.max(gain, 0.0002);
    src.buffer = buffer;
    src.connect(g);
    g.connect(a.destination);
    src.start();
  }

  const SOUNDS = {
    scan: [[1800, 0.08, 'square', 0]],
    unknown: [[330, 0.15, 'sawtooth', 0], [262, 0.22, 'sawtooth', 0.18]],
    key: [[1200, 0.02, 'square', 0]],
    error: [[220, 0.3, 'square', 0]],
    paid: [[660, 0.12, 'triangle', 0], [990, 0.2, 'triangle', 0.13]],
    declined: [[440, 0.15, 'sawtooth', 0], [220, 0.35, 'sawtooth', 0.17]],
    drawer: 'noise',
  };

  function play(name, { force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.soundOn && !force) return;
    if (name === 'key' && !cfg.soundKeys) return;
    const a = audio();
    if (!a) return;
    const gain = 0.3 * Math.min(1, Math.max(0, cfg.soundVolume));
    try {
      const def = SOUNDS[name];
      if (!def) return;
      if (def === 'noise') {
        noise(a, 0.22, gain);
        return;
      }
      for (const [freq, dur, type, at] of def) tone(a, freq, dur, type, at, gain);
    } catch (err) {
      console.warn('Sound nicht abspielbar:', err);
    }
  }

  POS.Sound = {
    play,
    setConfigSource(fn) {
      getConfig = fn;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
