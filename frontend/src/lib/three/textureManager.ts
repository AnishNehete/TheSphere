import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type WebGLRenderer,
} from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

export type GlobeTextureKey = "day" | "night" | "normal" | "specular" | "clouds" | "stars";

export interface GlobeTextureSet {
  day: Texture;
  night: Texture;
  normal: Texture;
  specular: Texture;
  clouds: Texture;
  stars: Texture;
}

interface EarthTextureManifestEntry {
  path: string;
  ktx2?: string | null;
}

type EarthTextureManifest = Record<GlobeTextureKey, EarthTextureManifestEntry>;

interface LoadGlobeTexturesOptions {
  maxAnisotropy?: number;
  renderer?: WebGLRenderer | null;
  ktx2TranscoderPath?: string | null;
}

const MANIFEST_PATH = "/earth/manifest.json";
const DEFAULT_TEXTURE_PATHS: Record<GlobeTextureKey, string> = {
  day: "/earth/day.jpg",
  night: "/earth/night.jpg",
  normal: "/earth/normal.jpg",
  specular: "/earth/specular.jpg",
  clouds: "/earth/clouds.png",
  stars: "/earth/stars.jpg",
};

const cachedTexturesPromises = new Map<string, Promise<GlobeTextureSet>>();
let resolvedManifestPromise: Promise<EarthTextureManifest> | null = null;

function isBrowser() {
  return typeof window !== "undefined";
}

function getFallbackManifest(): EarthTextureManifest {
  return Object.fromEntries(
    (Object.keys(DEFAULT_TEXTURE_PATHS) as GlobeTextureKey[]).map((key) => [
      key,
      {
        path: DEFAULT_TEXTURE_PATHS[key],
        ktx2: null,
      },
    ])
  ) as EarthTextureManifest;
}

function configureColorTexture(texture: Texture, anisotropy: number) {
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

function configureDataTexture(texture: Texture, anisotropy: number) {
  texture.colorSpace = NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

function parseLoadOptions(maxAnisotropyOrOptions: number | LoadGlobeTexturesOptions) {
  if (typeof maxAnisotropyOrOptions === "number") {
    return {
      maxAnisotropy: maxAnisotropyOrOptions,
      renderer: null,
      ktx2TranscoderPath: null,
    };
  }

  return {
    maxAnisotropy: maxAnisotropyOrOptions.maxAnisotropy ?? 8,
    renderer: maxAnisotropyOrOptions.renderer ?? null,
    ktx2TranscoderPath: maxAnisotropyOrOptions.ktx2TranscoderPath ?? null,
  };
}

async function resolveTextureManifest(): Promise<EarthTextureManifest> {
  if (resolvedManifestPromise) {
    return resolvedManifestPromise;
  }

  if (!isBrowser()) {
    return getFallbackManifest();
  }

  resolvedManifestPromise = (async () => {
    try {
      const response = await fetch(MANIFEST_PATH, {
        cache: "no-store",
      });
      if (!response.ok) {
        return getFallbackManifest();
      }

      const raw = (await response.json()) as Partial<Record<GlobeTextureKey, Partial<EarthTextureManifestEntry>>>;
      const fallback = getFallbackManifest();
      return {
        day: {
          path: raw.day?.path ?? fallback.day.path,
          ktx2: raw.day?.ktx2 ?? null,
        },
        night: {
          path: raw.night?.path ?? fallback.night.path,
          ktx2: raw.night?.ktx2 ?? null,
        },
        normal: {
          path: raw.normal?.path ?? fallback.normal.path,
          ktx2: raw.normal?.ktx2 ?? null,
        },
        specular: {
          path: raw.specular?.path ?? fallback.specular.path,
          ktx2: raw.specular?.ktx2 ?? null,
        },
        clouds: {
          path: raw.clouds?.path ?? fallback.clouds.path,
          ktx2: raw.clouds?.ktx2 ?? null,
        },
        stars: {
          path: raw.stars?.path ?? fallback.stars.path,
          ktx2: raw.stars?.ktx2 ?? null,
        },
      };
    } catch {
      return getFallbackManifest();
    }
  })();

  return resolvedManifestPromise;
}

async function loadWithTextureLoader(path: string) {
  const loader = new TextureLoader();
  return loader.loadAsync(path);
}

async function loadTexture(
  entry: EarthTextureManifestEntry,
  options: ReturnType<typeof parseLoadOptions>
) {
  if (entry.ktx2 && options.renderer && options.ktx2TranscoderPath) {
    const loader = new KTX2Loader();
    loader.setTranscoderPath(options.ktx2TranscoderPath);
    loader.detectSupport(options.renderer);
    try {
      const texture = await loader.loadAsync(entry.ktx2);
      loader.dispose();
      return texture;
    } catch {
      loader.dispose();
    }
  }

  return loadWithTextureLoader(entry.path);
}

async function loadTextureSet(manifest: EarthTextureManifest, options: ReturnType<typeof parseLoadOptions>): Promise<GlobeTextureSet> {
  const [day, night, normal, specular, clouds, stars] = await Promise.all(
    (Object.keys(DEFAULT_TEXTURE_PATHS) as GlobeTextureKey[]).map((key) => loadTexture(manifest[key], options))
  );

  configureColorTexture(day, options.maxAnisotropy);
  configureColorTexture(night, options.maxAnisotropy);
  configureDataTexture(normal, options.maxAnisotropy);
  configureDataTexture(specular, options.maxAnisotropy);
  configureDataTexture(clouds, options.maxAnisotropy);
  configureColorTexture(stars, options.maxAnisotropy);

  return {
    day,
    night,
    normal,
    specular,
    clouds,
    stars,
  };
}

export async function loadGlobeTextures(maxAnisotropyOrOptions: number | LoadGlobeTexturesOptions = 8): Promise<GlobeTextureSet> {
  const options = parseLoadOptions(maxAnisotropyOrOptions);
  const cacheKey = "default";
  const existingPromise = cachedTexturesPromises.get(cacheKey);
  if (existingPromise) {
    const textures = await existingPromise;
    setTextureAnisotropy(textures, options.maxAnisotropy);
    return textures;
  }

  const loadPromise = (async () => {
    const manifest = await resolveTextureManifest();
    return loadTextureSet(manifest, options);
  })();

  cachedTexturesPromises.set(cacheKey, loadPromise);

  try {
    const textures = await loadPromise;
    setTextureAnisotropy(textures, options.maxAnisotropy);
    return textures;
  } catch (error) {
    cachedTexturesPromises.delete(cacheKey);
    throw error;
  }
}

export function setTextureAnisotropy(textures: GlobeTextureSet, maxAnisotropy: number) {
  const anisotropy = Math.max(1, maxAnisotropy);
  textures.day.anisotropy = anisotropy;
  textures.night.anisotropy = anisotropy;
  textures.normal.anisotropy = anisotropy;
  textures.specular.anisotropy = anisotropy;
  textures.clouds.anisotropy = anisotropy;
  textures.stars.anisotropy = anisotropy;
}

export function getGlobeTexturePath(key: GlobeTextureKey) {
  return DEFAULT_TEXTURE_PATHS[key];
}
