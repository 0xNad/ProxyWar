/**
 * Coverage for the Points modal's focus-trap + Escape fix (P1 t1-02,
 * pass-8 QA): Tab used to walk out of the modal into the background page,
 * and once it had, Escape stopped closing the modal at all (the div-
 * scoped `@keydown` handler this replaces only fired while focus was
 * still inside the dialog's own DOM subtree). Real `KeyboardEvent`
 * dispatches throughout — never a direct call into private handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGuestBootstrapGateForTests } from "../../../../../src/client/identity/GuestBootstrapGate";
import "../../../../../src/client/prediction/wagering/components/PointsLeaderboard";
import type { PremierePointsLeaderboard } from "../../../../../src/client/prediction/wagering/components/PointsLeaderboard";

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

function escape(): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("PremierePointsLeaderboard focus trap and Escape", () => {
  let invoker: HTMLButtonElement;
  let outsidePageControl: HTMLButtonElement;
  let modal: PremierePointsLeaderboard;

  beforeEach(async () => {
    resetGuestBootstrapGateForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          csrfToken: "csrf",
          leaderboard: {
            entries: [],
            totalRankedParticipants: 0,
            viewer: null,
          },
        }),
      })),
    );

    invoker = document.createElement("button");
    invoker.textContent = "Points";
    document.body.appendChild(invoker);

    // Stands in for a real page control OUTSIDE the modal — e.g. QA's
    // "Follow: Whole board" <select> that focus escaped onto.
    outsidePageControl = document.createElement("button");
    outsidePageControl.textContent = "Follow: Whole board";
    document.body.appendChild(outsidePageControl);

    modal = document.createElement(
      "premiere-points-leaderboard",
    ) as PremierePointsLeaderboard;
    document.body.appendChild(modal);
    invoker.focus();
    modal.open = true;
    await modal.updateComplete;
    // The trap activates in a microtask after render settles.
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    modal.remove();
    invoker.remove();
    outsidePageControl.remove();
    vi.unstubAllGlobals();
  });

  it("moves focus into the dialog on open", () => {
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab from walking focus out of the dialog into the background page", () => {
    const focusableInModal = Array.from(
      modal.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input, [tabindex]:not([tabindex='-1'])",
      ),
    );
    expect(focusableInModal.length).toBeGreaterThan(0);
    const last = focusableInModal[focusableInModal.length - 1];
    last.focus();

    tab();

    expect(document.activeElement).not.toBe(outsidePageControl);
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("still closes on Escape even after focus has escaped the dialog (the reported keyboard dead-end)", () => {
    // Force focus outside the modal directly — simulating the exact
    // escaped state QA reproduced, regardless of how it got there.
    outsidePageControl.focus();
    expect(document.activeElement).toBe(outsidePageControl);

    const closeHandler = vi.fn();
    modal.addEventListener("close", closeHandler);

    escape();

    expect(closeHandler).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the invoker once closed", async () => {
    const closeHandler = () => {
      modal.open = false;
    };
    modal.addEventListener("close", closeHandler);

    escape();
    await modal.updateComplete;
    await Promise.resolve();

    expect(document.activeElement).toBe(invoker);
  });
});
