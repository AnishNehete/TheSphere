import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AlertRuleQuickAdd } from "@/components/workspace/AlertRuleQuickAdd";

interface ScriptedFetch {
  status?: number;
  body?: unknown;
}

function installFetchMock(script: ScriptedFetch = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify(script.body ?? { id: "alrt_1", name: "ok" }),
      {
        status: script.status ?? 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("AlertRuleQuickAdd", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  it("posts a posture_band_change rule for the bound symbol", async () => {
    const fetchMock = installFetchMock();
    render(<AlertRuleQuickAdd symbol="AAPL" assetClass="equities" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("alert-quick-add-band"));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/intelligence/alerts/rules");
    const body = JSON.parse((init?.body ?? "{}") as string);
    expect(body).toMatchObject({
      kind: "posture_band_change",
      symbol: "AAPL",
      asset_class: "equities",
    });
  });

  it("posts a confidence_drop rule and flips the saved affordance", async () => {
    installFetchMock();
    render(<AlertRuleQuickAdd symbol="MSFT" assetClass="equities" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("alert-quick-add-confidence"));
      await Promise.resolve();
    });

    const button = screen.getByTestId("alert-quick-add-confidence");
    expect(button.getAttribute("data-state")).toBe("saved");
    expect(button.textContent).toBe("Watching");
  });

  it("surfaces an error message inline when the save fails", async () => {
    installFetchMock({ status: 500, body: { detail: "boom" } });
    render(<AlertRuleQuickAdd symbol="AAPL" assetClass="equities" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("alert-quick-add-band"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("alert-quick-add-error")).toBeTruthy();
    expect(screen.getByTestId("alert-quick-add-band").getAttribute("data-state")).toBe(
      "error",
    );
  });
});
