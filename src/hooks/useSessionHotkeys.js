/**
 * src/hooks/useSessionHotkeys.js
 * -----------------------------------------------------------------------------
 * Purpose
 * - A resilient React hook that wires the SessionRunner's keyboard shortcuts:
 *   • Space = Pause/Resume toggle
 *   • N / ArrowRight = Next step
 *   • P / ArrowLeft  = Previous step
 *   • (optional) S   = Speak current cue
 *   • (optional) A   = Toggle Auto-Advance
 *
 * How this fits
 * - Used by the root-mounted SessionRunner modal (focus-trapped) to provide
 *   consistent, discoverable controls that keep working across route changes.
 * - The hook is defensive: it ignores keypresses while user is typing in
 *   inputs/textarea/contenteditable, and it won't conflict with OS/browser
 *   shortcuts if Ctrl/Meta/Alt are held.
 *
 * Contracts & Assumptions
 * - Call this hook *inside* the SessionRunner component (or a child) and pass
 *   the handlers you want to trigger.
 * - The caller controls `enabled` state. When disabled, listeners are removed.
 *
 * API
 *   const { enable, disable, updateHandlers, bindings } = useSessionHotkeys({
 *     enabled: true,
 *     onPauseToggle, onNext, onPrev, onSpeak, onAutoAdvanceToggle,
 *     extra: [{ keys: ['KeyH','?'], description: 'Show help', handler: onHelp }]
 *   });
 *
 * Code quality
 * - Defensive checks & early returns.
 * - Small local helpers and clear JSDoc types.
 * - No external dependencies.
 * -----------------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * @typedef {Object} HotkeyHandler
 * @property {boolean} [enabled]
 * @property {() => void} [onPauseToggle]
 * @property {() => void} [onNext]
 * @property {() => void} [onPrev]
 * @property {() => void} [onSpeak]
 * @property {() => void} [onAutoAdvanceToggle]
 * @property {Array<{ keys: string[], description?: string, handler: () => void }>} [extra]
 */

/**
 * Returns true if the target element is an editable control.
 * @param {EventTarget|null} t
 */
function isEditableTarget(t) {
  const el = /** @type {HTMLElement|null} */ (t);
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return true;
  if (el.isContentEditable) return true;
  // Generic ARIA textbox/content inputs
  const role = (el.getAttribute && el.getAttribute('role')) || '';
  if (role && /textbox|searchbox|combobox/i.test(role)) return true;
  return false;
}

/**
 * Normalize KeyboardEvent into a compact key identifier.
 * - Prefer `e.code` when available for letter keys (e.g., 'KeyN', 'Space').
 * - Fall back to lower-cased `e.key` for non-letter keys (e.g., 'ArrowRight').
 * @param {KeyboardEvent} e
 */
function keyId(e) {
  if (e.code && /^Key[A-Z]$|^Space$|^Arrow(Left|Right|Up|Down)$/.test(e.code)) return e.code;
  // fallback
  const k = (e.key || '').toLowerCase();
  if (k === ' ') return 'Space';
  if (k === 'arrowright') return 'ArrowRight';
  if (k === 'arrowleft') return 'ArrowLeft';
  if (k === 'arrowup') return 'ArrowUp';
  if (k === 'arrowdown') return 'ArrowDown';
  if (k.length === 1 && /[a-z0-9?]/.test(k)) return `Key${k.toUpperCase()}`;
  return k;
}

/**
 * Build default keybinding map.
 * @param {HotkeyHandler} h
 */
function buildDefaultBindings(h) {
  /** @type {Record<string, () => void>} */
  const map = Object.create(null);

  if (h.onPauseToggle) {
    map['Space'] = h.onPauseToggle;
    map['KeyK'] = h.onPauseToggle; // common media key alias
  }
  if (h.onNext) {
    map['KeyN'] = h.onNext;
    map['ArrowRight'] = h.onNext;
    map['Enter'] = h.onNext; // allow Enter to advance if focus not in input
  }
  if (h.onPrev) {
    map['KeyP'] = h.onPrev;
    map['ArrowLeft'] = h.onPrev;
  }
  if (h.onSpeak) {
    map['KeyS'] = h.onSpeak;
  }
  if (h.onAutoAdvanceToggle) {
    map['KeyA'] = h.onAutoAdvanceToggle;
  }

  // Extra user-provided bindings
  if (Array.isArray(h.extra)) {
    for (const item of h.extra) {
      if (!item || !Array.isArray(item.keys) || typeof item.handler !== 'function') continue;
      for (const k of item.keys) {
        if (typeof k === 'string' && k.length) map[k] = item.handler;
      }
    }
  }

  return map;
}

/**
 * React hook: session hotkeys for the Runner modal.
 * @param {HotkeyHandler} handlers
 * @returns {{
 *  enable: () => void,
 *  disable: () => void,
 *  updateHandlers: (h: Partial<HotkeyHandler>) => void,
 *  bindings: Record<string, () => void>,
 *  isEnabled: boolean
 * }}
 */
export default function useSessionHotkeys(handlers = {}) {
  const [isEnabled, setEnabled] = useState(!!handlers.enabled);
  const liveHandlersRef = useRef(handlers);
  const preventRepeatRef = useRef(/** @type {Record<string, number>} */ ({}));

  // Keep a fresh ref of handlers without re-registering listeners
  useEffect(() => { liveHandlersRef.current = handlers; }, [handlers]);

  // Build the final binding map
  const bindings = useMemo(() => buildDefaultBindings(liveHandlersRef.current), [liveHandlersRef.current]);

  const onKeyDown = useCallback((e) => {
    // Ignore when disabled
    if (!isEnabled) return;

    // Ignore with modifiers (avoid conflict with OS/browser shortcuts)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Ignore if user is editing something
    if (isEditableTarget(e.target)) return;

    const id = keyId(e);
    const handler = bindings[id] || bindings[e.key] || null;
    if (!handler) return;

    // Debounce native key repeat: only allow one fire per key per press
    const stamp = e.timeStamp || Date.now();
    const last = preventRepeatRef.current[id] || 0;
    if (stamp - last < 30) return; // small guard for fast repeats
    preventRepeatRef.current[id] = stamp;

    // Prevent default for our core keys to avoid scrolling/other side-effects
    if (id === 'Space' || id === 'ArrowRight' || id === 'ArrowLeft' || id === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
    }

    try { handler(); } catch (err) {
      // Fail-safe: never crash on a hotkey
      // eslint-disable-next-line no-console
      console.warn('[useSessionHotkeys] handler error for', id, err);
    }
  }, [isEnabled, bindings]);

  useEffect(() => {
    if (!isEnabled) return;
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isEnabled, onKeyDown]);

  // Public controls
  const enable = useCallback(() => setEnabled(true), []);
  const disable = useCallback(() => setEnabled(false), []);
  const updateHandlers = useCallback((h) => {
    // Merge new partial handlers into the live ref; bindings recompute on next render
    liveHandlersRef.current = { ...liveHandlersRef.current, ...(h || {}) };
  }, []);

  return { enable, disable, updateHandlers, bindings, isEnabled };
}
