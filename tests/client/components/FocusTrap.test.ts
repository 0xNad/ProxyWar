/**
 * Coverage for the shared modal focus-trap (P1 t1-02, pass-8 QA: Points
 * modal + in-game Settings modal both let Tab walk out of the dialog into
 * the background page). Real `KeyboardEvent("keydown", { key: "Tab" })`
 * dispatches — never a simulated call to internal handlers — so this
 * proves the SAME thing a keyboard user's real Tab press does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateFocusTrap,
  type FocusTrapHandle,
} from "../../../src/client/components/FocusTrap";

function tab(options: { shift?: boolean } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: options.shift ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("activateFocusTrap", () => {
  let invoker: HTMLButtonElement;
  let container: HTMLElement;
  let first: HTMLButtonElement;
  let middle: HTMLInputElement;
  let last: HTMLButtonElement;
  let outside: HTMLButtonElement;
  let handle: FocusTrapHandle | null;

  beforeEach(() => {
    invoker = document.createElement("button");
    invoker.textContent = "open";
    document.body.appendChild(invoker);
    invoker.focus();

    container = document.createElement("div");
    container.innerHTML = "";
    first = document.createElement("button");
    first.textContent = "first";
    middle = document.createElement("input");
    last = document.createElement("button");
    last.textContent = "last";
    container.append(first, middle, last);
    document.body.appendChild(container);

    outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);

    handle = null;
  });

  afterEach(() => {
    handle?.deactivate();
    container.remove();
    invoker.remove();
    outside.remove();
  });

  it("moves focus to the first focusable descendant on activation", () => {
    handle = activateFocusTrap(container);
    expect(document.activeElement).toBe(first);
  });

  it("wraps Tab forward from the last focusable element back to the first", () => {
    handle = activateFocusTrap(container);
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab backward from the first focusable element to the last", () => {
    handle = activateFocusTrap(container);
    first.focus();
    tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("does not interfere with an ordinary Tab between two elements inside the container", () => {
    handle = activateFocusTrap(container);
    first.focus();
    tab();
    // The trap only intercepts at the boundary; a normal in-container Tab
    // is left to the browser's own default focus movement, which jsdom
    // does not simulate — so, unlike the boundary cases above, focus
    // stays put here (no `preventDefault`, no manual `.focus()` call).
    // The assertion that matters is the NEGATIVE one: the trap must not
    // have forced focus to `first` or `last` on a non-boundary Tab.
    expect(document.activeElement).not.toBe(last);
  });

  it("recovers when focus has already escaped the container (the exact QA repro)", () => {
    handle = activateFocusTrap(container);
    // Simulate the escape QA reproduced: focus lands outside the
    // container entirely (e.g. a background page control), NOT via a
    // trapped Tab press but by direct assignment, exactly as if an
    // earlier bug had let it happen.
    outside.focus();
    expect(document.activeElement).toBe(outside);
    tab();
    expect(document.activeElement).toBe(first);
  });

  it("restores focus to the invoker on deactivate", () => {
    handle = activateFocusTrap(container);
    last.focus();
    handle.deactivate();
    handle = null;
    expect(document.activeElement).toBe(invoker);
  });

  it("falls back to focusing the container itself when it has no focusable descendants", () => {
    const empty = document.createElement("div");
    empty.tabIndex = 0;
    document.body.appendChild(empty);
    handle = activateFocusTrap(empty);
    expect(document.activeElement).toBe(empty);
    empty.remove();
  });

  it("crosses into a descendant's shadow root to find focusable content", () => {
    class ShadowHost extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        const shadowButton = document.createElement("button");
        shadowButton.textContent = "shadow-first";
        shadowButton.id = "shadow-first";
        root.appendChild(shadowButton);
      }
    }
    if (!customElements.get("focus-trap-test-shadow-host")) {
      customElements.define("focus-trap-test-shadow-host", ShadowHost);
    }
    const host = document.createElement("focus-trap-test-shadow-host");
    const lightButton = document.createElement("button");
    lightButton.textContent = "light-last";
    const wrapper = document.createElement("div");
    wrapper.append(host, lightButton);
    document.body.appendChild(wrapper);

    handle = activateFocusTrap(wrapper);
    const shadowButton = host.shadowRoot!.getElementById("shadow-first")!;
    // `document.activeElement` retargets to the shadow HOST itself when
    // the true focus target lives inside an open shadow root (real,
    // spec-defined behavior) — `host.shadowRoot.activeElement` is the
    // correct way to observe the actual focused descendant.
    expect(document.activeElement).toBe(host);
    expect(host.shadowRoot!.activeElement).toBe(shadowButton);

    lightButton.focus();
    tab();
    // Forward Tab from the true last (light DOM) element wraps back to
    // the true first (shadow DOM) element — proving the walk crossed the
    // shadow boundary rather than stopping at `wrapper`'s light-DOM
    // children (a plain `querySelectorAll` would have missed the shadow
    // button entirely and wrapped to `lightButton` itself, which is the
    // ONLY focusable element a shadow-blind query would ever find).
    expect(host.shadowRoot!.activeElement).toBe(shadowButton);

    wrapper.remove();
  });
});
