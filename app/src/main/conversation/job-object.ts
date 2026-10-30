// Job Object kill-on-close（工单332，ADR-0018「Windows 上用 Job Object 设 kill-on-close，
// 面板异常退出也不留孤儿」）：每会话进程_assign_进专属 Job，面板崩溃/被强杀时句柄随进程
// 蒸发，内核代收整棵 DSH 进程树。koffi 直调 kernel32（win32.ts 同款窄绑定）。
//
// 失败面：koffi 不可用 / 非 Windows / 任何 NTAPI 失败 → 返回 null，调用方回落
// taskkill 树杀（服务层显式结束路径已有此兜底）。绝不让 Job 失败拦住会话创建。

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JobObjectExtendedLimitInformation = 9
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
/** JOBOBJECTEXTENDEDLIMITINFORMATION 的 x64 布尔尺寸：两个 JOBOBJECT_BASIC_LIMIT_INFORMATION
 * 相关块 + IO 计数块——128 字节安全上限（SIZE_T×2 ×10 + 两个 LARGE_INTEGER） */
const JOBOBJECT_EXT_LIMIT_SIZE = 144

export interface JobObjectHandle {
  assign(pid: number): boolean
  close(): void
}

/**
 * 创建 kill-on-close Job Object。成功返回句柄（close() 即「最后一手关闭」→ 内核杀树）；
 * 失败返回 null（调用方回落 taskkill）。惰性加载 koffi，加载不出即 null。
 */
export function createKillOnCloseJob(): JobObjectHandle | null {
  if (process.platform !== 'win32') return null
  let koffi: typeof import('koffi')
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi')
  } catch {
    return null
  }
  try {
    const kernel32 = koffi.load('kernel32.dll')
    const CreateJobObjectW = kernel32.func('uintptr_t __stdcall CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)')
    const SetInformationJobObject = kernel32.func('bool __stdcall SetInformationJobObject(uintptr_t hJob, int32 JobObjectInformationClass, void *lpJobObjectInformation, uint32 cbJobObjectInformationLength)')
    const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)')
    const AssignProcessToJobObject = kernel32.func('bool __stdcall AssignProcessToJobObject(uintptr_t hJob, uintptr_t hProcess)')
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t hObject)')

    const job = Number(CreateJobObjectW(null, null))
    if (!job) return null
    // LimitFlags 落在 BASIC_LIMIT_INFORMATION 偏移 20（x64：Padding[8] PerProcessUserTimeLimit
    // [8] PerJobUserTimeLimit[8] LimitFlags[4]…）——写前先清零整块
    const info = Buffer.alloc(JOBOBJECT_EXT_LIMIT_SIZE)
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 20)
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length)) {
      CloseHandle(job)
      return null
    }
    return {
      assign(pid: number): boolean {
        if (!pid) return false
        const proc = Number(OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid))
        if (!proc) return false
        const ok = Boolean(AssignProcessToJobObject(job, proc))
        CloseHandle(proc)
        return ok
      },
      close(): void {
        CloseHandle(job) // kill-on-close：最后一个句柄关闭 → 内核终止整树
      },
    }
  } catch {
    return null
  }
}
