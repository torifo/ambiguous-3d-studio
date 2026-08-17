import type { SilhouetteSource } from '../geometry/types'

/**
 * 錯視立体カタログ（FR-100 / specs/ambiguous-solid/illusion-catalogue.md）。
 *
 * このアプリは「任意の 2 シルエットを交差させる汎用ジェネレーター」から
 * 「既知の錯視立体を再現・体験・出力するサイト」へ主従を入れ替える（FR-103）。
 * その主たる入口になるデータがこのモジュール。
 *
 * ## なぜ「作れないもの」も載せるのか
 *
 * 錯視立体という括りの中には、**まったく別の数理**が同居している。
 *
 * | 型 | 何が錯視を作っているか | 交差方式で扱えるか |
 * |---|---|---|
 * | 投影シルエット型（両義立体 / Visual Hull） | 視線方向ごとの**外形** | **扱える**（これが `M = M_A ∩ M_B`） |
 * | 遮蔽型（不可能図形） | 1 視点での前後関係と偽の接続 | 扱えない |
 * | 重力型 | 重力方向と実際の傾きのずれ | 扱えない |
 * | 視差型 | 凹凸の反転・運動視差の逆転 | 扱えない |
 *
 * CSG 交差エンジンが答えられるのは 1 行目だけである。この区別を示さないと、
 * ユーザーは「ペンローズの三角形も作れるはず」と期待して失望する。だから
 * `buildable: false` の項目も同じ型で持ち、UI では
 * **「なぜこの方式では作れないか」を主役に据えて**見せる。
 *
 * ## 依存の方針
 *
 * このモジュールは**データだけ**を持つ。ワーカー・パイプライン・ストア・UI・シーンには
 * 依存しない（プレーンな Node でテストできる状態を保つ）。参照するのは
 * `geometry/types` の {@link SilhouetteSource} のみ。
 */

/**
 * 錯視の分類。錯視を成立させている機構で分ける。
 * - `ambiguous`  両義立体。視線方向ごとに異なる**外形**を持たせる。この方式で作れる
 * - `impossible` 不可能図形。1 視点での遮蔽と偽の接続で成立する
 * - `gravity`    重力方向の誤認。傾きの知覚を突く
 * - `parallax`   凹凸の反転・運動視差の逆転。観察者が動くことで成立する
 */
export type IllusionCategory = 'ambiguous' | 'impossible' | 'gravity' | 'parallax'

/** 分類の全メンバー（UI のフィルタとテストの網羅チェック用） */
export const ILLUSION_CATEGORIES = [
  'ambiguous',
  'impossible',
  'gravity',
  'parallax',
] as const satisfies readonly IllusionCategory[]

/**
 * 再現設定。カタログ項目を選んだときにスタジオへ流し込む入力そのもの
 * （FR-100「WHEN ユーザーがカタログの項目を選ぶ THE SYSTEM SHALL その錯視を再現する
 * 入力を設定し、生成する」）。
 */
export interface IllusionPreset {
  /** 視点 A（正面から見える形） */
  a: SilhouetteSource
  /** 視点 B（側面から見える形） */
  b: SilhouetteSource
  /** 視点 C。三方向変身立体でのみ使う（FR-101） */
  c?: SilhouetteSource
  /** 視点 B の軸角（度）。既定 90 = 直交。45 はアンビギュアス・シリンダー系（FR-102） */
  axisAngleDeg?: number
  /**
   * 仮想ミラー（FR-024 / FR-102）。**装飾ではなく、この錯視の成立機構**
   * であるときだけ設定する（アンビギュアス・シリンダー／トランプマーク
   * の変身立体 — 「直接見える形」と「鏡に映る形」が異なって初めて成立する）。
   * 省略 = ミラーなし。`store/useStudioStore.ts` の `applyInput` が
   * `StudioInputSpec.mirror` としてそのまま読み、有効・無効とオフセットを
   * カタログ選択と同じトランザクションで確定させる（`ui/Gallery.tsx` は
   * `applyInput(entry.preset)` を構造そのまま渡すだけなので無編集で反映される）。
   * 向き（どちらを映すか）は axisAngleDeg から自動導出するため、ここでは
   * 有効化と任意のオフセットしか指定しない（scene/VirtualMirror.tsx）。
   */
  mirror?: { enabled: boolean; offset?: number }
}

/** カタログ 1 項目（specs/ambiguous-solid/illusion-catalogue.md「カタログ項目の定義」） */
export interface IllusionEntry {
  id: string
  /** 表示名（日本語） */
  name: string
  /** 原名 */
  originalName: string
  /** 分類 */
  category: IllusionCategory
  /** このアプリで生成できるか。false なら理由を示す */
  buildable: boolean
  /** 何が起きるか（現象） */
  phenomenon: string
  /** なぜそう見えるか（幾何学的機構） */
  mechanism: string
  /** buildable: false のときの、この方式で作れない理由 */
  notBuildableReason?: string
  /** buildable: true のときの再現設定 */
  preset?: IllusionPreset
  /** 出典・考案者 */
  credit?: string
  /**
   * 外部の参照先。原典の論文・作者のページ・解説など。
   *
   * カタログは「名前と機構のある作品」を扱う以上、**その先を辿れることが
   * 価値の一部**になる。ここで止まると、読んだ人は結局自分で検索し直す。
   *
   * `url` は**実在を確認したものだけ**を入れる。存在しない URL を載せるのは、
   * 出典を書かないことより悪い（読み手は確認済みだと受け取るため）。
   */
  references?: readonly IllusionReference[]
}

/** カタログ項目の外部参照先 */
export interface IllusionReference {
  /** 表示ラベル（日本語可）。何が読めるのかが分かる語にする */
  label: string
  /** 実在を確認済みの URL */
  url: string
  /** 補足（言語・形式など）。「PDF」「英語」など短く */
  note?: string
}

/** 生成できる項目。`preset` の存在が型で保証される */
export type BuildableIllusion = IllusionEntry & { buildable: true; preset: IllusionPreset }

/** 生成できない項目。`notBuildableReason` の存在が型で保証される */
export type UnbuildableIllusion = IllusionEntry & { buildable: false; notBuildableReason: string }

/**
 * 全 12 項目。**この配列の順序が表示順**である。
 * 作れるもの（A: 現エンジン → B: 拡張が要る）を先に、作れないもの（C）を後に置く。
 * 先頭は #12 影の両義立体 — これはこのアプリの数理そのもので、最初の 10 秒で
 * 「何を作る道具なのか」が伝わる。
 *
 * 番号（#）は仕様書の一覧の通し番号。
 */
export const ILLUSIONS: readonly IllusionEntry[] = [
  // ------------------------------------------------------------------ A: 現エンジンで作れる
  {
    id: 'shadow-ambiguous',
    name: '影の両義立体',
    originalName: 'Ambiguous Shadow',
    category: 'ambiguous',
    buildable: true,
    phenomenon:
      '1 つの立体に 2 方向から光を当てると、一方の壁に落ちる影が「1」、もう一方の壁に落ちる影が「2」に読める。立体そのものはどちらの文字にも似ていない。',
    mechanism:
      '平行光が落とす影は、その光線方向への平行投影であり、投影像は視線方向のシルエットと一致する。したがって「X 方向の影が 1・Y 方向の影が 2」という条件は、「X 方向のシルエットが 1・Y 方向のシルエットが 2」とまったく同じ条件になる。各シルエットを自身の視線方向へ押し出した角柱の共通部分 M = M₁ ∩ M₂ がこれを満たし、しかも条件を満たす立体のうち最大のものである（計算幾何ではこの集合を Visual Hull＝視体積交差と呼ぶ）。この項目は特別な実装ではなく、このアプリの生成処理そのもの。',
    preset: {
      a: { kind: 'text', value: '1', fontId: 'default' },
      b: { kind: 'text', value: '2', fontId: 'default' },
    },
    credit:
      '影で別の像を見せる作品には福田繁雄らの先例がある。投影シルエットの交差という定式化は Visual Hull（A. Laurentini, 1994）。',
    references: [
      {
        label: 'Visual hull（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Visual_hull',
        note: '英語。Laurentini (1994) の定式化の解説。原論文は有料',
      },
      {
        label: '福田繁雄（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Shigeo_Fukuda',
        note: '英語。影を使った作品の先例',
      },
    ],
  },
  {
    id: 'card-suits',
    name: 'トランプマークの変身立体',
    originalName: 'Ambiguous Object (Card Suits)',
    category: 'ambiguous',
    buildable: true,
    phenomenon:
      '正面から見ると♠に見える立体が、90° 回すと♥に見える。どちらの向きでもマークとして完全に読め、途中の角度では「どちらでもない何か」になる。',
    mechanism:
      '2 つのマークをそれぞれの視線方向へ押し出し、共通部分を取る。高さ y のスライスは「♠のその高さの断面 × ♥のその高さの断面」の直積なので、両方が幅を持つ高さでのみ立体が残る。♠♥♦♣ はどれも上から下まで途切れない 1 本の輪郭なので、高さ帯が全域で重なり、欠けのない立体になる — マークの組み合わせがこの方式と相性がよいのはこのため。プリセットには 4 マークすべてがあり、任意の 2 つに差し替えられる（♣ は 3 円の合併なので茎の高さで断面が 3 本に分かれ、♠♥ の組より痩せた立体になる）。',
    preset: {
      a: { kind: 'preset', id: 'spade' },
      b: { kind: 'preset', id: 'heart' },
      // 原典は「90° 回す」だが、このスタジオでは仮想ミラーが同じ驚きを
      // 手回し抜きで見せる — 正面に♠を見せたまま、鏡の中に♥が同時に映る
      mirror: { enabled: true },
    },
    credit: '杉原厚吉（明治大学）の「変身立体」シリーズに同種の作品がある。',
    references: [
      {
        label: '杉原厚吉「Card Marks Floating on a Mirror」講義動画',
        url: 'https://www.youtube.com/watch?v=cPnryV_99hQ',
        note: '動画・英語。本人による解説',
      },
    ],
  },
  {
    id: 'ambiguous-arrow',
    name: '左右反転矢印',
    originalName: 'Ambiguous Arrow',
    category: 'ambiguous',
    buildable: true,
    phenomenon:
      '右を指している矢印。鏡に映しても、水平に 90° 回しても、やはり右を指す。どちらを向けても「右」から逃げられない。',
    mechanism:
      '原典（杉原）は「直角優先バイアス」— 平行四辺形の稜線を直角として解釈してしまう脳の性質 — を使う別機構だが、両義立体として作り直せる。視点 A・B の両方に同じ右向き矢印を与えると、正面からも側面からも右向きの矢印に見える立体になる。矢印プリセットは左右非対称に作ってあり、この構成では鏡像かどうかが結果にそのまま出る（左右対称な図形を入れると、この「どちらから見ても右」という驚きは原理的に生じない）。',
    preset: {
      a: { kind: 'preset', id: 'arrow' },
      b: { kind: 'preset', id: 'arrow' },
    },
    credit: '杉原厚吉。原典は直角優先バイアスによるもので、ここでは両義立体として再構成している。',
    references: [
      {
        label: '杉原厚吉「Right-Facing Arrow」講義動画',
        url: 'https://www.youtube.com/watch?v=vGxTKpOt6xU',
        note: '動画・英語。本人による解説',
      },
      {
        label: 'Sugihara, "Anomalous Mirror Symmetry Generated by Optical Illusion" (Symmetry, 2016)',
        url: 'https://meiji.repo.nii.ac.jp/record/67/files/symmetry_8_4_275.pdf',
        note: 'PDF・英語。直角優先バイアスを使う原論文',
      },
    ],
  },

  // ------------------------------------------------------------------ B: エンジン拡張が要る
  {
    id: 'triply-ambiguous',
    name: '三方向変身立体',
    originalName: 'Triply Ambiguous Object',
    category: 'ambiguous',
    buildable: true,
    phenomenon: '3 つの異なる方向から見ると、3 つの異なる形に見える 1 つの立体。',
    mechanism:
      'M = M_A ∩ M_B ∩ M_C。2 軸交差の自然な一般化で、交差を 1 回増やすだけで済む。ただし適格な組み合わせは急に狭くなる。高さ y のスライスは、A と B の被覆の直積を C の断面で削った領域になる — C の押し出し軸は Y なので、C は「その高さの被覆」ではなく、高さに依らない固定の 2D 領域として横から削る。したがって A と B が同じ高さに被覆を持つだけでは足りず、その被覆が C の許す位置に重なっていなければならない。ここでは円・正方形・正三角形で組んである。実測では円と正方形は完全に再現され、正三角形は約 98%（底辺の両端が少し削れる）— 正規化後の三角形は正方形より横に広く、はみ出した分が落ちるため。3 面すべてを完全に再現する「互いに異なる 3 図形」は簡単には見つからない。これは実装の限界ではなく、三方向という条件そのものの厳しさであり、原典が最適化計算で形を探しているのもそのためである。',
    preset: {
      a: { kind: 'preset', id: 'circle' },
      b: { kind: 'preset', id: 'square' },
      c: { kind: 'preset', id: 'triangle' },
    },
    credit: '杉原厚吉「Triply Ambiguous Object」（2018）。',
    references: [
      {
        label: '杉原厚吉「How to Make Triply Ambiguous Objects」',
        url: 'https://www.isc.meiji.ac.jp/~kokichis/triplyambiguousobjects/howtomakeTriplyAmbiguouse.pdf',
        note: 'PDF・英語。本人による構造の解説',
      },
      {
        label: 'Best Illusion of the Year Contest 2018（1st Prize）',
        url: 'https://illusionoftheyear.com/2018/10/triply-ambiguous-object/',
        note: '英語',
      },
      {
        label: '「Triply Ambiguous Object」実演動画',
        url: 'https://www.youtube.com/watch?v=iA5zBZB2dng',
        note: '動画',
      },
    ],
  },
  {
    id: 'ambiguous-cylinder',
    name: 'アンビギュアス・シリンダー',
    originalName: 'Ambiguous Cylinder Illusion',
    category: 'ambiguous',
    buildable: true,
    phenomenon:
      '正面から見ると四角い筒。その奥に置いた鏡に映った姿は丸い筒。筒を 180° 回すと、直接見える形と鏡像が入れ替わる。',
    mechanism:
      '2 つの視線が直交ではなく、斜め 45°（およびその鏡像方向）で交わる。この 2 方向に対して、一方の投影が四角い輪郭、他方の投影が丸い輪郭になるように形を決める。斜交軸に対応すれば、交差の数理は直交のときと同じまま扱える（押し出し方向を XZ 平面内の任意角で再構成するだけ）。再現の範囲：ここで作るのは第 1 段階 — 45° の斜交軸で四角と丸を交差させた中実の立体である。原典は中空の筒で、上端の輪郭が空間曲線になっており、そこから壁を下ろした形をしている。この中空化は交差立体の上端リング曲線を取り出す別処理で、CSG パイプラインの外側になるため含めていない。中実でも「一方から四角・他方から丸」は成立するが、筒の縁が波打って見える原典の驚きはそこまでは含まない。',
    preset: {
      a: { kind: 'preset', id: 'square' },
      b: { kind: 'preset', id: 'circle' },
      axisAngleDeg: 45,
      // この項目の phenomenon（「その奥に置いた鏡に映った姿は丸い筒」）は
      // 鏡が実際に丸を映すことを前提に書かれている — 鏡は装飾ではなく
      // この錯視の成立機構そのものなので、選択した瞬間に自動で有効化する
      mirror: { enabled: true },
    },
    credit: '杉原厚吉「Ambiguous Cylinder Illusion」（2016）。',
    references: [
      {
        label: '杉原厚吉「Ambiguous Objects」本人ページ',
        url: 'https://www.isc.meiji.ac.jp/~kokichis/ambiguousc/ambiguouscylindere.html',
        note: '英語。構成キットと3Dデータ配布あり',
      },
      {
        label: '「Ambiguous Cylinder Illusion」実演動画',
        url: 'https://www.youtube.com/watch?v=oWfFco7K9v8',
        note: '動画。鏡像との違いは動きで見ないと伝わらない',
      },
    ],
  },

  // ------------------------------------------------------------------ C: この方式では作れない
  {
    id: 'penrose-triangle',
    name: 'ペンローズの三角形',
    originalName: 'Penrose Triangle',
    category: 'impossible',
    buildable: false,
    phenomenon:
      '3 本の角柱が互いに直角に接続して、閉じた三角形をなしているように見える。見えているとおりの解釈のままでは、3 次元空間に存在できない。',
    mechanism:
      '実体は端が離れた「開いた」立体で、ある 1 つの視点からのみ、離れた 2 つの端面が画像上でぴったり重なる。脳はその重なりを「接続」と受け取り、同時に「角柱は直方体・角は直角」という前提も保とうとするため、両立しない解釈に落ち着く。',
    notBuildableReason:
      '錯視を担っているのは外形ではなく、1 視点における遮蔽（どちらが手前か）と、そこで生じる偽の接続である。シルエット交差の入力は「その方向から見た外形」だけで、外形の内側にある角柱どうしの前後関係を書き込む場所がない。さらに交差立体は、与えた輪郭条件を満たす立体のうち最大のものである。この錯視に不可欠な「見た目には接しているが実際には離れている隙間」は、条件を満たす材料をすべて含むこの構成では必ず埋まる。正面のシルエットを三角形の枠にしても、得られるのは本当に閉じた普通の三角枠であり、視点を動かしても何も破綻しない — つまり驚きが起きない。',
    credit:
      'L. S. ペンローズ & R. ペンローズ（1958）。先行して O. ロイテルスヴァルド（1934）が同型の図を描いている。',
    references: [
      {
        label: 'ペンローズの三角形（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Penrose_triangle',
        note: '英語。1958年原論文は有料のため代替',
      },
      {
        label: 'オスカー・ロイテルスヴァルド（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Oscar_Reutersv%C3%A4rd',
        note: '英語。1934年の先行例',
      },
    ],
  },
  {
    id: 'penrose-staircase',
    name: 'ペンローズの階段',
    originalName: 'Penrose Stairs',
    category: 'impossible',
    buildable: false,
    phenomenon: '四角く一周する階段。ずっと上っているのに、一周すると元の高さに戻ってくる。',
    mechanism:
      '各辺は実際に上っているが、一周を閉じる 1 箇所で、高さの違う 2 つの段が特定の視点からのみ画像上で連続して見える。実体は途切れた螺旋で、その切れ目が視線方向に隠れている。',
    notBuildableReason:
      'ペンローズの三角形と同じ機構で、効いているのは「特定視点でだけ揃う段差の食い違い」と、その食い違いを隠す遮蔽である。シルエット交差が指定できるのは各方向の外形だけで、外形の内側で段がつながっているか食い違っているかは制約に入らない。加えて交差立体は輪郭条件を満たす最大の立体なので、錯視の要である螺旋の切れ目を埋めてしまう。切れ目のない階段は、どの視点から見ても矛盾のない、ただの螺旋階段になる。',
    credit:
      'L. S. ペンローズ & R. ペンローズ（1958）。M. C. エッシャー《上昇と下降》（1960）が広く知られる。',
    references: [
      {
        label: 'ペンローズの階段（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Penrose_stairs',
        note: '英語。1958年原論文は有料のため代替',
      },
      {
        label: 'エッシャー《上昇と下降》（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Ascending_and_Descending',
        note: '英語',
      },
    ],
  },
  {
    id: 'floating-roof',
    name: '宙に浮く屋根 / 突き抜ける柱',
    originalName: 'Impossible Objects (Floating Roof / Penetrating Column)',
    category: 'impossible',
    buildable: false,
    phenomenon:
      'ある方向から見ると柱が屋根をきちんと支えているのに、別の方向から見ると柱と屋根が離れている、あるいは柱が屋根を突き抜けている。',
    mechanism:
      '部材どうしの奥行き順序（どちらが手前か）を、視点ごとに読み違えさせる。1 つの視点では接触に見える位置関係が、実際には奥行き方向に離れている。',
    notBuildableReason:
      'この錯視の実体は部材間の前後関係だが、シルエットは前後関係を持たない — 手前の柱と奥の柱は、同じ 1 つの外形に潰れて区別できなくなる。交差の入力（各方向の外形）には奥行き順序を書き込む場所がなく、出力も「その外形を満たす最大の 1 つの塊」なので、離れた部材どうしの位置関係を独立に指定することもできない。両義立体が視点ごとに変えられるのは外形であって、部材の重なり方ではない。',
    credit: '不可能図形の立体化。杉原厚吉らによる制作例がある。',
  },
  {
    id: 'magnet-like-slopes',
    name: '何でも吸引するすべり台',
    originalName: 'Impossible Motion: Magnet-like Slopes',
    category: 'gravity',
    buildable: false,
    phenomenon:
      '中央の柱から四方へ伸びる樋。その上に置いた玉が、坂を上って中央の頂点へ吸い寄せられていくように見える。',
    mechanism:
      '実際にはすべての樋が中央へ向かって下っている。柱が鉛直に、接合部が直角に見える特定の視点を選ぶことで、脳が「柱は鉛直・面は水平」という前提から傾きを逆に読む。錯視の本体は、重力方向と実際の傾きのずれ。',
    notBuildableReason:
      'これは投影シルエットの一致ではなく、重力方向の誤認である。交差方式が指定できるのは「各方向から見た外形」だけで、傾きの誤読を誘導する条件 — たった 1 つの正しい視点、鉛直に見える支柱、そして実際に働く重力 — はどれも外形の制約に還元できない。しかも効果は転がる玉という運動と、単一の視点に依存する。この方式が出力できるのは 1 つの立体の形であって、視点と運動と重力を含む場面ではない。',
    credit:
      '杉原厚吉「Impossible Motion: Magnet-like Slopes」（2010 年ベスト錯覚コンテスト優勝）。',
    references: [
      {
        label: 'Best Illusion of the Year Contest 2010（1st Prize）',
        url: 'https://illusionoftheyear.com/2010/05/impossible-motion-magnet-like-slopes/',
        note: '英語。公式の受賞ページ',
      },
      {
        label: '「Impossible Motion: Magnet-like Slopes」実演動画',
        url: 'https://www.youtube.com/watch?v=hAXm0dIuyug',
        note: '動画',
      },
    ],
  },
  {
    id: 'antigravity-slope',
    name: '反重力スロープ',
    originalName: 'Anti-gravity Slope',
    category: 'gravity',
    buildable: false,
    phenomenon: '実際には下っている坂が上って見え、置いた物が坂を上っていくように見える。',
    mechanism:
      '周囲の柱・手すり・背景がもつ遠近手がかりが、水平の基準を偽装する。傾きの判断は坂そのものではなく周囲の文脈から作られるため、文脈を歪めれば坂の符号が反転して知覚される。',
    notBuildableReason:
      '「何でも吸引するすべり台」と同じ重力方向の誤認だが、こちらは錯視の担い手が立体そのものよりも周囲の文脈にある。坂の形を寸分違わず出力しても、それを取り囲むパースと、たった 1 つの正しい観察位置がなければ何も起きない。交差方式が扱うのは 1 つの立体の外形であって、場面の構成や観察位置ではない。これは形状生成の問題ではなく、シーン設計の問題である。',
    credit: '杉原厚吉の一連の傾き錯視に連なる。絵画では M. C. エッシャー《滝》が同じ前提を突く。',
    references: [
      {
        label: '杉原厚吉「Anti-Gravity Slopes」講義動画',
        url: 'https://www.youtube.com/watch?v=8JsANDpFhbk',
        note: '動画・英語。本人による解説',
      },
      {
        label: 'エッシャー《滝》（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Waterfall_(M._C._Escher)',
        note: '英語',
      },
    ],
  },
  {
    id: 'hollow-mask',
    name: 'ホロウマスク立体',
    originalName: 'Hollow Face Illusion',
    category: 'parallax',
    buildable: false,
    phenomenon:
      '内側にへこんだ顔の型（凹面）が、どうしても外へ張り出した顔（凸面）に見えてしまう。観察者が横に動くと、顔が観察者を追いかけて回るように見える。',
    mechanism:
      '「顔は凸である」という強い事前知識が、陰影と運動視差から得られる情報を上書きする。凹面を凸面として読むと、視点移動に対する見かけの動きの向きが反転するため、顔がこちらを追って回って見える。',
    notBuildableReason:
      'この錯視は、シルエットには現れない量の上で成立している — 顔の型（凹）と顔（凸）は、外形だけを見れば完全に同一である。効いているのは面の凹凸（法線の向き）と、視点移動に伴う見かけの動きの向きであって、輪郭ではない。交差方式が制約するのは各方向のシルエットだけなので、凹と凸を作り分ける手段が入力側にそもそも存在しない。加えて出力は各方向の外形を満たす最大の中実立体であり、薄い型（シェル）という形式自体が交差の結果として出てこない。',
    credit: 'ホロウフェイス錯視。R. L. グレゴリーの研究によって広く知られる。',
    references: [
      {
        label: 'Hollow-Face illusion（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Hollow-Face_illusion',
        note: '英語',
      },
      {
        label: 'Richard Gregory の実験ページ（ホロウマスクの実演）',
        url: 'https://www.richardgregory.org/experiments/',
        note: '英語。R. L. グレゴリー本人のサイト',
      },
      {
        label: '回転するホロウマスクの動画デモ（Michael Bach）',
        url: 'https://michaelbach.de/ot/fcs-hollowFace/',
        note: '動画。動きがないと錯視が成立しない例',
      },
    ],
  },
  {
    id: 'reverse-perspective',
    name: 'リバースパースペクティブ',
    originalName: 'Reverspective',
    category: 'parallax',
    buildable: false,
    phenomenon:
      '手前へ飛び出した面に「遠景」を、奥まった面に「近景」を描いた立体絵画。観察者が横に動くと、絵が観察者を追いかけて逆向きに回って見える。',
    mechanism:
      '描かれた遠近手がかりが示す奥行きと、実際の物理的な奥行きの符号が逆になっている。脳は絵の側を信じるため、視点移動に伴う運動視差の向きが逆転して知覚される。',
    notBuildableReason:
      '成立条件は形ではなく、面の上に描かれた絵（テクスチャ）にある。同じ凹凸の板でも、描かれていなければ何も起きない。交差方式の出力は色もテクスチャも持たない無地の立体形状だけで、「描かれた奥行きと実際の奥行きの符号を逆にする」という条件を書き込む場所がない。これは造形の問題ではなく彩色の問題であり、形を正しく作れたとしても錯視は起きない。',
    credit: 'パトリック・ヒューズ（Patrick Hughes）の reverspective（1964 年〜）。',
    references: [
      {
        label: 'Patrick Hughes 本人サイト',
        url: 'https://www.patrickhughes.co.uk/',
        note: '英語',
      },
      {
        label: 'Patrick Hughes（Wikipedia）',
        url: 'https://en.wikipedia.org/wiki/Patrick_Hughes_(artist)',
        note: '英語',
      },
      {
        label: 'reverspective の動きを見せる紹介動画（Mashable）',
        url: 'https://www.youtube.com/watch?v=HM76hK3N8Gg',
        note: '動画',
      },
    ],
  },
]

/** id → 項目。UI のルーティング（カタログ項目のパーマリンク）から引く */
export function getIllusionById(id: string): IllusionEntry | undefined {
  return ILLUSIONS.find((entry) => entry.id === id)
}

/**
 * 生成できる項目か。`true` なら `entry.preset` の存在が型で保証される
 * （UI が `preset!` と書かなくて済む＝ギャラリーが壊れたボタンを出さない）。
 */
export function isBuildableIllusion(entry: IllusionEntry): entry is BuildableIllusion {
  return entry.buildable && entry.preset !== undefined
}

/** 生成できない項目か。`true` なら `entry.notBuildableReason` の存在が型で保証される */
export function isUnbuildableIllusion(entry: IllusionEntry): entry is UnbuildableIllusion {
  return (
    !entry.buildable &&
    entry.notBuildableReason !== undefined &&
    entry.notBuildableReason.length > 0
  )
}
