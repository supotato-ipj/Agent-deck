// 工单411 层2：accept lib 成员对齐机制（比较器 + 声明侧解析 + 私有状态 AST 探针）。
//
// 职责边界（票面 Implementation Decisions 6–12）：
// - 声明侧成员一律从 TypeScript checker 解析真实符号/返回类型（决策9），不维护手写预期键表；
// - 运行时侧样本由调用方（spec）经真实模块/工厂/类构造器取得（决策10），本文件不做 require 编排；
// - 双向语义（决策8）：声明必需成员运行时缺失判红、可选成员合法缺席放行、
//   运行时出现声明外成员判红（未知可选名同样判红，可选性不是逃生口）；
// - 开放形状（索引签名在场）与外部/基本类型（数组、Set、RegExp、函数）不做封闭键集断言（决策7）；
// - 下划线私有实现不升公共契约（决策7）：运行时键以下划线命名的一律不计；
// - 封闭嵌套结果沿类型递归下钻（决策9），深度封顶防环。
// 纯类型与接口不是运行时导出，不进对齐集合（决策7）：顶层只取 function/class/const 值符号。
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export interface AlignmentIssue {
  at: string
  problem: string
}

export interface DeclValueExport {
  name: string
  kind: 'class' | 'function' | 'const'
  symbol: ts.Symbol
}

const VALUE_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable
const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined
const MAX_DEPTH = 8

/** 自动发现 accept lib 声明文件全集（不手抄清单——新增 .d.ts 自动进入门禁范围） */
export function discoverDeclFiles(appRoot: string): string[] {
  const libDir = path.join(appRoot, 'accept', 'lib')
  return fs.readdirSync(libDir).filter((f) => f.endsWith('.d.ts')).sort().map((f) => path.join(libDir, f))
}

export interface AlignmentContext {
  program: ts.Program
  checker: ts.TypeChecker
  /** 参与检查的声明文件绝对路径集（小写），用于判定「own 类型」（成员声明落在本仓库 d.ts 内） */
  ownFiles: Set<string>
}

/** 以 tsconfig.accept-lib.json 的编译选项为基座构建检查程序（同一专用配置，两层共用口径） */
export function acceptLibCompilerOptions(appRoot: string): ts.CompilerOptions {
  const configPath = path.join(appRoot, 'tsconfig.accept-lib.json')
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  if (raw.error) throw new Error(`tsconfig.accept-lib.json 读取失败：${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`)
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, appRoot)
  return parsed.options
}

export function createAlignmentContext(rootNames: string[], options: ts.CompilerOptions): AlignmentContext {
  const program = ts.createProgram({ rootNames, options })
  const checker = program.getTypeChecker()
  const ownFiles = new Set<string>(
    rootNames.map((f) => path.resolve(f).toLowerCase()),
  )
  return { program, checker, ownFiles }
}

function unionConstituents(type: ts.Type): ts.Type[] {
  // 票面口径：union 按「任一支完全对齐即通过」处理；null/undefined 作为独立支参与判定
  return type.isUnion() ? type.types : [type]
}

/** 判定类型是否「own 封闭对象形状」：对象型、无字符串索引签名（开放形状不封）、
 *  且类型符号声明在本仓库声明文件内（或为声明侧就地写出的匿名字面量类型）。
 *  数组/Set/RegExp/函数等叶子与外部类型不在此列——只做存在性对齐，不展开成员键集。 */
function isOwnClosedObjectType(ctx: AlignmentContext, type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false
  if (checkerHasStringIndex(ctx.checker, type)) return false
  if (!type.symbol) return true // 匿名对象字面量类型（如 validateScopeSegments 的返回形状）
  const decls = type.symbol.declarations ?? []
  return decls.length > 0 && decls.every((d) => ctx.ownFiles.has(path.resolve(d.getSourceFile().fileName).toLowerCase()))
}

function checkerHasStringIndex(checker: ts.TypeChecker, type: ts.Type): boolean {
  try {
    return checker.getIndexInfosOfType(type).some((info) => info.keyType.flags & ts.TypeFlags.String)
  } catch {
    return false
  }
}

function classInstanceType(ctx: AlignmentContext, symbol: ts.Symbol): ts.Type {
  const declared = ctx.checker.getDeclaredTypeOfSymbol(symbol)
  if (declared && (declared.flags & ts.TypeFlags.Object)) return declared
  const vd = symbol.valueDeclaration
  if (vd) return ctx.checker.getTypeAtLocation(vd)
  throw new Error('class 符号无法解析实例类型')
}

function functionReturnType(ctx: AlignmentContext, symbol: ts.Symbol): ts.Type | null {
  const vd = symbol.valueDeclaration
  if (!vd) return null
  // d.ts 里的 `export declare function` 没有函数体——只按声明节点取签名，不要求 body
  const signature = ts.isFunctionDeclaration(vd) || ts.isMethodDeclaration(vd)
    ? ctx.checker.getSignatureFromDeclaration(vd)
    : undefined
  if (!signature) return null
  return ctx.checker.getReturnTypeOfSignature(signature)
}

/** 「需要样本根」的判定（决策11）：class 导出，或函数返回 own 封闭对象形状（含 union 中任一支）。
 *  返回数组/基本型/Set/RegExp 的函数不需要样本根，只做顶层名称对齐。 */
export function needsSampleRoot(ctx: AlignmentContext, exp: DeclValueExport): boolean {
  if (exp.kind === 'class') return true
  if (exp.kind !== 'function') return false
  const ret = functionReturnType(ctx, exp.symbol)
  if (!ret) return false
  return unionConstituents(ret)
    .filter((t) => !(t.flags & NULLISH))
    .some((t) => isOwnClosedObjectType(ctx, t))
}

/** const 导出的声明类型是否 own 封闭对象形状（是则对运行时值做深对齐，否则只做存在性） */
export function constIsClosedObject(ctx: AlignmentContext, exp: DeclValueExport): boolean {
  if (exp.kind !== 'const') return false
  const type = ctx.checker.getTypeOfSymbol(exp.symbol)
  return unionConstituents(type)
    .filter((t) => !(t.flags & NULLISH))
    .some((t) => isOwnClosedObjectType(ctx, t))
}

/** 模块导出符号表（SourceFile.symbol 不在 TS 公开 d.ts 内，走 checker.getSymbolAtLocation 公开面） */
function moduleExports(ctx: AlignmentContext, declFile: string): Map<string, ts.Symbol> {
  const sf = ctx.program.getSourceFile(declFile)
  if (!sf) throw new Error(`声明文件不在检查程序内：${declFile}`)
  const moduleSymbol = ctx.checker.getSymbolAtLocation(sf)
  return (moduleSymbol?.exports ?? new Map<string, ts.Symbol>()) as unknown as Map<string, ts.Symbol>
}

export function declaredValueExports(ctx: AlignmentContext, declFile: string): DeclValueExport[] {
  const exportsMap = moduleExports(ctx, declFile)
  const result: DeclValueExport[] = []
  exportsMap.forEach((symbol, name) => {
    if (!(symbol.flags & VALUE_FLAGS)) return // 纯类型/接口不是运行时导出（决策7）
    const kind: DeclValueExport['kind'] =
      symbol.flags & ts.SymbolFlags.Class ? 'class'
      : symbol.flags & ts.SymbolFlags.Function ? 'function'
      : 'const'
    result.push({ name: String(name), kind, symbol })
  })
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** 运行时成员键：own 属性 + 原型方法（类实例），排除构造器；调用方负责下划线过滤 */
function runtimeMemberKeys(value: object): string[] {
  const keys = new Set<string>()
  for (let o: object | null = value; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) keys.add(k)
  }
  return [...keys].filter((k) => k !== 'constructor')
}

function runtimeKeysWithoutPrivate(value: object): string[] {
  return runtimeMemberKeys(value).filter((k) => !k.startsWith('_'))
}

/** 成员可选性：任一声明节点带 questionToken 即可选（公开 AST 面） */
function isOptionalMember(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((d) => {
    if (ts.isPropertySignature(d) || ts.isMethodSignature(d) || ts.isPropertyAssignment(d) || ts.isMethodDeclaration(d)) {
      return (d as { questionToken?: ts.QuestionToken }).questionToken !== undefined
    }
    return false
  })
}

/** 双向对齐核心：value 应与声明类型 type 对齐（union 任一支通过即可） */
export function alignValue(ctx: AlignmentContext, value: unknown, type: ts.Type, at: string, depth = 0): AlignmentIssue[] {
  if (value === null || value === undefined) {
    const allowsNullish = unionConstituents(type).some(
      (t) => (t.flags & NULLISH) !== 0 || t.flags & ts.TypeFlags.Any,
    )
    return allowsNullish ? [] : [{ at, problem: `运行时为 ${String(value)}，声明不含 null/undefined` }]
  }
  const constituents = unionConstituents(type).filter((t) => !(t.flags & NULLISH))
  if (constituents.length === 0) return [{ at, problem: '声明为 null/undefined，运行时却有值' }]
  let best: AlignmentIssue[] | null = null
  for (const c of constituents) {
    const issues = alignNonUnion(ctx, value, c, at, depth)
    if (issues.length === 0) return []
    if (!best || issues.length < best.length) best = issues
  }
  return best ?? []
}

function alignNonUnion(ctx: AlignmentContext, value: unknown, type: ts.Type, at: string, depth: number): AlignmentIssue[] {
  // 开放形状（索引签名在场）与叶子类型不做封闭键集断言（决策7）
  if (!isOwnClosedObjectType(ctx, type)) return []
  if (typeof value !== 'object' || value === null) {
    return [{ at, problem: '声明为封闭对象形状，运行时不是对象' }]
  }
  if (depth >= MAX_DEPTH) return []
  const issues: AlignmentIssue[] = []
  const declared = ctx.checker.getPropertiesOfType(type)
  const declaredNames = new Map(declared.map((s) => [s.getName(), s]))
  const runtimeKeys = runtimeKeysWithoutPrivate(value)
  // 方向1：声明必需成员必须在运行时在位；可选成员合法缺席放行（决策8）。
  // 可选性判据走公开 AST 面（成员声明节点的 questionToken），getSymbolFlags 不在 TS 公开 d.ts 内。
  for (const s of declared) {
    const name = s.getName()
    if (runtimeKeys.includes(name)) continue
    if (!isOptionalMember(s)) issues.push({ at: `${at}.${name}`, problem: '声明必需成员在运行时缺失' })
  }
  // 方向2：运行时不得出现声明外成员（未知可选名同判红；下划线私有不计）
  for (const key of runtimeKeys) {
    if (!declaredNames.has(key)) issues.push({ at: `${at}.${key}`, problem: '实现多出声明外成员' })
  }
  // 封闭嵌套下钻：仅当两侧都是封闭对象形状（叶子/函数/开放形状到顶）
  for (const key of runtimeKeys) {
    const sym = declaredNames.get(key)
    if (!sym) continue
    const rv = (value as Record<string, unknown>)[key]
    if (rv === null || rv === undefined || typeof rv !== 'object') continue
    const memberType = ctx.checker.getTypeOfSymbol(sym)
    const memberConstituents = unionConstituents(memberType).filter((t) => !(t.flags & NULLISH))
    if (!memberConstituents.some((t) => isOwnClosedObjectType(ctx, t))) continue
    issues.push(...alignValue(ctx, rv, memberType, `${at}.${key}`, depth + 1))
  }
  return issues
}

/** 顶层导出对齐：声明值导出 ↔ 模块运行时键，双向（决策11「未处理顶层导出」判红） */
export function alignModuleExportNames(
  ctx: AlignmentContext,
  moduleName: string,
  declFile: string,
  runtimeModule: Record<string, unknown>,
): AlignmentIssue[] {
  const issues: AlignmentIssue[] = []
  const declared = declaredValueExports(ctx, declFile)
  const declaredNames = new Set(declared.map((e) => e.name))
  const runtimeKeys = Object.keys(runtimeModule).filter((k) => !k.startsWith('_'))
  for (const name of declaredNames) {
    if (!(name in runtimeModule)) issues.push({ at: `${moduleName}.${name}`, problem: '声明导出在运行时模块缺失' })
  }
  for (const key of runtimeKeys) {
    if (!declaredNames.has(key)) issues.push({ at: `${moduleName}.${key}`, problem: '实现多出未声明顶层导出' })
  }
  return issues
}

/**
 * 单模块全量对齐（spec 编排用）：
 * ① 顶层导出名双向；② 需样本根导出缺根判红（决策11「缺失样本根」）；
 * ③ 登记了不存在导出的根判红（登记表防朽）；④ 已登记根取得真实样本做深对齐；
 * ⑤ own 封闭常量对象深对齐。
 */
export function alignModule(
  ctx: AlignmentContext,
  moduleName: string,
  declFile: string,
  runtimeModule: Record<string, unknown>,
  sampleRoots: Record<string, () => unknown>,
): AlignmentIssue[] {
  const issues = alignModuleExportNames(ctx, moduleName, declFile, runtimeModule)
  const declared = declaredValueExports(ctx, declFile)
  const declaredNames = new Set(declared.map((e) => e.name))
  for (const exp of declared) {
    if (needsSampleRoot(ctx, exp) && !(exp.name in sampleRoots)) {
      issues.push({ at: `${moduleName}.${exp.name}`, problem: '需样本根的导出（工厂/类/封闭结果）未登记样本根' })
    }
  }
  for (const rootName of Object.keys(sampleRoots)) {
    if (!declaredNames.has(rootName)) {
      issues.push({ at: `${moduleName}.${rootName}`, problem: '样本根登记了声明中不存在的导出' })
    }
  }
  for (const [rootName, factory] of Object.entries(sampleRoots)) {
    if (!declaredNames.has(rootName)) continue
    const exp = declared.find((e) => e.name === rootName)!
    let sample: unknown
    try {
      sample = factory()
    } catch (err) {
      issues.push({ at: `${moduleName}.${rootName}()`, problem: `样本根取得失败：${(err as Error).message}` })
      continue
    }
    const type = exp.kind === 'class' ? classInstanceType(ctx, exp.symbol) : functionReturnType(ctx, exp.symbol)
    if (!type) continue
    issues.push(...alignValue(ctx, sample, type, `${moduleName}.${rootName}()`))
  }
  for (const exp of declared) {
    if (exp.kind !== 'const' || !(exp.name in runtimeModule)) continue
    if (!constIsClosedObject(ctx, exp)) continue
    issues.push(...alignValue(ctx, runtimeModule[exp.name], ctx.checker.getTypeOfSymbol(exp.symbol), `${moduleName}.${exp.name}`))
  }
  return issues
}

/** 私有句柄状态（决策12）：用 TS AST 读工厂体内 `const state = { ... }` 对象字面量的键序集 */
export function extractFactoryStateKeys(sourceText: string, factoryName: string): string[] {
  const sf = ts.createSourceFile('probe.js', sourceText, ts.ScriptTarget.ES2022, true)
  let keys: string[] | null = null
  const findStateLiteral = (node: ts.Node): void => {
    if (keys) return
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'state' &&
      node.initializer && ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = node.initializer.properties.map((p) => {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) return p.name.getText(sf)
        return null
      }).filter((n): n is string => n !== null)
      return
    }
    ts.forEachChild(node, findStateLiteral)
  }
  const visit = (node: ts.Node): void => {
    if (keys) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === factoryName && node.body) {
      ts.forEachChild(node.body, findStateLiteral)
      if (keys) return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (!keys) throw new Error(`工厂 ${factoryName} 体内未找到 const state = { ... } 字面量`)
  return keys
}

/** 声明接口成员名（checker 解析，私有状态对齐的声明侧来源） */
export function declaredInterfaceMemberNames(ctx: AlignmentContext, declFile: string, interfaceName: string): string[] {
  const symbol = moduleExports(ctx, declFile).get(interfaceName)
  if (!symbol) throw new Error(`接口 ${interfaceName} 不在 ${declFile} 导出面`)
  return ctx.checker.getPropertiesOfType(ctx.checker.getDeclaredTypeOfSymbol(symbol)).map((s) => s.getName())
}

/** 声明类实例成员名（checker 解析；公开类方法面对齐的声明侧来源） */
export function declaredClassMemberNames(ctx: AlignmentContext, declFile: string, className: string): string[] {
  const symbol = moduleExports(ctx, declFile).get(className)
  if (!symbol) throw new Error(`类 ${className} 不在 ${declFile} 导出面`)
  return ctx.checker.getPropertiesOfType(ctx.checker.getDeclaredTypeOfSymbol(symbol)).map((s) => s.getName())
}

/** 双向键集差集（私有状态与顶层对齐共用语义）：必需缺失 = 声明有运行时无 */
export function bidirectionalKeyIssues(
  at: string,
  declaredNames: string[],
  runtimeNames: string[],
  opts: { ignoreUnderscoreRuntime?: boolean } = {},
): AlignmentIssue[] {
  const issues: AlignmentIssue[] = []
  const runtimeSet = new Set(
    opts.ignoreUnderscoreRuntime === false ? runtimeNames : runtimeNames.filter((k) => !k.startsWith('_')),
  )
  const declaredSet = new Set(declaredNames)
  for (const name of declaredNames) {
    if (!runtimeSet.has(name)) issues.push({ at: `${at}.${name}`, problem: '声明成员在实现侧缺失' })
  }
  for (const key of runtimeSet) {
    if (!declaredSet.has(key)) issues.push({ at: `${at}.${key}`, problem: '实现多出声明外成员' })
  }
  return issues
}
