/**
 * Shared modal focus-trap (P1 t1-02, pass-8 QA): the Points leaderboard
 * and the in-game Settings modal both let Tab walk out of the dialog into
 * the background page while it stayed visually open — a standard modal
 * dialog pattern violation, and for Points specifically, a full keyboard
 * dead-end once focus had escaped (its own Escape handler is scoped to a
 * `@keydown` on the dialog's own DOM subtree, so it stops firing the
 * instant focus leaves that subtree — see `PointsLeaderboard.ts`).
 *
 * `activateFocusTrap` is deliberately NOT keyed to "focus is still inside
 * the container right now" (a listener bound to the container itself has
 * exactly that blind spot): it installs a `document`-level, CAPTURE-phase
 * `keydown` listener, so it keeps working even after focus has already
 * escaped — the exact failure mode QA reproduced — and recovers by
 * pulling focus back in on the very next Tab/Shift+Tab press.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Deliberately style-based, not layout-based (`offsetParent`/
 * `getClientRects`): those reflect real box geometry, which requires an
 * actual layout pass a test environment (jsdom) never performs, making
 * every element "invisible" there regardless of real visibility.
 * `display`/`visibility`/`hidden` are the properties that actually
 * govern whether an element is focusable/tabbable in the first place, so
 * checking them directly is correct in both a real browser and a test.
 */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * Recursively collects focusable elements under `root`, crossing INTO any
 * shadow roots encountered (e.g. `<o-modal>`'s own shadow DOM, which
 * hosts its checkpoint-tab buttons) as well as ordinary light-DOM
 * children (e.g. content Lit slots into `<o-modal>` from a BaseModal
 * subclass's own `render()` — real DOM children of the custom element
 * regardless of where the browser visually reprojects them via
 * `<slot>`). A plain `container.querySelectorAll(...)` cannot see past a
 * shadow boundary at all, which is why this walks the tree by hand
 * instead.
 */
function collectFocusable(root: ParentNode, out: HTMLElement[]): void {
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.matches(FOCUSABLE_SELECTOR) && isVisible(child)) {
      out.push(child);
    }
    if (child.shadowRoot !== null) collectFocusable(child.shadowRoot, out);
    collectFocusable(child, out);
  }
}

function focusableDescendants(container: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  collectFocusable(container, out);
  return out;
}

export interface FocusTrapHandle {
  /** Removes the trap's listener and restores focus to the element that had it when the trap activated. */
  deactivate(): void;
}

/**
 * `document.activeElement` retargets to the shadow HOST (never the
 * actual focused element) whenever focus lives inside an open shadow
 * root (e.g. `<o-modal>`'s own tab buttons) — real, spec-defined
 * behavior, not a test-environment quirk. Recurses through
 * `.shadowRoot.activeElement` to find the true deepest focused element,
 * so the boundary check below isn't fooled into treating "focus is on a
 * shadow-hosted button" as "focus has escaped".
 */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Activates a focus trap scoped to `container`: moves focus to its first
 * focusable descendant (or `container` itself if it has none — e.g. a
 * still-loading dialog), then keeps Tab/Shift+Tab confined to
 * `container`'s focusable descendants until `deactivate()` runs, which
 * also restores focus to whatever had it beforehand (the modal's
 * invoker).
 */
export function activateFocusTrap(container: HTMLElement): FocusTrapHandle {
  const invoker =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const focusable = focusableDescendants(container);
  (focusable[0] ?? container).focus();

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const current = focusableDescendants(container);
    if (current.length === 0) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = current[0];
    const last = current[current.length - 1];
    const active = deepActiveElement();
    const activeIndex =
      active instanceof HTMLElement ? current.indexOf(active) : -1;
    if (event.shiftKey) {
      if (activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      }
    } else if (activeIndex === -1 || activeIndex === current.length - 1) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", handleKeyDown, true);

  return {
    deactivate(): void {
      document.removeEventListener("keydown", handleKeyDown, true);
      invoker?.focus();
    },
  };
}
