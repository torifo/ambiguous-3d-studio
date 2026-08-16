import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { switchToFreeMode, viewpointSection, waitForGenerationSuccess } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_SVG = path.join(__dirname, 'fixtures', 'external-refs.svg')

/**
 * scenario 5（Task 8.2）: NFR-030「外部送信ゼロ」/ FR-005。
 *
 * `<image href="https://…">`・外部 `<use>`・`<script>` を含む SVG を投入し、
 * ブラウザが一切のリクエストを origin の外へ送らないことを確認する。
 * `src/sources/svg.ts` はこれらを「取得せず破棄する」契約（同ファイルの
 * DISCARD_REASONS）を持つが、それを保証するのはパーサの実装ではなく
 * ブラウザが実際に何もフェッチしないという事実そのものなので、
 * ルート・インターセプトで直接観測する。
 */
test.describe('外部送信ゼロ（NFR-030 / FR-005）', () => {
  test('外部参照を含む SVG を読み込んでも origin の外へリクエストが出ない', async ({ page, baseURL }) => {
    if (baseURL === undefined) throw new Error('playwright.config.ts の use.baseURL が未設定です')
    const sameOrigin = new URL(baseURL).origin
    const externalRequests: string[] = []

    // 監視だけでなく、実際に外部へ出ようとしたリクエストは中断する
    // （観測が間に合わず本当に外部サーバへ届く事故を避ける二重の安全策）。
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (new URL(url).origin !== sameOrigin) {
        externalRequests.push(url)
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })

    await page.goto('/')
    await waitForGenerationSuccess(page, 20_000)
    await switchToFreeMode(page)

    const sectionA = viewpointSection(page, 'A')
    await sectionA.getByRole('tab', { name: 'SVG' }).click()
    await sectionA.locator('input[type="file"]').setInputFiles(FIXTURE_SVG)

    // アップロード後の状態が落ち着く（受理されて生成が進む、または拒否されて
    // 通知が出る）まで待つ。「生成中…」を抜けた時点で、パーサの同期的な処理
    // （閉パスの解析・外部参照の破棄判定）はすでに完了している
    await expect(page.getByRole('status')).not.toContainText('生成中…', { timeout: 10_000 })

    // 上の待機は「アプリ内の処理が終わったこと」しか保証しない。ここで見たいのは
    // 「何もフェッチされなかった」という不在の証明であり、条件待ちに変換できない
    // 性質の主張なので、最低限の猶予をおいて遅延フェッチが無いことも確認する
    // （固定 sleep を待機条件の代用にする話ではなく、不在の確認に必要な猶予）
    await page.waitForTimeout(1000)

    expect(externalRequests, `origin 外へのリクエストが発生しました: ${JSON.stringify(externalRequests)}`).toEqual([])
  })
})
