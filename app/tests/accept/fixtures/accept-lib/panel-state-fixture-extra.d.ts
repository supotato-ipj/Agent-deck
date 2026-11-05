// 工单411 层2 持久负例：私有状态声明多一项（8 项 vs 真实七项 → 私有状态对齐判红）。
// 键集刻意多出 fakeExtra——证明声明侧多一项会被双向对齐抓到。
export declare interface FixturePanelStateExtra {
  child: unknown | null
  panelPid: number | null
  hwnd: unknown | null
  launchedAt: number
  sinceGate: number
  lastCfg: unknown | null
  stderrTail: string
  fakeExtra: number
}
