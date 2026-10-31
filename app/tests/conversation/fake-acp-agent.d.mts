// 确定性 ACP fake 后端的类型声明（实现见 fake-acp-agent.mjs——测试资产，零 DSH 依赖）
export interface FakeFrame extends Record<string, unknown> {}

export interface FakeAcpAgent {
  /** 客户端来的每一帧（含权限裁决响应——wire 断言用） */
  received: FakeFrame[]
  /** fake 发出的每一帧（session/update、权限请求、响应） */
  sent: FakeFrame[]
  recv(frame: FakeFrame): void
  permissionPending(): boolean
}

export interface FakeAcpAgentIo {
  send(obj: FakeFrame): void
  exit?(code: number): void
}

export interface FakeAcpAgentOptions {
  trace?(frame: FakeFrame): void
  slowChunks?: number
  slowGapMs?: number
  onExit?(code: number | null): void
}

export function createFakeAcpAgentCore(
  scenario: string,
  io: FakeAcpAgentIo,
  opts?: FakeAcpAgentOptions,
): FakeAcpAgent

export function attachFakeAcpAgent(
  scenario: string,
  wires?: { input?: unknown; output?: unknown; opts?: FakeAcpAgentOptions },
): FakeAcpAgent
