import { describe, expect, it } from 'vitest'
import type { Contour, PreflightReport, SilhouetteSource } from './types'

// Wave 1 sanity test: the shared types compile and behave as data.
// Real geometry tests arrive with Wave 2 (normalize / preflight / presets).
describe('geometry/types', () => {
  it('Contour holds a flat, even-length point buffer', () => {
    const square: Contour = {
      points: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]),
      isHole: false,
    }
    expect(square.points.length % 2).toBe(0)
    expect(square.points.length / 2).toBeGreaterThanOrEqual(3)
    expect(square.isHole).toBe(false)
  })

  it('SilhouetteSource discriminates on kind', () => {
    const source: SilhouetteSource = { kind: 'preset', id: 'square' }
    expect(source.kind).toBe('preset')

    const report: PreflightReport = {
      ok: true,
      sharedYRange: [-0.5, 0.5],
      emptyBands: [],
      estimatedComponents: 1,
      warnings: [],
    }
    expect(report.warnings).toHaveLength(0)
  })
})
