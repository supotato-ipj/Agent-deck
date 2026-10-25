/**
 * 文件名语义纯逻辑测试（工单28 重命名 + 工单30 粘贴副本名）：标签原文 → 盘面目标
 * 文件名的推导（快捷方式/网址补回原扩展）、Win32 合法性校验（禁字符/保留名/收尾点
 * 空格/空串）与粘贴重名冲突的「 - 副本」递增（explorer 同款不弹框）。
 */
import { describe, expect, it } from 'vitest'
import { duplicateName, fileNameError, renameTarget } from '../../src/main/desktop/filename'

describe('renameTarget（标签原文 → 目标文件名）', () => {
  const lnk = { name: 'Kimi Code.lnk', kind: 'shortcut' as const }
  const url = { name: 'Docs.url', kind: 'url' as const }
  const file = { name: 'note.txt', kind: 'file' as const }
  const folder = { name: '工作目录', kind: 'folder' as const }

  it('file/folder 逐字采纳（显示名即完整文件名），两端去空白', () => {
    expect(renameTarget(file, 'report-2026.txt')).toBe('report-2026.txt')
    expect(renameTarget(file, '  report.txt  ')).toBe('report.txt')
    expect(renameTarget(folder, '新建目录')).toBe('新建目录')
  })

  it('快捷方式/网址未带原扩展时自动补回（explorer 对这两类永远藏扩展）', () => {
    expect(renameTarget(lnk, 'Kimi')).toBe('Kimi.lnk')
    expect(renameTarget(url, '文档站')).toBe('文档站.url')
  })

  it('显式带原扩展（任意大小写）尊重原文，不做双扩展', () => {
    expect(renameTarget(lnk, 'Kimi.LNK')).toBe('Kimi.LNK')
    expect(renameTarget(url, 'docs.URL')).toBe('docs.URL')
  })

  it('两端去空白在补扩展之前生效（输入带尾随空格不产生「 .lnk」）', () => {
    expect(renameTarget(lnk, ' Kimi ')).toBe('Kimi.lnk')
  })

  it('换扩展（typed 带别的扩展名）仍补回原扩展（隐藏扩展语义下输入即显示名）', () => {
    expect(renameTarget(lnk, 'Kimi.exe')).toBe('Kimi.exe.lnk')
  })
})

describe('fileNameError（Win32 文件名合法性）', () => {
  it('合法名字放行（含中文、空格、多点、全大写保留名作为子串）', () => {
    expect(fileNameError('note.txt')).toBeNull()
    expect(fileNameError('工作目录')).toBeNull()
    expect(fileNameError('my.report.2026.v2')).toBeNull()
    expect(fileNameError('ICON.txt')).toBeNull() // 保留名只认 stem 全等，子串不拒
    expect(fileNameError('a b c')).toBeNull()
  })

  it('空串（含纯空白）拒绝', () => {
    expect(fileNameError('')).toBe('文件名不能为空')
  })

  it('Win32 禁字符与控制字符拒绝', () => {
    expect(fileNameError('a<b')).toBe('文件名含非法字符')
    expect(fileNameError('a>b')).toBe('文件名含非法字符')
    expect(fileNameError('a:b')).toBe('文件名含非法字符')
    expect(fileNameError('a"b')).toBe('文件名含非法字符')
    expect(fileNameError('a/b')).toBe('文件名含非法字符')
    expect(fileNameError('a\\b')).toBe('文件名含非法字符')
    expect(fileNameError('a|b')).toBe('文件名含非法字符')
    expect(fileNameError('a?b')).toBe('文件名含非法字符')
    expect(fileNameError('a*b')).toBe('文件名含非法字符')
    expect(fileNameError('a\u0007b')).toBe('文件名含非法字符')
  })

  it('收尾点/收尾空格拒绝（Win32 路径归一化会静默剥掉，产物非用户意图）', () => {
    expect(fileNameError('note.')).toBe('文件名不能以点或空格收尾')
    expect(fileNameError('note ')).toBe('文件名不能以点或空格收尾')
  })

  it('保留设备名拒绝（不分大小写、带扩展同样保留）', () => {
    expect(fileNameError('CON')).toBe('文件名是系统保留名')
    expect(fileNameError('con.txt')).toBe('文件名是系统保留名')
    expect(fileNameError('Nul')).toBe('文件名是系统保留名')
    expect(fileNameError('COM1')).toBe('文件名是系统保留名')
    expect(fileNameError('com9.zip')).toBe('文件名是系统保留名')
    expect(fileNameError('LPT4')).toBe('文件名是系统保留名')
  })
})

describe('duplicateName（工单30 粘贴重名冲突的副本名）', () => {
  const taken = (...names: string[]) => (candidate: string) => names.includes(candidate)

  it('无冲突原名原样返回（粘贴常态：桌面没有同名）', () => {
    expect(duplicateName({ name: 'a.txt', isDirectory: false }, taken())).toBe('a.txt')
    expect(duplicateName({ name: '工作目录', isDirectory: true }, taken())).toBe('工作目录')
  })

  it('冲突 → 「基名 - 副本.扩展」起步，「 - 副本 N」递增取第一个空位（真桌面同款不弹框）', () => {
    expect(duplicateName({ name: 'a.txt', isDirectory: false }, taken('a.txt'))).toBe('a - 副本.txt')
    expect(duplicateName({ name: 'a.txt', isDirectory: false }, taken('a.txt', 'a - 副本.txt'))).toBe('a - 副本 2.txt')
    expect(duplicateName({ name: 'a.txt', isDirectory: false }, taken('a.txt', 'a - 副本.txt', 'a - 副本 2.txt')))
      .toBe('a - 副本 3.txt')
  })

  it('扩展名主意只打到最后一段点前；点开头名（.gitignore）视为无扩展', () => {
    expect(duplicateName({ name: 'my.report.v2.docx', isDirectory: false }, taken('my.report.v2.docx')))
      .toBe('my.report.v2 - 副本.docx')
    expect(duplicateName({ name: 'LICENSE', isDirectory: false }, taken('LICENSE'))).toBe('LICENSE - 副本')
    expect(duplicateName({ name: '.gitignore', isDirectory: false }, taken('.gitignore'))).toBe('.gitignore - 副本')
  })

  it('目录不打扩展名主意（后缀缀在名尾）：v1.2 → v1.2 - 副本', () => {
    expect(duplicateName({ name: 'v1.2', isDirectory: true }, taken('v1.2'))).toBe('v1.2 - 副本')
    expect(duplicateName({ name: 'v1.2', isDirectory: true }, taken('v1.2', 'v1.2 - 副本'))).toBe('v1.2 - 副本 2')
  })

  it('基名自带「 - 副本」/「 - 副本 N」后缀：剥掉续号（再贴一份 ≠ 叠罗汉）', () => {
    expect(duplicateName({ name: 'a - 副本.txt', isDirectory: false }, taken('a - 副本.txt'))).toBe('a - 副本 2.txt')
    expect(duplicateName({ name: 'a - 副本 2.txt', isDirectory: false }, taken('a - 副本 2.txt'))).toBe('a - 副本 3.txt')
    expect(duplicateName({ name: 'a - 副本 5.docx', isDirectory: false }, taken('a - 副本 5.docx'))).toBe('a - 副本 6.docx')
  })

  it('同拍多份粘贴不互相覆盖：taken 由调用方按盘面实况注入（先贴出的名字立即算占用）', () => {
    const occupied = new Set(['a.txt'])
    const grow = (c: string) => occupied.has(c)
    const first = duplicateName({ name: 'a.txt', isDirectory: false }, grow)
    occupied.add(first)
    const second = duplicateName({ name: 'a.txt', isDirectory: false }, grow)
    occupied.add(second)
    const third = duplicateName({ name: 'a.txt', isDirectory: false }, grow)
    expect([first, second, third]).toEqual(['a - 副本.txt', 'a - 副本 2.txt', 'a - 副本 3.txt'])
  })
})
