/**
 * 投放包视图组装（工单337）：capabilities 裁剪里 media 段的单一口径。
 *
 * mediaView 端口返回 `{ media: DTO }` 包装（授权裁决在 Broker），投喂面只认 DTO 本体——
 * 包装整包赋给 view.media 会让卡片读不到 sessions（工单336 C6 排障实证）。本函数把
 * 「解包 / 缺席即删」收成一处，pushSnapshot（面板快照全量）与 refreshMedia（媒体快照
 * 增量）共用：两处各写一遍曾在 refreshMedia 漏掉解包，媒体刷新后卡片回落空态
 * （工单337 C7 真机排障实证——__mediaView 录得 n=0 与夹具会话键命中并存）。
 */
export function withMediaSegment(
  view: Record<string, unknown>,
  mediaView: Record<string, unknown> | null,
): Record<string, unknown> {
  const dto = mediaView && typeof mediaView.media === 'object' && mediaView.media !== null ? mediaView.media : null
  if (dto) view.media = dto
  else delete view.media
  return view
}
