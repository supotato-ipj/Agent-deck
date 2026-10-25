// 插件键盘档记账（工单100，纯逻辑）：插件运行时替插件保管「谁持着哪个档」——请求/
// 释放去重、卸载强制回收（crash 安全：插件 unmount 没释放、抛错、被停用，宿主都要能
// 收回键盘档，#101 停用回收走同一条链）。这里只管账、只裁决「要不要向归一仲裁发键盘档
// 事件」；沿的产生与 keyboard-mode-on/off 同相性归 keyboard-gate.ts 归一仲裁（单通道，
// 严禁第二模式通道）。不发 DOM、不发存证：渲染层接线在 plugins.ts，键盘档名字在宿主侧
// 带插件 id 命名空间后才进归约器。
export interface PluginTierRegistry {
  /** 请求占用：true = 新持拿（宿主应发 tier-acquired）；false = 已在持（幂等噪声，不发） */
  hold(pluginId: string, tier: string): boolean
  /** 释放：true = 确有在持（宿主应发 tier-released）；false = 未持拿（噪声，不发） */
  release(pluginId: string, tier: string): boolean
  /** 强制回收该插件全部在持档（unmount/挂载失败时宿主调用），返回被回收的档名（宿主逐一发 tier-released） */
  reclaim(pluginId: string): string[]
}

export function createPluginTierRegistry(): PluginTierRegistry {
  const held = new Map<string, Set<string>>()
  return {
    hold(pluginId, tier) {
      let set = held.get(pluginId)
      if (!set) {
        set = new Set()
        held.set(pluginId, set)
      }
      if (set.has(tier)) return false
      set.add(tier)
      return true
    },
    release(pluginId, tier) {
      return held.get(pluginId)?.delete(tier) ?? false
    },
    reclaim(pluginId) {
      const set = held.get(pluginId)
      if (!set) return []
      held.delete(pluginId)
      return [...set]
    },
  }
}
