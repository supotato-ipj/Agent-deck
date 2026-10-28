// 原生任务栏 appbar 状态读写（工单260 原生栏托管；工单308 M1 单职责收口）：
// ABM_GETSTATE/ABM_SETSTATE 两消息的最薄 FFI 面（探针同款调用形态，
// docs/audit/2026-10-24-t257-autohide-setstate-probe.md）——托管建立置位、重申压回、
// 读回裁决与三层复原全部消费这一对消息（效果层 RAII 账在 appbar-autohide.ts，落盘账
// 复原在 appbar-ledger.ts，置位值函数 retractAutoHideState 在 shared/retract）。
//
// 手段是 SHAppBarMessage（shell32，Win95→Win11 未变的承重墙）：消息送达 explorer
// 的 AppBar 服务，不依赖 Shell_TrayWnd 窗口可见性——原生任务栏已被工单50 隐藏
// （ShowWindow 视图态切换），AppBar 语义不受影响。
//
// **工单308 M1（spec #306）占位链退役**：本模块原兼营 AppBar 工作区占位（工单51，ADR-0007：
// ABM_NEW 注册 / ABM_REMOVE 注销 / ABM_QUERYPOS+ABM_SETPOS 协商 / ABN_POSCHANGED 回调重
// 协商）——覆盖式普通档与占位物理互斥（占位必收回保留带、必挤压最大化窗，spec #306 主诉），
// 整条注册/协商/回调面随 M1 退役（历史取证 docs/audit/2026-10-23-t250-native-taskbar-
// reserved-band.md，语义沿革见 ADR-0015/0016），本处只留状态读写。
//
// 薄效果层（无分支，真机验收覆盖，不进单测——工单46 Testing Decisions）。
import koffi from 'koffi'

const ABM_GETSTATE = 4
const ABM_SETSTATE = 10

/** 物理像素矩形（SHAppBarMessage 物理口径；仅作 APPBARDATA 布局占位——状态读写不携矩形） */
const APPBAR_RECT = koffi.struct('TASKBAR_APPBAR_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
// APPBARDATA：x64 = 48B（cbSize 4 + pad 4 + hWnd 8 + uCallbackMessage 4 + uEdge 4 + rc 16 + lParam 8）
const APPBARDATA = koffi.struct('TASKBAR_APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'uintptr_t',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: 'TASKBAR_APPBAR_RECT',
  lParam: 'intptr_t',
})

const shell32 = koffi.load('shell32.dll')
const SHAppBarMessage = shell32.func('uintptr_t __stdcall SHAppBarMessage(uint32 dwMessage, TASKBAR_APPBARDATA *pData)')

/** GETSTATE/SETSTATE 共用的最小 APPBARDATA（hWnd/回调/边/矩形全零，lParam 携带状态位） */
function appBarStateData(lParam: number) {
  return {
    cbSize: koffi.sizeof(APPBARDATA) as number,
    hWnd: 0,
    uCallbackMessage: 0,
    uEdge: 0,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam,
  }
}

/** 读原生任务栏 appbar 状态位（返回值取 ABS_* 掩码内的位；spike 基线 0、置位后 1） */
export function getAppBarState(): number {
  return Number(SHAppBarMessage(ABM_GETSTATE, appBarStateData(0))) & 0x3
}

/** 写原生任务栏 appbar 状态位（ABS_AUTOHIDE/ABS_ALWAYSONTOP 组合）。成败由调用方以
 *  GETSTATE 读回事实裁决（同 ShowWindow 返回值不可信的纪律——SETSTATE 无返回语义）。 */
export function setAppBarState(state: number): void {
  SHAppBarMessage(ABM_SETSTATE, appBarStateData(state))
}
