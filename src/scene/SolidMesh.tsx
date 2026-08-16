/**
 * 生成された錯視立体のメッシュ表示（Task 5.1 / ADR-004 / US-001）。
 *
 * ## ジオメトリは ref から読む（ADR-004）
 *
 * `BufferGeometry` は React state ではなく `GeometryRef`（`{ current }`）で
 * 受け取る。ref への代入は再レンダリングを起こさないため、**いつ読み直すか**
 * は store の `status === 'success'` 購読で決める（App.tsx の `ViewportSlot`
 * と同じ配線）。この購読を省くと、生成が成功してもマウント時の null を
 * 読んだまま画面が更新されない。status の変化は生成完了・入力変更という
 * **離散イベント**なので、ここでの再レンダリングは 60fps を害さない
 * （カメラ操作では status は変化しない）。
 *
 * ## 破棄はパイプラインの責務（dispose={null}）
 *
 * ジオメトリの所有者は `useGenerationPipeline`（入力変更・差し替え時に
 * 前世代を `dispose()` する）。同じ参照は STL 出力（Task 5.3）も読むため、
 * R3F のアンマウント時自動 dispose に巻き込ませてはならない —
 * `dispose={null}` で自動破棄を止める。二重 dispose も、export が破棄済み
 * ジオメトリを読む事故も、これで起きない。
 */
import { useStudioStore } from '../store/useStudioStore'
import type { GeometryRef } from '../studio/useGenerationPipeline'

export interface SolidMeshProps {
  /** 生成パイプラインが公開するジオメトリ参照（ADR-004） */
  geometryRef: GeometryRef
}

/**
 * 錯視立体のメッシュ。生成結果がない間（初期化中・生成中・エラー）は
 * 何も描画しない。flatShading は CSG 断面のエッジをそのまま見せるため
 * （スムーズシェーディングは押し出し角柱の稜線をにじませ、シルエットの
 * 成立が視認しづらくなる）。
 */
export function SolidMesh(props: SolidMeshProps) {
  const status = useStudioStore((s) => s.status)
  const geometry = status === 'success' ? props.geometryRef.current : null
  if (geometry === null) return null
  return (
    <mesh geometry={geometry} dispose={null}>
      <meshStandardMaterial color="#cfcac1" roughness={0.6} metalness={0.05} flatShading />
    </mesh>
  )
}
