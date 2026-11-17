/**
 * Shared DOM helpers and small controls.
 *
 * Every widget here returns a real element wired to a real callback -- there are
 * no decorative controls in Motion Lab. The two workhorses are `slider`, which
 * understands gestures (so one drag is one undo step), and `drag`, which is what
 * every timeline interaction is built from.
 */

/**
 * @param {string} tag
 * @param {Record<string, any>} [attributes]
 * @param {Array<Node|string|null|undefined|false>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'value') /** @type {any} */ (node).value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') /** @type {any} */ (node)[key] = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** SVG-free icon glyphs, kept tiny and monochrome. */
export const ICONS = {
  play: '\u25b6', pause: '\u23f8', start: '\u23ee', end: '\u23ed',
  prevFrame: '\u25c0', nextFrame: '\u25b6',
  undo: '\u21b6', redo: '\u21b7',
  eye: '\u25c9', eyeOff: '\u25cb', lock: '\u25a0', unlock: '\u25a1',
  mute: 'M', solo: 'S', key: '\u25c6', grip: '\u22ee\u22ee',
  plus: '+', minus: '\u2212', close: '\u00d7', chevron: '\u25be', chevronRight: '\u25b8',
  trash: '\u2715', copy: '\u29c9', layers: '\u2630', sparkle: '\u2726',
  image: '\u25a3', video: '\u25b7', audio: '\u2248', text: 'T', graphic: '\u25c7',
  warning: '\u26a0', check: '\u2713', info: '\u2139',
};

/**
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLElement}
 */
export function label(text, className = 'field__label') {
  return el('div', { class: className, text });
}

/**
 * A numeric slider with a paired number box and a keyframe toggle.
 *
 * `onInput` fires continuously during a drag; `onCommit` fires once at the end.
 * The store's gesture API turns the whole drag into one undo entry.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {number} options.value
 * @param {number} options.min
 * @param {number} options.max
 * @param {number} [options.step]
 * @param {string} [options.unit]
 * @param {number} [options.decimals]
 * @param {boolean} [options.animated]
 * @param {boolean} [options.keyed]     A keyframe exists at the playhead.
 * @param {boolean} [options.enabled]
 * @param {string} [options.title]
 * @param {(value:number, committing:boolean)=>void} options.onInput
 * @param {()=>void} [options.onCommit]
 * @param {()=>void} [options.onToggleKey]
 * @param {()=>void} [options.onReset]
 * @returns {HTMLElement}
 */
export function slider(options) {
  const decimals = options.decimals ?? 2;
  const step = options.step ?? 0.01;

  const range = el('input', {
    type: 'range',
    min: String(options.min),
    max: String(options.max),
    step: String(step),
    value: String(options.value),
    class: options.animated ? 'is-animated' : '',
    title: options.title ?? '',
    ...(options.enabled === false ? { disabled: true } : {}),
  });
  const number = el('input', {
    type: 'text',
    inputmode: 'decimal',
    class: `num-input${options.animated ? ' is-animated' : ''}`,
    value: formatValue(options.value, decimals),
  });

  let dragging = false;

  range.addEventListener('pointerdown', () => {
    dragging = true;
  });
  range.addEventListener('input', () => {
    const value = Number(range.value);
    number.value = formatValue(value, decimals);
    options.onInput(value, false);
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    options.onCommit?.();
  };
  range.addEventListener('pointerup', finish);
  range.addEventListener('pointercancel', finish);
  range.addEventListener('change', () => {
    options.onInput(Number(range.value), true);
    options.onCommit?.();
  });

  const commitNumber = () => {
    const parsed = Number(String(number.value).replace(/[^0-9.eE+-]/g, ''));
    if (!Number.isFinite(parsed)) {
      number.value = formatValue(options.value, decimals);
      return;
    }
    const clamped = Math.min(options.max, Math.max(options.min, parsed));
    range.value = String(clamped);
    number.value = formatValue(clamped, decimals);
    options.onInput(clamped, true);
    options.onCommit?.();
  };
  number.addEventListener('blur', commitNumber);
  number.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
      event.preventDefault();
      commitNumber();
      number.blur();
    }
  });

  return el('div', { class: 'field' }, [
    el('div', {
      class: 'field__label',
      text: options.unit ? `${options.label} (${options.unit})` : options.label,
      title: options.title ?? options.label,
    }),
    el('div', { class: 'field__control' }, [
      options.onToggleKey
        ? el('button', {
            class: `keyframe-btn${options.keyed ? ' keyframe-btn--on' : options.animated ? ' keyframe-btn--at' : ''}`,
            title: options.keyed
              ? 'A keyframe is already here — click to remove it'
              : 'Add a keyframe at the playhead for this property',
            onclick: options.onToggleKey,
          })
        : null,
      el('div', { class: 'slider' }, [range, number]),
      options.onReset
        ? el('button', { class: 'icon-btn', title: 'Reset to default', text: '\u21ba', onclick: options.onReset })
        : null,
    ]),
  ]);
}

/**
 * @param {number} value
 * @param {number} decimals
 * @returns {string}
 */
export function formatValue(value, decimals) {
  if (!Number.isFinite(value)) return '0';
  const text = value.toFixed(decimals);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * @param {object} options
 * @returns {HTMLElement}
 */
export function toggle(options) {
  const input = el('input', {
    type: 'checkbox',
    ...(options.checked ? { checked: true } : {}),
    ...(options.enabled === false ? { disabled: true } : {}),
  });
  input.addEventListener('change', () => options.onChange(input.checked));
  return el('label', { class: 'checkbox', title: options.title ?? '' }, [input, el('span', { text: options.label })]);
}

/**
 * @param {object} options
 * @returns {HTMLElement}
 */
export function select(options) {
  const node = el('select', { class: 'select-input', title: options.title ?? '' });
  for (const entry of options.options) {
    const value = typeof entry === 'string' ? entry : entry.value;
    const text = typeof entry === 'string' ? entry : entry.label;
    node.append(el('option', { value, text, selected: value === options.value }));
  }
  node.addEventListener('change', () => options.onChange(node.value));
  return options.inline
    ? node
    : el('div', { class: 'field' }, [el('div', { class: 'field__label', text: options.label }), el('div', { class: 'field__control' }, [node])]);
}

/**
 * @param {object} options
 * @returns {HTMLElement}
 */
export function textField(options) {
  const input = el('input', { class: 'text-input', type: 'text', value: options.value ?? '', placeholder: options.placeholder ?? '' });
  const commit = () => options.onChange(input.value);
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
      event.preventDefault();
      commit();
      input.blur();
    }
  });
  return options.inline
    ? input
    : el('div', { class: 'field' }, [el('div', { class: 'field__label', text: options.label }), el('div', { class: 'field__control' }, [input])]);
}

/**
 * @param {object} options
 * @returns {HTMLElement}
 */
export function colorField(options) {
  const input = el('input', { class: 'color-input', type: 'color', value: options.value });
  input.addEventListener('input', () => options.onChange(input.value, false));
  input.addEventListener('change', () => options.onChange(input.value, true));
  return options.inline
    ? input
    : el('div', { class: 'field' }, [el('div', { class: 'field__label', text: options.label }), el('div', { class: 'field__control' }, [input])]);
}

/**
 * Collapsible inspector section.
 * @param {object} options
 * @param {string} options.title
 * @param {boolean} options.open
 * @param {()=>void} [options.onToggle]
 * @param {HTMLElement[]} options.children
 * @param {HTMLElement[]} [options.actions]
 * @returns {HTMLElement}
 */
export function section(options) {
  const body = el('div', { class: 'inspector-section__body' }, options.children);
  if (!options.open) body.classList.add('hidden');
  const head = el('div', {
    class: 'inspector-section__head',
    onclick: (/** @type {MouseEvent} */ event) => {
      if (/** @type {HTMLElement} */ (event.target).closest('.icon-btn')) return;
      options.onToggle?.();
    },
  }, [
    el('span', { class: 'inspector-section__title', text: options.title }),
    ...(options.actions ?? []),
    el('span', { class: 'muted', text: options.open ? ICONS.chevron : ICONS.chevronRight }),
  ]);
  return el('div', { class: 'inspector-section' }, [head, body]);
}

/**
 * Generic pointer drag with optional axis locking and a live event stream.
 *
 * @param {object} options
 * @param {HTMLElement} options.target
 * @param {(event:PointerEvent)=>void} [options.onStart]
 * @param {(dx:number, dy:number, event:PointerEvent)=>void} options.onMove
 * @param {(dx:number, dy:number, event:PointerEvent)=>void} [options.onEnd]
 * @param {boolean} [options.capture]
 * @returns {()=>void} detach
 */
export function drag(options) {
  let startX = 0;
  let startY = 0;
  let active = false;
  let pointerId = -1;

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    active = true;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    if (options.capture !== false) options.target.setPointerCapture?.(event.pointerId);
    document.body.classList.add('dragging');
    options.onStart?.(event);
    event.stopPropagation();
  };
  const onPointerMove = (event) => {
    if (!active) return;
    options.onMove(event.clientX - startX, event.clientY - startY, event);
  };
  const onPointerUp = (event) => {
    if (!active) return;
    active = false;
    document.body.classList.remove('dragging');
    options.target.releasePointerCapture?.(pointerId);
    options.onEnd?.(event.clientX - startX, event.clientY - startY, event);
  };

  options.target.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  return () => {
    options.target.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };
}

/**
 * A menu that closes when you click away.
 * @param {object} options
 * @param {HTMLElement} options.trigger
 * @param {(close:()=>void)=>HTMLElement} options.build
 * @param {'left'|'right'} [options.align]
 * @returns {{root:HTMLElement, close:()=>void, open:()=>void}}
 */
export function menu(options) {
  let panel = null;
  const close = () => {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
  };
  const onOutside = (event) => {
    if (!panel) return;
    if (panel.contains(/** @type {Node} */ (event.target)) || options.trigger.contains(/** @type {Node} */ (event.target))) return;
    close();
  };
  const onKey = (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === 'Escape') close();
  };
  const open = () => {
    if (panel) {
      close();
      return;
    }
    panel = options.build(close);
    panel.classList.add('menu__panel');
    if (options.align === 'right') panel.classList.add('menu__panel--right');
    root.append(panel);
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey);
    }, 0);
  };
  options.trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    open();
  });
  const root = el('div', { class: 'menu' }, [options.trigger]);
  return { root, close, open };
}

/**
 * @param {string} label
 * @param {string} [className]
 * @param {Record<string, any>} [attributes]
 * @returns {HTMLButtonElement}
 */
export function button(label, className = 'btn', attributes = {}) {
  return /** @type {HTMLButtonElement} */ (el('button', { class: className, ...attributes }, [label]));
}

/**
 * @param {string} icon
 * @param {string} title
 * @param {() => void} onClick
 * @param {string} [className]
 * @returns {HTMLButtonElement}
 */
export function iconButton(icon, title, onClick, className = 'icon-btn') {
  return /** @type {HTMLButtonElement} */ (el('button', { class: className, title, text: icon, onclick: onClick }));
}

/**
 * @param {string} level
 * @param {string} text
 * @param {HTMLElement[]} [extra]
 * @returns {HTMLElement}
 */
export function hint(level, text, extra = []) {
  const className = level === 'warn' ? 'hint hint--warn' : level === 'error' ? 'hint hint--danger' : 'hint';
  return el('div', { class: className }, [el('span', { text }), ...extra]);
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
export function emptyState(text) {
  return el('div', { class: 'empty-state', text });
}

/**
 * Debounce a function.
 * @template {(...args:any[])=>any} T
 * @param {T} fn
 * @param {number} wait
 * @returns {(...args:Parameters<T>)=>void}
 */
export function debounce(fn, wait) {
  /** @type {any} */
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/**
 * Ask for a confirmation through the app's own dialog styling rather than a
 * native `confirm()`, so the flow stays inside the workspace.
 * @param {object} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  return new Promise((resolvePromise) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolvePromise(window.confirm(options.message));
      return;
    }
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolvePromise(value);
    };
    const onKey = (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Escape') close(false);
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') close(true);
    };
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (event) => { if (event.target === backdrop) close(false); } }, [
      el('div', { class: 'modal modal--sm' }, [
        el('div', { class: 'modal__head' }, [el('div', { class: 'modal__title', text: options.title ?? 'Are you sure?' })]),
        el('div', { class: 'modal__body' }, [el('div', { class: 'hint', text: options.message })]),
        el('div', { class: 'modal__foot' }, [
          el('div', { class: 'spacer' }),
          button(options.cancelLabel ?? 'Cancel', 'btn', { onclick: () => close(false) }),
          button(options.confirmLabel ?? 'Confirm', options.danger ? 'btn btn--danger' : 'btn btn--primary', { onclick: () => close(true) }),
        ]),
      ]),
    ]);
    root.append(backdrop);
    document.addEventListener('keydown', onKey);
    /** @type {HTMLElement} */ (backdrop.querySelector('.btn--primary, .btn--danger'))?.focus();
  });
}

/**
 * @param {object} options
 * @returns {Promise<string|null>}
 */
export function promptDialog(options) {
  return new Promise((resolvePromise) => {
    const root = document.getElementById('modal-root');
    if (!root) {
      resolvePromise(window.prompt(options.message, options.value ?? ''));
      return;
    }
    const input = el('input', { class: 'text-input', type: 'text', value: options.value ?? '' });
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolvePromise(value);
    };
    const onKey = (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Escape') close(null);
      if (/** @type {KeyboardEvent} */ (event).key === 'Enter') close(input.value);
    };
    const backdrop = el('div', { class: 'modal-backdrop' }, [
      el('div', { class: 'modal modal--sm' }, [
        el('div', { class: 'modal__head' }, [el('div', { class: 'modal__title', text: options.title ?? 'Rename' })]),
        el('div', { class: 'modal__body' }, [
          options.message ? el('div', { class: 'hint', text: options.message }) : null,
          input,
        ]),
        el('div', { class: 'modal__foot' }, [
          el('div', { class: 'spacer' }),
          button('Cancel', 'btn', { onclick: () => close(null) }),
          button('Save', 'btn btn--primary', { onclick: () => close(input.value) }),
        ]),
      ]),
    ]);
    root.append(backdrop);
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
}

/**
 * @param {HTMLElement} container
 */
export function clear(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

/**
 * Measure text width once and cache -- used by the timeline for labels.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @returns {number}
 */
export function textWidth(ctx, text) {
  return ctx.measureText(text).width;
}

/**
 * Fit a canvas to its container's device pixel size.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} container
 * @param {number} [height]
 * @returns {CanvasRenderingContext2D}
 */
export function fitCanvas(canvas, container, height) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = container.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor((height ?? rect.height) * dpr));
  if (canvas.width !== width || canvas.height !== h) {
    canvas.width = width;
    canvas.height = h;
  }
  canvas.style.width = '100%';
  canvas.style.height = `${height ?? rect.height}px`;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
