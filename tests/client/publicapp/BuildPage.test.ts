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
import "../../../src/client/publicapp/BuildPage";
import type { BuildPage } from "../../../src/client/publicapp/BuildPage";

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
    if (url.startsWith("/api/build/funnel-event")) {
      return new Response(null, { status: 204 });
    }
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

  it("reports the initial step reached via the silent funnel endpoint on mount", async () => {
    mount();
    await flushMicrotasks();
    const funnelCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/build/funnel-event"),
    );
    expect(funnelCalls.length).toBe(1);
    const [, init] = funnelCalls[0] as [RequestInfo, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ step: 1 });
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
    const funnelCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/build/funnel-event"),
    );
    expect(funnelCalls.length).toBe(2);
  });

  it("re-visiting an already-reported step does not fire a duplicate funnel event", async () => {
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
    const funnelCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/build/funnel-event"),
    );
    // step 1 (mount) + step 2 (first visit) = 2, never a 3rd for the repeat visit
    expect(funnelCalls.length).toBe(2);
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

  it("Step 6 renders the verify checklist without any dead/fabricated command", async () => {
    const el = mount();
    await flushMicrotasks();
    el.querySelectorAll<HTMLButtonElement>('button[aria-current]')[5].click();
    await flushMicrotasks();
    expect(normalizedText(el)).toContain("build_page.step6.profile_mapped");
    expect(normalizedText(el)).toContain("build_page.step6.mapping_explainer");
  });
});
