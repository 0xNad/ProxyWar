/**
 * Component coverage for `/build` — spec Stage 7 item 1 (the 7-step guided
 * flow) and item 4 (silent funnel instrumentation). Follows the
 * mount-into-jsdom + stubbed global fetch convention established in
 * `WatchPage.test.ts`/`LobbyPage.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${JSON.stringify(params)}`,
}));
vi.mock("../../../src/client/analytics/AnalyticsClient", () => ({
  analytics: { track: vi.fn(), trackVisitStart: vi.fn() },
}));
import "../../../src/client/publicapp/BuildPage";
import type { BuildPage } from "../../../src/client/publicapp/BuildPage";
import { analytics } from "../../../src/client/analytics/AnalyticsClient";

function mount(): BuildPage {
  const el = document.createElement("build-page") as BuildPage;
  document.body.append(el);
  return el;
}

/** Drains pending microtasks — deterministic, not a real-time wait. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function normalizedText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/build/emblem-preview")) {
      return new Response(
        JSON.stringify({
          ok: true,
          svg: "<svg>preview</svg>",
          primaryColor: "#112233",
          secondaryColor: "#445566",
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("/api/build/registration-submission")) {
      return new Response(
        JSON.stringify({
          ok: true,
          proposedAgent: { slug: "test-agent" },
          proposedBuilder: { slug: "test-builder" },
          emblemPreviewSvg: "<svg>preview</svg>",
          profileFileJson: '{"proposedAgent":{"slug":"test-agent"}}',
          githubIssueUrl: "https://github.com/0xNad/ProxyWar/issues/new?title=x",
        }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(analytics.track).mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("build-page", () => {
  it("renders Step 1 (object model) by default", async () => {
    const el = mount();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step1.heading");
    expect(normalizedText(el)).toContain("build_page.step1.builder_term");
  });

  it("tracks build_flow_started and build_step_reached for step 1 on mount", async () => {
    mount();
    await flushMicrotasks();
    expect(analytics.track).toHaveBeenCalledWith("build_flow_started");
    expect(analytics.track).toHaveBeenCalledWith("build_step_reached", {
      step: 1,
    });
  });

  it("advances to Step 2 via the stepper and reports the new step exactly once", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = el.querySelectorAll<HTMLButtonElement>(
      'button[aria-current]',
    );
    expect(stepButtons.length).toBe(7);
    stepButtons[1].click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step2.heading");
    const stepReachedCalls = vi.mocked(analytics.track).mock.calls.filter(
      ([name]) => name === "build_step_reached",
    );
    expect(stepReachedCalls.length).toBe(2);
    expect(stepReachedCalls[1]).toEqual(["build_step_reached", { step: 2 }]);
  });

  it("re-visiting an already-reported step does not fire a duplicate analytics event", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    stepButtons()[1].click();
    await flushMicrotasks();
    stepButtons()[0].click();
    await flushMicrotasks();
    stepButtons()[1].click();
    await flushMicrotasks();
    const stepReachedCalls = vi.mocked(analytics.track).mock.calls.filter(
      ([name]) => name === "build_step_reached",
    );
    // step 1 (mount) + step 2 (first visit) = 2, never a 3rd for the repeat visit
    expect(stepReachedCalls.length).toBe(2);
  });

  it("fires build_flow_started only when reaching step 1, not on later steps", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    for (let step = 2; step <= 7; step++) {
      stepButtons()[step - 1].click();
      await flushMicrotasks();
    }
    const flowStartedCalls = vi.mocked(analytics.track).mock.calls.filter(
      ([name]) => name === "build_flow_started",
    );
    expect(flowStartedCalls.length).toBe(1);
  });

  it("fires build_step_reached with { step: N } for every step", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    for (let step = 2; step <= 7; step++) {
      stepButtons()[step - 1].click();
      await flushMicrotasks();
    }
    for (let step = 1; step <= 7; step++) {
      expect(analytics.track).toHaveBeenCalledWith("build_step_reached", {
        step,
      });
    }
  });

  it("BuildFunnel migration equivalence: visiting steps 1-7 in order emits exactly one build_flow_started and 7 build_step_reached calls", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    for (let step = 2; step <= 7; step++) {
      stepButtons()[step - 1].click();
      await flushMicrotasks();
    }
    const calls = vi.mocked(analytics.track).mock.calls;
    const flowStartedCalls = calls.filter(
      ([name]) => name === "build_flow_started",
    );
    const stepReachedCalls = calls.filter(
      ([name]) => name === "build_step_reached",
    );
    expect(flowStartedCalls.length).toBe(1);
    expect(flowStartedCalls[0]).toEqual(["build_flow_started"]);
    expect(stepReachedCalls.length).toBe(7);
    expect(stepReachedCalls.map(([, context]) => context?.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("Next/Back buttons move between adjacent steps and disable at the ends", async () => {
    const el = mount();
    await flushMicrotasks();
    const back = () =>
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "common.back",
      )!;
    const next = () =>
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "build_page.next_step",
      )!;
    expect(back().disabled).toBe(true);
    next().click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step2.heading");
    expect(back().disabled).toBe(false);
  });

  it("Step 3: entering an Agent name fetches a live emblem preview", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const el = mount();
    await Promise.resolve();
    const stepButtons = el.querySelectorAll<HTMLButtonElement>(
      'button[aria-current]',
    );
    stepButtons[2].click();
    await Promise.resolve();
    const nameInput = el.querySelector<HTMLInputElement>(
      "form input:first-of-type",
    )!;
    nameInput.value = "Cyan Hellstar";
    nameInput.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    await flushMicrotasks();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/build/emblem-preview?slug=cyan-hellstar"),
      ),
    ).toBe(true);
    expect(el.querySelector('[style*="112233"]')).not.toBeNull();
  });

  it("Step 3: submitting the form shows the registration draft with a copy block and GitHub issue link", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = el.querySelectorAll<HTMLButtonElement>(
      'button[aria-current]',
    );
    stepButtons[2].click();
    await flushMicrotasks();
    const form = el.querySelector("form")!;
    const agentNameInput = form.querySelector<HTMLInputElement>(
      "input:first-of-type",
    )!;
    agentNameInput.value = "Cyan Hellstar";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/build/registration-submission"),
      ),
    ).toBe(true);
    expect(normalizedText(el)).toContain("build_page.step3.result_heading");
    const issueLink = el.querySelector<HTMLAnchorElement>(
      'a[href^="https://github.com/0xNad/ProxyWar/issues/new"]',
    );
    expect(issueLink).not.toBeNull();
    expect(analytics.track).toHaveBeenCalledWith("registration_draft_submitted");
  });

  it("never sends a verifiedGithub field in the submission request body", async () => {
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[2].click();
    await flushMicrotasks();
    const form = el.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();
    const submissionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/build/registration-submission"),
    );
    expect(submissionCall).toBeDefined();
    const [, init] = submissionCall as [RequestInfo, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("verifiedGithub");
    expect(body).toHaveProperty("claimedGithub");
  });

  it("Step 3: a space-containing GitHub username shows the field-level error, never the generic banner, and never hits the network (2026-08-01 P1 fix)", async () => {
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[2].click();
    await flushMicrotasks();
    const form = el.querySelector("form")!;
    const githubInput = form.querySelector<HTMLInputElement>(
      'input[maxlength="39"]',
    )!;
    githubInput.value = "James Botts";
    githubInput.dispatchEvent(new Event("input"));
    await flushMicrotasks();
    // Live validation already flags it before any submit attempt.
    expect(normalizedText(el)).toContain("build_page.step3.github_error_format");

    fetchMock.mockClear();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/build/registration-submission"),
      ),
    ).toBe(false);
    expect(normalizedText(el)).toContain("build_page.step3.github_error_format");
    expect(normalizedText(el)).not.toContain("build_page.step3.submit_error");
  });

  it("Step 3: leaving the optional GitHub username field empty still succeeds", async () => {
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[2].click();
    await flushMicrotasks();
    const form = el.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();
    const submissionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/build/registration-submission"),
    );
    expect(submissionCall).toBeDefined();
    const [, init] = submissionCall as [RequestInfo, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.claimedGithub).toBeNull();
    expect(normalizedText(el)).toContain("build_page.step3.result_heading");
    expect(normalizedText(el)).not.toContain(
      "build_page.step3.github_error_format",
    );
  });

  it("Step 3: a server 400 naming claimedGithub renders the field-level error, never the generic banner (defense in depth)", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/build/registration-submission")) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "invalid_submission",
            field: "claimedGithub",
            reason: "format",
          }),
          { status: 400 },
        );
      }
      return new Response(null, { status: 404 });
    });
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[2].click();
    await flushMicrotasks();
    const form = el.querySelector("form")!;
    const githubInput = form.querySelector<HTMLInputElement>(
      'input[maxlength="39"]',
    )!;
    githubInput.value = "octocat";
    githubInput.dispatchEvent(new Event("input"));
    await flushMicrotasks();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step3.github_error_format");
    expect(normalizedText(el)).not.toContain("build_page.step3.submit_error");
  });

  it("Step 6 renders the verify checklist without any dead/fabricated command", async () => {
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[5].click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step6.profile_mapped");
    expect(normalizedText(el)).toContain("build_page.step6.mapping_explainer");
  });

  it("Step 4: signs in with the starter-documented softmax-cli command, never the broken 'uv run softmax login' (live P0, 2026-08-02)", async () => {
    // Confirmed against the actual published starter repo
    // (github.com/0xNad/proxywar-coworld-starter/ONBOARDING.md's
    // Troubleshooting table): "uvx --from softmax-cli softmax login" is
    // the documented redo-manually form. "uv run softmax login" needs an
    // existing uv project (pyproject.toml/venv) a fresh clone never has.
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[3].click();
    await flushMicrotasks();
    const text = normalizedText(el);
    expect(text).toContain("uvx --from softmax-cli softmax login");
    expect(text).not.toContain("uv run softmax login");
  });

  it("Step 4/5 cross-reference the coworld CLI and launch.sh as two named, related tools instead of two silent parallel toolchains (live P0, 2026-08-02)", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    stepButtons()[3].click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step4.toolchain_note");
    stepButtons()[4].click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain(
      "build_page.step5.enter_toolchain_note",
    );
    // Step 5's own launch.sh command is unchanged and does not repeat the
    // Step 4 sign-in step (launch.sh signs itself in).
    expect(normalizedText(el)).not.toContain("softmax login");
  });

  it("Step 6/7 hyperlink softmax.com/observatory instead of leaving it as bare unlinked text (live P0, 2026-08-02)", async () => {
    const el = mount();
    await flushMicrotasks();
    const stepButtons = () =>
      el.querySelectorAll<HTMLButtonElement>('button[aria-current]');
    stepButtons()[5].click();
    await flushMicrotasks();
    const step6Link = el.querySelector<HTMLAnchorElement>(
      'a[href="https://softmax.com/observatory"]',
    );
    expect(step6Link).not.toBeNull();
    expect(step6Link?.textContent?.trim()).toBe("softmax.com/observatory");

    stepButtons()[6].click();
    await flushMicrotasks();
    const step7Link = el.querySelector<HTMLAnchorElement>(
      'a[href="https://softmax.com/observatory"]',
    );
    expect(step7Link).not.toBeNull();
    expect(normalizedText(el)).toContain(
      "build_page.step7.observatory_explainer",
    );
  });
});
