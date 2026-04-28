# Earth Texture Contract

The globe keeps one fixed filename contract from `/public/earth`.

- `day.jpg`
- `night.jpg`
- `normal.jpg`
- `specular.jpg`
- `clouds.png`
- `stars.jpg`

Recommended source targets for the upgraded render path:

- NASA Blue Marble for the Earth day map
- NASA Black Marble for night lights
- Solar System Scope for normal, specular, and cloud source maps
- 8K for Earth surface maps, 4K for clouds

`src/lib/three/textureManager.ts` is the only loader. The runtime no longer probes `.ktx2` companions, so the filenames above are the complete contract and the only paths the frontend will request.
