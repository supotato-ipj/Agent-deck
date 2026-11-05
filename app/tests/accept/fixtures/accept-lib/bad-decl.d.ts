// 工单411 层1 持久负例：坏声明夹具——d.ts 内部未知类型必须在专用声明检查面下判红。
// 本文件**不进入任何正常编译目标**：tsconfig.typecheck.json 以 exclude 排除
// tests/accept/fixtures/**，tsconfig.accept-lib.json 的 include 只覆盖 accept/lib/**。
// 仅供 accept-lib-declcheck.spec.ts 以同一专用配置构建内存程序复用（同一配置、判红）。
export declare const _spec411BrokenProbe: SPEC411_MISSING_TYPE;
