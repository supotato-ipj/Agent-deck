// 工单411 层1：accept lib 专用声明检查面。
//
// 接缝 = 真实 TypeScript 命令 + 专用检查配置（app/tsconfig.accept-lib.json）。
// 本 spec 证明四件事：
// ① 配置事实——noEmit（禁止 emit）、skipLibCheck 显式 false（覆盖基座 tsconfig.json 的 true，
//    否则专用面形同虚设，工单411 盘点风险 R5）、include 自动覆盖全部 accept/lib/*.d.ts；
// ② 总入口串接——npm run typecheck 串联专用检查命令，本地与 CI 同一道门（不新增 CI job）；
// ③ 坏声明夹具（不进正常编译目标）走同一专用配置判红——证明 d.ts 内部错误真的会浮出；
// ④ 真仓库八组声明经真实 tsc 命令全绿（红→绿由两处现存缺陷修复承重）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const appRoot = path.resolve(__dirname, '..', '..')
const libDir = path.join(appRoot, 'accept', 'lib')
const configPath = path.join(appRoot, 'tsconfig.accept-lib.json')
const badFixture = path.join(appRoot, 'tests', 'accept', 'fixtures', 'accept-lib', 'bad-decl.d.ts')

/** 只读盘点（工单411）：accept/lib 下的声明文件全集——自动发现，不手抄清单 */
function discoveredDecls(): string[] {
  return fs.readdirSync(libDir).filter((f) => f.endsWith('.d.ts')).sort()
}

function parseAcceptLibConfig() {
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(raw.error).toBeFalsy()
  return {
    json: raw.config as { compilerOptions?: Record<string, unknown> },
    parsed: ts.parseJsonConfigFileContent(raw.config, ts.sys, appRoot),
  }
}

describe('工单411 层1：accept lib 专用声明检查面', () => {
  it('专用配置：noEmit + skipLibCheck 显式 false + include 自动覆盖全部 accept lib 声明', () => {
    const { json, parsed } = parseAcceptLibConfig()
    expect(json.compilerOptions?.noEmit).toBe(true)
    expect(json.compilerOptions?.skipLibCheck).toBe(false)
    expect(parsed.options.noEmit).toBe(true)
    expect(parsed.options.skipLibCheck).toBe(false)
    // 不经排除目标声明制造绿灯：include 命中的声明集合 ⊇ 自动发现的 accept/lib 声明全集
    const fileNames = parsed.fileNames.map((f) => path.resolve(f).toLowerCase())
    expect(fileNames.length).toBeGreaterThan(0)
    for (const d of discoveredDecls()) {
      expect(fileNames, `accept lib 声明未被专用检查面包含：${d}`).toContain(path.resolve(libDir, d).toLowerCase())
    }
  })

  it('总入口串接：typecheck 串联 accept lib 专用检查命令（本地与 CI 同一道门）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string>>
    expect(pkg.scripts['typecheck:accept-lib']).toBe('tsc -p tsconfig.accept-lib.json')
    expect(pkg.scripts.typecheck).toContain('typecheck:accept-lib')
  })

  it('坏声明夹具走同一专用配置判红（d.ts 内部未知类型不被 skipLibCheck 跳过）', () => {
    const { parsed } = parseAcceptLibConfig()
    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, badFixture],
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    })
    const diags = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && path.resolve(d.file.fileName).toLowerCase() === path.resolve(badFixture).toLowerCase())
    expect(diags.length, '坏声明夹具未被专用配置判红——skipLibCheck 覆盖可能失效').toBeGreaterThan(0)
    const text = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('\n')
    expect(text).toContain('SPEC411_MISSING_TYPE')
  }, 30_000) // 真实成本：skipLibCheck=false 下 8 组声明 + 全量 lib/node 类型检查程序，单独实测 ~3.4s，全量门禁并行时更久

  it('真仓库八组声明经真实命令全绿（npx tsc -p tsconfig.accept-lib.json）', () => {
    // 不经 shell：直接 node typescript/bin/tsc，Windows 下 npx.cmd 无 shell 不可靠
    const tscJs = require.resolve('typescript/bin/tsc')
    execFileSync(process.execPath, [tscJs, '-p', 'tsconfig.accept-lib.json'], { cwd: appRoot, stdio: 'pipe' })
  }, 30_000) // 真实成本：spawn 真实 tsc 全量检查（单独实测 ~3.2s），全量门禁并行时更久
})
