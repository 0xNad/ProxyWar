import { describe, expect, it, vi } from "vitest";
import { HostLobbyModal } from "../../src/client/HostLobbyModal";

/** Narrow view onto the private surface this test exercises. */
interface HostLobbyModalInternals {
  lobbyId: string;
  leaveLobbyOnClose: boolean;
  onClose(): void;
}

function internals(modal: HostLobbyModal): HostLobbyModalInternals {
  return modal as unknown as HostLobbyModalInternals;
}

describe("HostLobbyModal onClose URL reset", () => {
  it("does not reset the URL when the modal never hosted a lobby", () => {
    // Reproduces the "Go to the live market" SPA-transition livelock:
    // `Main.ts`'s post-join cleanup generically calls `.close()` on every
    // modal tag, including <host-lobby-modal>, even when the join was for
    // a totally unrelated premiere/game and this modal was never opened.
    // `lobbyId` is still its untouched initial "" in that case.
    const modal = new HostLobbyModal();
    const view = internals(modal);
    expect(view.lobbyId).toBe("");
    view.leaveLobbyOnClose = true;

    const replaceStateSpy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(modal, "dispatchEvent");

    view.onClose();

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "leave-lobby" }),
    );

    replaceStateSpy.mockRestore();
  });

  it("still resets the URL and leaves when a lobby WAS actually hosted", () => {
    const modal = new HostLobbyModal();
    const view = internals(modal);
    view.lobbyId = "ABCDEFGH";
    view.leaveLobbyOnClose = true;

    const replaceStateSpy = vi
      .spyOn(history, "replaceState")
      .mockImplementation(() => undefined);
    const dispatchSpy = vi.spyOn(modal, "dispatchEvent");

    view.onClose();

    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/");
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "leave-lobby" }),
    );

    replaceStateSpy.mockRestore();
  });

  it("does not leave/reset the URL when the caller explicitly opted out", () => {
    const modal = new HostLobbyModal();
    const view = internals(modal);
    view.lobbyId = "ABCDEFGH";
    view.leaveLobbyOnClose = false;

    const replaceStateSpy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(modal, "dispatchEvent");

    view.onClose();

    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "leave-lobby" }),
    );

    replaceStateSpy.mockRestore();
  });
});
