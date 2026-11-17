/**
 * The toast stack.
 *
 * `store.session.notices` is the single source of truth: a notice exists in the
 * document state, and this module mirrors it into `#toast-root`. `main.js` calls
 * `renderToasts()` on every `ui` tick, so the render *reconciles* instead of
 * rebuilding -- nodes are added, refreshed and removed by id, and the auto
 * dismiss timers live in a module-level map that is emptied as notices go away.
 * Nothing here touches `document` at import time.
 */

import { el, ICONS, iconButton } from './dom.js';
import { store } from '../store.js';

/** @type {Map<string, HTMLElement>} notice id -> rendered toast */
const toastNodes = new Map();
/** @type {Map<string, string>} notice id -> the content the node was built from */
const toastSignatures = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} notice id -> dismiss timer */
const dismissTimers = new Map();
/** @type {string|null} Signature of the last full notice list, used to skip no-op renders. */
let lastListSignature = null;

/**
 * @param {any} notice
 * @returns {string}
 */
function contentSignature(notice) {
  return `${notice.level}\u0000${notice.title ?? ''}\u0000${notice.message}`;
}

/**
 * @param {any[]} notices
 * @returns {string}
 */
function listSignature(notices) {
  return notices.map((notice) => `${notice.id}\u0000${contentSignature(notice)}`).join('\u0001');
}

/**
 * @param {string} level
 * @returns {string} the `.toast--*` modifier for a notice level
 */
function levelModifier(level) {
  return level === 'warn' || level === 'error' || level === 'ok' ? ` toast--${level}` : '';
}

/**
 * Build one toast. The close button dismisses the notice in the store, which
 * comes back through `renderToasts()` as a removal.
 * @param {any} notice
 * @returns {HTMLElement}
 */
function buildToast(notice) {
  return el('div', { class: `toast${levelModifier(notice.level)}`, dataset: { noticeId: notice.id } }, [
    el('div', { class: 'grow' }, [
      notice.title ? el('div', { class: 'toast__title', text: notice.title }) : null,
      el('div', { class: 'toast__body', text: notice.message }),
    ]),
    iconButton(ICONS.close, 'Dismiss this message', () => store.dismissNotice(notice.id)),
  ]);
}

/**
 * Start the auto-dismiss timer for a notice, once.
 * @param {any} notice
 */
function scheduleDismiss(notice) {
  if (dismissTimers.has(notice.id)) return;
  const timeout = Number(notice.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return;
  const handle = setTimeout(() => {
    dismissTimers.delete(notice.id);
    store.dismissNotice(notice.id);
  }, timeout);
  dismissTimers.set(notice.id, handle);
}

/**
 * Drop the node and the timer for a notice that is no longer in the store.
 * @param {string} id
 */
function forget(id) {
  const handle = dismissTimers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    dismissTimers.delete(id);
  }
  const node = toastNodes.get(id);
  if (node) {
    node.remove();
    toastNodes.delete(id);
  }
  toastSignatures.delete(id);
}

/**
 * Mirror `store.session.notices` into `#toast-root`.
 *
 * Cheap to call on every store tick: when neither the set of notices nor their
 * content changed, it does no DOM work at all.
 *
 * @returns {void}
 */
export function renderToasts() {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const notices = Array.isArray(store.session.notices) ? store.session.notices : [];

  const signature = listSignature(notices);
  if (signature === lastListSignature) return;
  lastListSignature = signature;

  const live = new Set(notices.map((/** @type {any} */ notice) => notice.id));
  for (const id of [...toastNodes.keys()]) {
    if (!live.has(id)) forget(id);
  }

  for (const notice of notices) {
    const content = contentSignature(notice);
    const existing = toastNodes.get(notice.id);
    if (existing && toastSignatures.get(notice.id) === content) continue;
    if (existing) {
      existing.remove();
      toastNodes.delete(notice.id);
    }
    const node = buildToast(notice);
    toastNodes.set(notice.id, node);
    toastSignatures.set(notice.id, content);
    root.append(node);
    scheduleDismiss(notice);
  }
}

/**
 * Raise a notice through the store and show it immediately.
 *
 * `options.timeout` overrides the store's default (6 s, or 12 s for errors) and
 * `options.timeout <= 0` keeps the toast up until it is dismissed by hand.
 *
 * @param {'info'|'warn'|'error'|'ok'} level
 * @param {string} message
 * @param {{title?:string, timeout?:number}} [options]
 * @returns {any} the stored notice, including its id
 */
export function pushToast(level, message, options = {}) {
  const notice = store.notify(level, message, options);
  renderToasts();
  return notice;
}
