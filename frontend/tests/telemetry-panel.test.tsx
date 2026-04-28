import { Texture, TextureLoader } from "three";
import { afterEach, beforeEach, vi } from "vitest";

describe("textureManager", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads textures once and serves from cache on subsequent calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        day: { path: "/earth/day.jpg" },
        night: { path: "/earth/night.jpg" },
        normal: { path: "/earth/normal.jpg" },
        specular: { path: "/earth/specular.jpg" },
        clouds: { path: "/earth/clouds.png" },
        stars: { path: "/earth/stars.jpg" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const loadAsyncMock = vi
      .spyOn(TextureLoader.prototype, "loadAsync")
      .mockImplementation(async () => new Texture());

    const { loadGlobeTextures } = await import("@/lib/three/textureManager");
    const first = await loadGlobeTextures(4);
    const second = await loadGlobeTextures(16);

    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadAsyncMock).toHaveBeenCalledTimes(6);
  });

  it("falls back to the default Earth contract when the manifest is unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    const loadAsyncMock = vi
      .spyOn(TextureLoader.prototype, "loadAsync")
      .mockImplementation(async () => new Texture());

    const { loadGlobeTextures } = await import("@/lib/three/textureManager");
    await expect(loadGlobeTextures()).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadAsyncMock).toHaveBeenCalledTimes(6);
  });
});
