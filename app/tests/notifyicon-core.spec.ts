// NotifyIconSettings 僵尸清理纯核（工单433）——TS 测 JS 核，先例：tests/ledger-core.spec.ts。
// seam＝reg.exe export 的 .reg 文本（UTF-16LE 由壳解码）→ 条目表 → GUID 路径解析 → 三态判定。
// 判定口径（2026-11-08 用户拍板）：死路径（ExecutablePath 解析后文件不存在）＋探针白名单
// （InitialTooltip 精确等于 DECK164-PROBE-V0/V4）；其余一律 keep。CLI 壳归真机轮。
import { describe, expect, it } from 'vitest'

const {
  parseNotifyIconRegExport,
  resolveExecutablePath,
  judgeNotifyIconEntry,
} = require('../scripts/lib/notifyicon-core.js') as {
  parseNotifyIconRegExport: (text: string) => Array<{
    key: string
    executablePath: string | null
    initialTooltip: string | null
  }>
  resolveExecutablePath: (raw: string | null, env: Record<string, string | undefined>) => string | null
  judgeNotifyIconEntry: (
    entry: { executablePath: string | null; initialTooltip: string | null },
    resolvedPath: string | null,
    fileExists: boolean,
  ) => 'probe-zombie' | 'dead-path' | 'keep'
}

const HEADER = 'Windows Registry Editor Version 5.00\r\n\r\n'

describe('parseNotifyIconRegExport（.reg 导出文本 → 条目表）', () => {
  it('单条目：收数字子键的 ExecutablePath 与 InitialTooltip，根键值不收', () => {
    const text = HEADER
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings]\r\n'
      + '"Version"=dword:00000003\r\n'
      + '\r\n'
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\10137567596833723177]\r\n'
      + '"UID"=dword:0000a53d\r\n'
      + '"ExecutablePath"="D:\\\\test\\\\panel.exe"\r\n'
      + '"InitialTooltip"="AGENT DECK"\r\n'
    expect(parseNotifyIconRegExport(text)).toEqual([
      { key: '10137567596833723177', executablePath: 'D:\\test\\panel.exe', initialTooltip: 'AGENT DECK' },
    ])
  })

  it('多条子键、非数字子键与其它分支不收、缺值条目留 null', () => {
    const text = HEADER
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\1]\r\n'
      + '"ExecutablePath"="C:\\\\a.exe"\r\n'
      + '"InitialTooltip"="A"\r\n'
      + '\r\n'
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\2]\r\n'
      + '"InitialTooltip"="B"\r\n'
      + '"IconSnapshot"=hex:89,50,4e,47\r\n'
      + '\r\n'
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\NotANumber]\r\n'
      + '"ExecutablePath"="C:\\\\c.exe"\r\n'
      + '\r\n'
      + '[HKEY_CURRENT_USER\\Control Panel\\SomethingElse\\3]\r\n'
      + '"ExecutablePath"="C:\\\\d.exe"\r\n'
    expect(parseNotifyIconRegExport(text)).toEqual([
      { key: '1', executablePath: 'C:\\a.exe', initialTooltip: 'A' },
      { key: '2', executablePath: null, initialTooltip: 'B' },
    ])
  })

  it('hex 折行续行与 REG_SZ 转义（引号/反斜杠）不串味', () => {
    const text = HEADER
      + '[HKEY_CURRENT_USER\\Control Panel\\NotifyIconSettings\\5]\r\n'
      + '"ExecutablePath"="D:\\\\Program Files\\\\say \\"hi\\"\\\\app.exe"\r\n'
      + '"IconSnapshot"=hex:89,50,4e,47,\\\r\n'
      + '  0d,0a,1a,0a\r\n'
      + '"InitialTooltip"="D\\"E"\r\n'
    expect(parseNotifyIconRegExport(text)).toEqual([
      { key: '5', executablePath: 'D:\\Program Files\\say "hi"\\app.exe', initialTooltip: 'D"E' },
    ])
  })
})

describe('resolveExecutablePath（KnownFolder GUID 前缀 → 真实路径）', () => {
  const env = {
    SystemRoot: 'C:\\WINDOWS',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  }

  it('Program Files GUID 前缀展开为环境变量目录', () => {
    expect(resolveExecutablePath('{6D809377-6AF0-444B-8957-A3773F02200E}\\Tencent\\Weixin\\Weixin.exe', env))
      .toBe('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe')
  })

  it.each([
    ['System32', '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\rundll32.exe', 'C:\\WINDOWS\\System32\\rundll32.exe'],
    ['Windows', '{F38BF404-1D43-42F2-9305-67DE0B28FC23}\\explorer.exe', 'C:\\WINDOWS\\explorer.exe'],
    ['Program Files (x86)', '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Tencent\\WeChat\\WeChat.exe', 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe'],
  ])('%s GUID 前缀映射', (_name, raw, expected) => {
    expect(resolveExecutablePath(raw, env)).toBe(expected)
  })

  it('绝对路径原样返回（含 UNC）', () => {
    expect(resolveExecutablePath('D:\\Steam\\steam.exe', env)).toBe('D:\\Steam\\steam.exe')
    expect(resolveExecutablePath('\\\\server\\share\\app.exe', env)).toBe('\\\\server\\share\\app.exe')
  })

  it('不可判定一律 null：未知 GUID、相对路径、空值、缺环境变量', () => {
    expect(resolveExecutablePath('{DEADBEEF-0000-0000-0000-000000000000}\\x.exe', env)).toBeNull()
    expect(resolveExecutablePath('relative\\app.exe', env)).toBeNull()
    expect(resolveExecutablePath(null, env)).toBeNull()
    expect(resolveExecutablePath('{6D809377-6AF0-444B-8957-A3773F02200E}\\x.exe', {})).toBeNull()
  })
})

describe('judgeNotifyIconEntry（三态判定：probe-zombie / dead-path / keep）', () => {
  const EXE = 'D:\\test\\electron.exe'

  it('探针白名单：exe 路径仍存在也判定为 probe-zombie（白名单优先于活路径）', () => {
    expect(judgeNotifyIconEntry({ executablePath: EXE, initialTooltip: 'DECK164-PROBE-V0' }, EXE, true))
      .toBe('probe-zombie')
    expect(judgeNotifyIconEntry({ executablePath: EXE, initialTooltip: 'DECK164-PROBE-V4' }, EXE, true))
      .toBe('probe-zombie')
  })

  it('死路径：可解析但文件不存在 → dead-path', () => {
    expect(judgeNotifyIconEntry({ executablePath: EXE, initialTooltip: null }, EXE, false)).toBe('dead-path')
  })

  it.each([
    ['活路径条目', { executablePath: EXE, initialTooltip: 'AGENT DECK' }, EXE, true],
    ['不可解析路径（resolvedPath=null）', { executablePath: '{DEADBEEF-0000-0000-0000-000000000000}\\x.exe', initialTooltip: null }, null, false],
    ['无 ExecutablePath 条目', { executablePath: null, initialTooltip: null }, null, false],
    ['白名单形似但不等（V1/前缀/大写）', { executablePath: EXE, initialTooltip: 'DECK164-PROBE-V1' }, EXE, true],
    ['白名单工具名当前缀', { executablePath: EXE, initialTooltip: 'DECK164-PROBE-V0-extra' }, EXE, true],
  ])('%s → keep（活路径不动、不可判死不删）', (_name, entry, resolved, exists) => {
    expect(judgeNotifyIconEntry(entry, resolved, exists)).toBe('keep')
  })
})