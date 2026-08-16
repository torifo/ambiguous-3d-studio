import { describe, expect, it } from 'vitest'
import {
  clampHeightMm,
  DEFAULT_HEIGHT_MM,
  glbUsdzMetersPerUnit,
  HEIGHT_STEP_MM,
  MAX_HEIGHT_MM,
  METERS_PER_MM,
  MIN_HEIGHT_MM,
  realWorldSizeMm,
  stlMmPerUnit,
} from './scale'

describe('FR-029 の定数', () => {
  it('既定 60mm・範囲 10〜300mm・刻み 1mm', () => {
    expect(DEFAULT_HEIGHT_MM).toBe(60)
    expect(MIN_HEIGHT_MM).toBe(10)
    expect(MAX_HEIGHT_MM).toBe(300)
    expect(HEIGHT_STEP_MM).toBe(1)
  })
})

describe('clampHeightMm — mm 範囲の強制（10〜300）', () => {
  it('下限未満は 10 に丸める', () => {
    expect(clampHeightMm(5)).toBe(10)
    expect(clampHeightMm(0)).toBe(10)
    expect(clampHeightMm(-100)).toBe(10)
  })

  it('上限超過は 300 に丸める', () => {
    expect(clampHeightMm(301)).toBe(300)
    expect(clampHeightMm(9999)).toBe(300)
  })

  it('範囲内は刻み 1mm に丸める', () => {
    expect(clampHeightMm(60)).toBe(60)
    expect(clampHeightMm(72.4)).toBe(72)
    expect(clampHeightMm(72.6)).toBe(73)
  })

  it('非有限値は既定値 60 に落とす', () => {
    expect(clampHeightMm(Number.NaN)).toBe(DEFAULT_HEIGHT_MM)
    expect(clampHeightMm(Number.POSITIVE_INFINITY)).toBe(DEFAULT_HEIGHT_MM)
  })
})

describe('stlMmPerUnit — STL は mm', () => {
  it('mmPerUnit = heightMm / H', () => {
    expect(stlMmPerUnit(60, 2)).toBe(30)
    expect(stlMmPerUnit(60, 1)).toBe(60)
    expect(stlMmPerUnit(120, 2)).toBe(60)
  })

  it('範囲外の heightMm を拒否する（10〜300 の強制）', () => {
    expect(() => stlMmPerUnit(9, 2)).toThrow(RangeError)
    expect(() => stlMmPerUnit(301, 2)).toThrow(RangeError)
    expect(() => stlMmPerUnit(Number.NaN, 2)).toThrow(RangeError)
  })

  it('不正な workingHeight を拒否する', () => {
    expect(() => stlMmPerUnit(60, 0)).toThrow(RangeError)
    expect(() => stlMmPerUnit(60, -1)).toThrow(RangeError)
    expect(() => stlMmPerUnit(60, Number.NaN)).toThrow(RangeError)
  })
})

describe('glbUsdzMetersPerUnit — GLB/USDZ は m（1000 倍 AR 事故の防止）', () => {
  it('GLB 係数は STL 係数のちょうど 1/1000', () => {
    // これが「AR で建物サイズになる」バグのテスト形。
    // STL(mm) と GLB(m) の倍率比は常に厳密に 1000 でなければならない。
    const cases: Array<[number, number]> = [
      [60, 2],
      [10, 1],
      [300, 2],
      [147, 3.7],
    ]
    for (const [heightMm, H] of cases) {
      const stl = stlMmPerUnit(heightMm, H)
      const glb = glbUsdzMetersPerUnit(heightMm, H)
      expect(glb).toBe(stl * 0.001)
      expect(stl / glb).toBeCloseTo(1000, 9)
    }
  })

  it('既定 60mm・H=2 のとき 0.03 m/unit', () => {
    expect(glbUsdzMetersPerUnit(60, 2)).toBeCloseTo(0.03, 12)
  })

  it('METERS_PER_MM は 0.001', () => {
    expect(METERS_PER_MM).toBe(0.001)
  })

  it('STL と同じ範囲チェックを共有する', () => {
    expect(() => glbUsdzMetersPerUnit(5, 2)).toThrow(RangeError)
    expect(() => glbUsdzMetersPerUnit(60, 0)).toThrow(RangeError)
  })
})

describe('realWorldSizeMm — UI 表示用の実寸 X/Y/Z', () => {
  it('正規化済み bbox（Y 範囲 = H）なら y = heightMm', () => {
    // H = 2 の作業座標系：Y は [-1, 1]、X は [-1, 1]、Z は [-0.5, 0.5]
    const bounds = {
      min: { x: -1, y: -1, z: -0.5 },
      max: { x: 1, y: 1, z: 0.5 },
    }
    const size = realWorldSizeMm(bounds, 60, 2)
    expect(size.x).toBeCloseTo(60, 9)
    expect(size.y).toBeCloseTo(60, 9)
    expect(size.z).toBeCloseTo(30, 9)
  })

  it('THREE.Box3 互換の形（min/max の x,y,z）だけで動く', () => {
    const size = realWorldSizeMm(
      { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
      100,
      2,
    )
    expect(size).toEqual({ x: 50, y: 100, z: 150 })
  })
})
