// 托盘机器态判定（工单141，spec #145）的类型声明：tray-machine-state.js 是 CJS 纯决策
// 模块（探测事实注入，判定/记账决定输出），本声明服务 tests/*.spec.ts 的类型检查。
// 严口径不变量：allowExclude 只在机器态条件 + trayAddSpan 注册正向证据同时在场时为 true。

/** 判定输入：全部是探测事实（注册表/事件流 sidecar/探针输出/识别色扫描） */
export declare interface TrayMachineFacts {
  /** NotifyIconSettings 有本 exe（全路径匹配）条目 */
  entryExists?: boolean
  /** 条目 IsPromoted 值（无条目传 null） */
  promoted?: number | null
  /** 面板 pid 的 tray-add span-close 在案（Tray 构造即 Shell_NotifyIcon 已发出的注册正向证据） */
  trayAddSpan?: boolean
  /** 导航输出步名含勿扰通知积压标记（"Do not disturb on"） */
  dndMarkerSeen?: boolean
  /** 任务栏可见区识别色扫描命中 */
  amberVisible?: boolean
}

/** 判定输出：null = 无机器态条件在场（照常硬失败） */
export declare interface TrayMachineVerdict {
  /** 条件名（-unverified 后缀 = 无注册存证，严口径收紧） */
  condition: string
  /** 是否允许环境降责（严口径：机器态条件 + trayAddSpan 同时在场才 true） */
  allowExclude: boolean
  /** 机器态解释适用的断言面：'P8-register' | 'P8-visibility' | 'P10-nav' */
  appliesTo: string[]
  /** 环境账归因文本（排除窗 reason） */
  reason: string
  /** 定向失败语（排查者可读：机器态，非面板回归） */
  directed: string
}

export declare function judgeTrayMachineState(input?: TrayMachineFacts): TrayMachineVerdict | null

/** Win11 勿扰在场时 UIA 焦点名里的通知中心项标记（#138 实测形态） */
export declare const DND_MARKER: string
