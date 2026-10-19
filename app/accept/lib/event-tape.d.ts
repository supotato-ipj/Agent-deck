// 事件磁带 EventTape（工单205，spec #201 B 分支合刀批1 的前置模块票）的类型声明：
// event-tape.js 是 CJS 观测总线模块（事件 JSONL → 四方法），本声明服务
// tests/*.spec.ts 的类型检查与后续电池侧的 TS 消费方。
//
// 严口径不变量：四方法签名与母票 #201 决策7 逐字一致；超时返回 null 不抛错；
// 时间门只由 since 参数承担（t0 语义：只认 e.t >= since 的拍）。

/** 一拍事件：t 是面板写事件时落的 Date.now() 毫秒，type 是事件名，其余字段随 type 而变 */
export declare interface EventTapeEvent {
  /** 事件时间戳（毫秒，Date.now() 口径） */
  t: number
  /** 事件类型（如 'boot' / 'desktop-rendered'） */
  type: string
  /** 各事件类型的领域字段（形状随 type 变，故索引签名放开——电池侧按事件名各取各的字段） */
  [key: string]: any
}

/** 构造配置：默认超时档（母票决策8：既有两档 6000 / 8000 由调用方显式传，不在模块内统一） */
export declare interface EventTapeOptions {
  /** 默认超时（毫秒）：主电池与 tray-spike 传 6000、taskbar 族五块传 8000 */
  defaultTimeoutMs?: number
}

/** wait 的可选项：since = 时间门；timeoutMs = 覆盖构造默认档 */
export declare interface EventTapeWaitOptions {
  /** 时间门（t0 语义）：只认 e.t >= since 的拍 */
  since?: number
  /** 覆盖构造默认超时（毫秒） */
  timeoutMs?: number
}

/** latest / all 的可选项：since = 时间门 */
export declare interface EventTapeQueryOptions {
  /** 时间门（t0 语义）：只认 e.t >= since 的拍 */
  since?: number
}

/** 事件磁带：绑一个事件文件，暴露四方法——这就是调用方需要学的全部 */
export declare interface EventTape {
  /**
   * 等某类事件：命中即返回「首个」匹配拍（既有 waitEvent 的 find 口径）；
   * 超时返回 null，不抛错。
   */
  wait(
    type: string,
    pred?: (e: EventTapeEvent) => boolean,
    options?: EventTapeWaitOptions,
  ): Promise<EventTapeEvent | null>

  /**
   * 等「最后一拍距今安静」：某类型最后一拍距今已静默 quietMs 即交出那一拍；
   * 一直没安静则超时返回 null，不抛错。沿用旧名 waitStable。
   */
  waitStable(type: string, quietMs?: number, timeoutMs?: number): Promise<EventTapeEvent | null>

  /** 现取最新一拍（既有 readEvents().filter(...).pop() 口径）；无匹配拍返回 null */
  latest(
    type: string,
    pred?: (e: EventTapeEvent) => boolean,
    options?: EventTapeQueryOptions,
  ): EventTapeEvent | null

  /** 裸读全量（可按 type / 谓词 / since 过滤） */
  all(
    type?: string,
    pred?: (e: EventTapeEvent) => boolean,
    options?: EventTapeQueryOptions,
  ): EventTapeEvent[]
}

/**
 * 建一条绑定指定事件文件的磁带。
 * @param eventsFile 事件 JSONL 绝对路径（面板经 DECK_EVENT_LOG 落的那个文件）
 * @param options 构造配置：defaultTimeoutMs 为默认超时档；省略时兜底 6000（主电池档）
 */
export declare function createEventTape(eventsFile: string, options?: EventTapeOptions): EventTape
