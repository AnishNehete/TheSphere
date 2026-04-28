import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GithubStarCTA } from "@/components/workspace/GithubStarCTA";

describe("GithubStarCTA", () => {
  it("renders a secondary GitHub star anchor that opens in a new tab", () => {
    render(<GithubStarCTA />);
    const link = screen.getByTestId("github-star-cta");
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("https://github.com/")).toBe(true);
  });

  it("exposes an accessible label so it does not read as decorative", () => {
    render(<GithubStarCTA />);
    expect(
      screen.getByRole("link", { name: /Star Sphere on GitHub/i }),
    ).toBeInTheDocument();
  });
});
