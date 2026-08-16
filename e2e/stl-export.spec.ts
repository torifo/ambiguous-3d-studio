import * as fs from 'node:fs'

import { expect, test } from '@playwright/test'

import { verifyStlBytes } from '../src/export/verifyStl'
import { DEFAULT_HEIGHT_MM } from '../src/studio/scale'
import { switchToFreeMode, waitForGenerationSuccess } from './helpers'

/**
 * scenario 4（Task 8.2）: STL ダウンロード + 読み戻し検証。
 *
 * design.md「Testing Strategy → STL 検証」が明言するとおり、ヘッダ検査だけでは
 * 「バイナリ STL としてシリアライズできた」ことしか示さない。ここでは実際に
 * ダウンロードされたバイト列を `src/export/verifyStl.ts` の
 * `verifyStlBytes`（純関数・DOM 非依存）で読み戻し、位相と寸法を検証する。
 * `verifyStlBytes` 自体は src/export/verifyStl.test.ts が単体で検証済みなので、
 * ここで見るのは「実ブラウザでのダウンロード発火 → 実バイト列」の配線だけでよい。
 */
test.describe('STL 出力（FR-030 / NFR-010 / NFR-011）', () => {
  test('ダウンロードしたバイト列を読み戻し、位相・寸法を検証する', async ({ page }) => {
    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)
    await switchToFreeMode(page)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'STL 出力' }).click(),
    ])

    const path = await download.path()
    if (path === null) throw new Error('ダウンロードされたファイルのローカルパスが取得できませんでした')
    const bytes = new Uint8Array(fs.readFileSync(path))

    // FR-029: 既定の実寸高さ（60mm、台座なし）。台座はこの高さに含まれないので
    // （store の options.baseplate 既定は無効）、bbox の Y 幅はそのまま heightMm と一致するはず
    const report = verifyStlBytes(bytes, { heightMm: DEFAULT_HEIGHT_MM })

    console.log('--- STL verification report ---')
    console.log(`triangles: ${report.triangleCount}`)
    console.log(`bounds: ${JSON.stringify(report.bounds)}`)
    console.log(`issues: ${JSON.stringify(report.issues)}`)

    expect(report.issues, `STL 検証で問題が見つかりました: ${JSON.stringify(report.issues)}`).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.triangleCount).toBeGreaterThan(0)
    expect(report.bounds).not.toBeNull()
  })
})
