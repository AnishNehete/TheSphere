import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DomainIcon,
  SIGNAL_DOMAINS,
  categoryToDomain,
} from "@/components/workspace/DomainIcon";

describe("DomainIcon", () => {
  it("renders a glyph for every domain in SIGNAL_DOMAINS", () => {
    for (const domain of SIGNAL_DOMAINS) {
      const { container } = render(<DomainIcon domain={domain} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("data-domain")).toBe(domain);
    }
  });

  it("respects the size prop", () => {
    const { container } = render(<DomainIcon domain="news" size={32} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("32");
    expect(svg?.getAttribute("height")).toBe("32");
  });

  it("attaches a title element when title is provided for a11y", () => {
    const { container } = render(
      <DomainIcon domain="conflict" title="Conflict signal" />,
    );
    expect(container.querySelector("title")?.textContent).toBe(
      "Conflict signal",
    );
  });
});

describe("categoryToDomain", () => {
  it("maps backend categories to UI domains", () => {
    expect(categoryToDomain("news")).toBe("news");
    expect(categoryToDomain("stocks")).toBe("stocks");
    expect(categoryToDomain("markets")).toBe("stocks");
    expect(categoryToDomain("weather")).toBe("weather");
    expect(categoryToDomain("flights")).toBe("flights");
    expect(categoryToDomain("health")).toBe("health");
    expect(categoryToDomain("disease")).toBe("health");
    expect(categoryToDomain("conflict")).toBe("conflict");
  });

  it("returns null for categories outside the surfaced six", () => {
    expect(categoryToDomain("mood")).toBeNull();
    expect(categoryToDomain("currency")).toBeNull();
    expect(categoryToDomain("commodities")).toBeNull();
    expect(categoryToDomain("other")).toBeNull();
  });
});
