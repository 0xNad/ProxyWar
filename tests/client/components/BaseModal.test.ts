/**
 * Coverage for BaseModal's shared focus-trap integration (P1 t1-02
 * family — the ~16 modals extending `BaseModal` all pick this up from
 * one place). A minimal fixture subclass exercises the REAL `BaseModal`
 * + REAL `<o-modal>` end to end, mirroring how every real subclass
 * (AccountModal, ClanModal, HelpModal, …) renders: content slotted into
 * `<o-modal>...</o-modal>`. Real `KeyboardEvent` dispatches throughout.
 */
import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/client/components/baseComponents/Modal";
import { BaseModal } from "../../../src/client/components/BaseModal";

@customElement("base-modal-fixture")
class BaseModalFixture extends BaseModal {
  render() {
    return html`
      <o-modal title="Fixture">
        <button id="fixture-first">first</button>
        <input id="fixture-middle" />
        <button id="fixture-last">last</button>
      </o-modal>
    `;
  }
}

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

describe("BaseModal shared focus trap", () => {
  let invoker: HTMLButtonElement;
  let outsidePageControl: HTMLButtonElement;
  let modal: BaseModalFixture;

  beforeEach(async () => {
    invoker = document.createElement("button");
    invoker.textContent = "open fixture modal";
    document.body.appendChild(invoker);

    outsidePageControl = document.createElement("button");
    outsidePageControl.textContent = "background page control";
    document.body.appendChild(outsidePageControl);

    modal = document.createElement("base-modal-fixture") as BaseModalFixture;
    document.body.appendChild(modal);
    await modal.updateComplete;

    invoker.focus();
    modal.open();
    // Waits for this element's render AND `<o-modal>`'s own independent
    // update cycle — exactly what `activateFocusTrapWhenReady` itself
    // awaits — before the trap has definitely activated.
    await modal.updateComplete;
    const oModal = modal.querySelector("o-modal") as unknown as {
      updateComplete: Promise<unknown>;
    };
    await oModal.updateComplete;
  });

  afterEach(() => {
    modal.remove();
    invoker.remove();
    outsidePageControl.remove();
  });

  it("moves focus into the modal's slotted content on open", () => {
    expect(modal.querySelector("#fixture-first")).toBe(document.activeElement);
  });

  it("wraps Tab forward from the last field back to the first, never onto the background page", () => {
    (modal.querySelector("#fixture-last") as HTMLElement).focus();
    tab();
    expect(document.activeElement).toBe(modal.querySelector("#fixture-first"));
    expect(document.activeElement).not.toBe(outsidePageControl);
  });

  it("wraps Shift+Tab backward from the first field to the last", () => {
    (modal.querySelector("#fixture-first") as HTMLElement).focus();
    tab({ shift: true });
    expect(document.activeElement).toBe(modal.querySelector("#fixture-last"));
  });

  it("restores focus to the invoker on close", () => {
    (modal.querySelector("#fixture-middle") as HTMLElement).focus();
    modal.close();
    expect(document.activeElement).toBe(invoker);
  });
});
