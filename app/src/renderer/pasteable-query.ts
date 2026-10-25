// 可贴态查询的有限等待（工单30 真机 (c) 挂起形态）：分区空白菜单开层前要查
// desktop/clipboard-state 决定【粘贴】行置灰，查询链路跨渲染层 → 桥接 → 数据面
// 子进程 → 主进程读取代理——任何一环挂起（子进程重启窗口、桥接失联、宿主忙）都
// 不得无界 await 挡开层。真机电池实锤：开层 3.5s 内未归即败例，故超时归约「查败
// 置灰」，菜单永远开得出来。正常回环毫秒级（事件流实测 3ms），超时档只捕挂起。
// 纯函数（离线测试穷举）；openZoneMenu（main.ts）是唯一调用位。

/** 查询超时档：远大于正常回环（3ms），远小于电池开层窗口（3.5s） */
export const PASTEABLE_QUERY_TIMEOUT_MS = 1000

/** 有界可贴查询：查询结果与超时档赛跑。超时/拒绝都归 false（置灰）——宁可灰不误可用，
 * 与 clipboardState 查败置灰同语义。定时器在归约后收尾；迟到的回执/拒绝被吞掉
 * （查询只读，迟到结果无副作用，拒绝也不得逃逸成 unhandled rejection）。 */
export async function pasteableWithinTimeout(
  query: Promise<{ pasteable: boolean }>,
  timeoutMs: number = PASTEABLE_QUERY_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([query.then((r) => !!r?.pasteable).catch(() => false), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
