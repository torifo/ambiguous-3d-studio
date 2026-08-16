import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base + worker.format are mandated by design.md "Deployment — GitHub Pages":
// - base: GitHub Pages serves under /ambiguous-3d-studio/; without it, assets
//   (including the manifold.wasm emitted via `?url`) 404 in production only.
// - worker.format 'es': the CSG worker uses ES imports; 'iife' breaks it.
// Do not remove or change either option (Task 1.1 / Task 3.1-3.2 contract).
export default defineConfig({
  plugins: [react()],
  base: '/ambiguous-3d-studio/',
  worker: { format: 'es' },
})
