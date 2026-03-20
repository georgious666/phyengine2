# Harmonic Manifold Renderer

Standalone WebGPU visualization app for field-native hybrid rendering:

- canonical state lives in complex field `psi`
- visible surface is a point shell constrained to the density level-set
- local shell continuity is reconstructed through point-SDF metrics
- volume and shell are composed in real time in the browser

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm test`

## Project Layout

- `src/app`: React UI, preset browser, inspector, viewport host
- `src/engine`: field math, surface tracker, engine facade, WebGPU orchestration
- `src/shaders`: WGSL compute and render passes
