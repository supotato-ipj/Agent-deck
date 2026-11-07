// 栏布局存储 P16 探针残留判别（工单255）的类型声明：probe-residue.js 是 CJS 纯函数模块。

/** 探针 display 名（excluded/pinned 条目的 label）：DECK-P16-<时戳>-<A..G> */
export declare const PROBE_LABEL_RE: RegExp
/** 探针目标 exe：deck-p16-cmd.exe（首条真启动臂副本）/ deck-p16-probe-X.exe（占位体） */
export declare const PROBE_EXE_RE: RegExp
/** usage 种子合成路径（byStem 通道的假 exe，落在 deck-p16-usage-seed 目录下） */
export declare const SEED_EXE_RE: RegExp
/** 推荐位显式序条目（recommended 段存桌面项原始名，含扩展名） */
export declare const PROBE_NAME_RE: RegExp

/** pinned/excluded 条目形态 { exe, label, iconKey? } 是否电池探针残留 */
export declare function isResidueEntry(entry: { exe?: string; label?: string } | null | undefined): boolean

/** recommended 显式序条目（桌面项名）是否电池探针残留 */
export declare function isResidueName(name: string | null | undefined): boolean

/** 三段扫除结果：扫后的存储副本 + 逐条「段:身份」残留账 */
export declare function stripBatteryResidue(store: {
  version?: number
  pinned?: Array<{ exe: string; label: string; iconKey?: string | null }>
  recommended?: string[]
  excluded?: Array<{ exe: string; label: string; iconKey?: string | null }>
}): {
  store: {
    version?: number
    pinned?: Array<{ exe: string; label: string; iconKey?: string | null }>
    recommended?: string[]
    excluded?: Array<{ exe: string; label: string; iconKey?: string | null }>
  }
  removed: string[]
}
