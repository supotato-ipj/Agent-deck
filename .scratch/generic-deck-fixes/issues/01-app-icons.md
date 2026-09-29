# 工单01: 应用区快捷方式真实图标

Status: ready-for-agent

Spec: `.scratch/generic-deck-fixes/spec.md`（本工单对应 Implementation Decisions「快捷方式图标提取链」与 User Stories 1-4、19 的图标防回归线）。

## 根因（已实证，勿重查）

本机（Win11 26200 / Electron 44.4.3）`app.getFileIcon` 对所有 `.lnk` 返回字节级相同的通用图标——含现场新造的指向 notepad 的快捷方式；对目标 exe/.ico 直取完全正常（48px 档正常）。上游已知限制 electron#15809/#18292，本工单只在适配层绕行（Out of Scope：不升级 Electron、不换图标库）。

探针证据：`.scratch/icon-probe/`（probe-result.json / probe2-result.json / probe3-result.json，lnk-dump.ps1、make-fixtures.ps1 可复用）。

## 修法（spec 已拍板）

提取层绕行：对快捷方式先解析图标源，再对**本体**提取——

1. **图标源决策 = 纯函数**（可离线测），放 `app/src/main/desktop/` 现有纯逻辑模块（icons.ts 或 scan.ts，取更贴者）。输入 lnk 解析结果（声明的图标定位路径、目标路径）+ 存在性判定，输出应提取的本体路径或 null（null = 回落对 lnk 本体提取，即现状的通用图标）。决策规则：优先声明的图标定位路径；缺失或不可用（文件不存在）回落目标可执行文件；两者皆不可用 → null。
2. **适配层组装**（`app/src/main/desktop/adapter.ts`）：`electronIconExtractor` 对 `.lnk`（大小写不敏感）先经 `shell.readShortcutLink` 取完整 ShortcutDetails（现成的 `electronShortcutTarget` 只读 `.target`，别破坏它——DesktopService 频次映射还在用；为图标另取 details 或扩展均可，保持注入缝 `DesktopDeps.extractIcon` 形状不变）。按纯函数决策对本体 `getFileIcon(source, { size: 'large' })`；任一步失败回落现状（对 lnk 本体提取 = 通用图标）。
3. **48px 源**：快捷方式经源提取后 `large` 档即真 48px，dock 40px 显示位更锐（现状对 lnk 本体提取拿到的是通用小图，此事随修法自然成立，无需单独处理）。
4. **不动**：图标缓存键（path|mtimeMs）、预热门（`IconCache.needsWork`）、`DesktopService.icon()` 契约、`.url` 项现状（Out of Scope）。决策只住在提取器内部。

## 测试缝（spec Testing Decisions 3：纯函数缝，唯一新增）

- 纯函数单测：图标定位优先 / 未声明回落目标 / 声明了但文件不存在回落目标 / 双缺失回落 null / exists 判定注入。先例形态：`tests/desktop/icons.spec.ts`（IconCache 注入提取器）。
- 现有全套必须绿：`npm run typecheck && npm test`（app/ 下）。

## 真机验收电池（User Story 19 图标防回归线）

`accept/battery.js` 新增探针：**不同快捷方式的图标 dataUrl 互不相等**。建议自备夹具：电池在用户桌面现场造两个指向不同真 exe（如 notepad、charmap）的 .lnk，等扫描指纹翻转后经控制器内桥接调用 `desktop/icon` 取 dataUrl 断言互不相等，结束时删除夹具（桌面偏好基线不变；夹具路径勿与真实条目撞名）。若池内现成 lnk ≥2 也可直接用，但夹具法不依赖用户桌面内容，优先。落点参考电池既有结构（桌面承载 P5 段、桥接调用先例、psDesktopScan / desktop-rendered 存证定位）。

## 验收

- [ ] typecheck + vitest 全绿
- [ ] 纯函数缝单测就位
- [ ] 电池图标区分度探针就位（真机全量电池由合并后在 PR 分支统一跑，本工单跑通 build 即可）
- [ ] 图标缓存键/预热门/`.url` 行为零改动
