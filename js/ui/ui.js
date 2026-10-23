/**
 * Gemeinsame UI-Bausteine: DOM-Helfer, Dialoge (Modals), Meldungen, Freigaben.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});

  /** Kleiner DOM-Helfer: h('button', {class:'btn', onclick}, 'Text', childEl) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const stack = [];

  /**
   * Oeffnet einen Dialog.
   * actions: [{label, primary, danger, run}] - run() gibt false zurueck, um den Dialog offen zu lassen.
   */
  function openModal({ title, content, actions = [], wide = false, dismissible = true, onClose = null }) {
    const errorBox = h('div', { class: 'modal-error', role: 'alert' });
    const entry = { onClose, dismissible };
    const btns = actions.map((a) =>
      h(
        'button',
        {
          class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
          type: 'button',
          onclick: async () => {
            if (entry.busy) return;
            entry.busy = true;
            try {
              const result = a.run ? await a.run() : undefined;
              if (result !== false) closeModal(entry);
            } catch (err) {
              errorBox.textContent = err.message || String(err);
              POS.Sound.play('error');
            } finally {
              entry.busy = false;
            }
          },
        },
        a.label
      )
    );
    const box = h(
      'div',
      { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h(
        'div',
        { class: 'modal-head' },
        h('span', { text: title }),
        dismissible ? h('button', { class: 'modal-x', type: 'button', text: '✕', title: 'Schließen (Esc)', onclick: () => closeModal(entry) }) : null
      ),
      h('div', { class: 'modal-body' }, content),
      errorBox,
      btns.length ? h('div', { class: 'modal-actions' }, btns) : null
    );
    const overlay = h('div', { class: 'modal-overlay' }, box);
    // Klick auf den Hintergrund soll den Fokus im Dialog halten (Enter bleibt wirksam)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) e.preventDefault();
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        e.stopPropagation();
        closeModal(entry);
      } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.defaultPrevented) {
        if (e.target._enterNext) {
          e.preventDefault();
          e.target._enterNext.focus();
          return;
        }
        const primary = actions.findIndex((a) => a.primary);
        if (primary >= 0) {
          e.preventDefault();
          btns[primary].click();
        }
      }
    });
    Object.assign(entry, { overlay, box, errorBox, actions, buttons: btns });
    entry.error = (msg) => {
      errorBox.textContent = msg;
    };
    entry.close = () => closeModal(entry);
    document.getElementById('modal-root').append(overlay);
    stack.push(entry);
    // Scanner-Schutz fuer alle Texteingaben im Dialog
    box.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea').forEach((el) => {
      if (el.hasAttribute('data-allow-scan')) return; // Testfeld des Scanner-Assistenten
      POS.Scanner.guard(el, () => toast('Scan im Dialogfeld verworfen – bitte Barcodefeld nutzen', 'warn'));
    });
    setTimeout(() => {
      const primaryBtn = btns[actions.findIndex((a) => a.primary)];
      const first = box.querySelector('[data-autofocus]') || box.querySelector('input:not([type=checkbox]), select, textarea') || primaryBtn || btns[0];
      if (first) first.focus();
    }, 0);
    return entry;
  }

  function closeModal(entry) {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    entry.overlay.remove();
    if (entry.onClose) entry.onClose();
  }

  function topModal() {
    return stack[stack.length - 1] || null;
  }

  function modalOpen() {
    return stack.length > 0;
  }

  /** Bestaetigungsdialog. Liefert true/false. */
  function confirmDialog(title, message, okLabel = 'Bestätigen', danger = false) {
    return new Promise((resolve) => {
      let answered = false;
      openModal({
        title,
        content: h('p', { text: message }),
        actions: [
          { label: 'Abbrechen', run: () => { answered = true; resolve(false); } },
          { label: okLabel, primary: !danger, danger, run: () => { answered = true; resolve(true); } },
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  /** Freigabe durch eine Person mit ausreichender Rolle (Personalnummer + PIN). */
  function requestApproval(minRole, reason) {
    const R = POS.Rules;
    return new Promise((resolve) => {
      let done = false;
      const finish = (id) => {
        if (!done) {
          done = true;
          resolve(id);
        }
      };
      const nr = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Personalnummer', autocomplete: 'off', 'data-autofocus': true });
      const pin = h('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'off' });
      nr._enterNext = pin;
      openModal({
        title: 'Freigabe erforderlich',
        content: h(
          'div',
          { class: 'form' },
          h('p', { text: reason }),
          h('p', { class: 'hint', text: `Freigabe durch ${R.ROLE_LABEL[minRole]} oder höher.` }),
          h('label', {}, 'Personalnummer', nr),
          h('label', {}, 'PIN', pin)
        ),
        actions: [
          { label: 'Abbrechen', run: () => finish(null) },
          {
            label: 'Freigeben',
            primary: true,
            run: () => {
              const staff = POS.App.S.staff.find((s) => s.nr === nr.value.trim());
              if (!staff || staff.pin !== pin.value) throw R.fail('PIN_FALSCH', 'Personalnummer oder PIN ist falsch');
              if (!R.hasRole(staff, minRole)) throw R.fail('KEINE_BERECHTIGUNG', `${staff.name} hat keine Berechtigung für diese Aktion`);
              finish(staff.id);
            },
          },
        ],
        onClose: () => finish(null),
      });
    });
  }

  /** Kurze Meldung unten am Bildschirm. kind: info | ok | warn | error */
  function toast(message, kind = 'info') {
    const host = document.getElementById('toasts');
    const el = h('div', { class: 'toast ' + kind, role: 'status', text: message });
    host.append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 5000 : 3000);
  }

  function errorToast(err) {
    POS.Sound.play('error');
    toast(err.message || String(err), 'error');
  }

  /**
   * Virtuelles Zahlenfeld. Die Eingabefelder sind schreibgeschützt, damit keine Bildschirmtastatur
   * erscheint. Das zuletzt angetippte Feld wird befüllt. Ohne Auswahl wird das erste Feld genommen.
   * opts.decimal: Komma erlaubt; opts.maxLen: Stellen vor dem Komma; opts.maxDecimals: Nachkommastellen (Literpreis: 3).
   */
  function numpad(inputs, { decimal = true, maxLen = 9, maxDecimals = 2, onChange = null } = {}) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    let active = list[0];
    for (const el of list) {
      el.readOnly = true;
      el.setAttribute('inputmode', 'none');
      el.addEventListener('pointerdown', () => {
        active = el;
        list.forEach((x) => x.classList.toggle('np-active', x === el));
      });
    }
    active.classList.add('np-active');
    const emit = () => {
      active.dispatchEvent(new Event('input', { bubbles: true }));
      if (onChange) onChange(active);
    };
    const press = (k) => {
      const v = active.value;
      if (k === 'C') active.value = '';
      else if (k === '⌫') active.value = v.slice(0, -1);
      else if (k === ',') {
        if (decimal && !v.includes(',')) active.value = (v === '' ? '0' : v) + ',';
      } else {
        const [int, frac] = v.split(',');
        if (frac !== undefined) {
          if (frac.length < maxDecimals) active.value = v + k;
        } else if (int.length < maxLen) {
          active.value = v === '0' ? k : v + k;
        }
      }
      emit();
    };
    const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', decimal ? ',' : 'C', '0', '⌫'];
    const pad = h(
      'div',
      { class: 'numpad', role: 'group', 'aria-label': 'Zahlenfeld' },
      keys.map((k) => h('button', { class: 'np-key' + (k === '⌫' ? ' np-del' : ''), type: 'button', onclick: () => press(k), text: k === '⌫' ? '⌫' : k }))
    );
    pad.append(h('button', { class: 'np-key np-clear', type: 'button', onclick: () => press('C'), text: 'Löschen' }));
    return pad;
  }

  /**
   * Doppeltipp-Schutz: Eine Schaltfläche, die gerade gedrückt wurde, nimmt innerhalb von 450 ms
   * keinen zweiten Klick an. Verhindert doppelte Buchungen durch Mehrfachantippen.
   */
  let lastButton = null;
  let lastButtonAt = 0;
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      const now = Date.now();
      if (btn === lastButton && now - lastButtonAt < 450) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      lastButton = btn;
      lastButtonAt = now;
    },
    true
  );

  POS.Ui = { h, openModal, closeModal, topModal, modalOpen, confirmDialog, requestApproval, toast, errorToast, numpad };
})(typeof window !== 'undefined' ? window : globalThis);
