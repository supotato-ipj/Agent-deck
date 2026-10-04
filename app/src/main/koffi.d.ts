declare module 'koffi' {
  export interface KoffiLib {
    func(signature: string): (...args: any[]) => any
  }
  const koffi: {
    load(name: string): KoffiLib
    struct(name: string, def: Record<string, string>): unknown
    union(name: string, def: Record<string, string>): unknown
    proto(...args: unknown[]): unknown
    register(fn: (...args: any[]) => any, proto: unknown): unknown
    decode(value: Buffer | bigint | number, type: unknown): any
    sizeof(type: unknown): number
    array(type: string, len: number): unknown
  }
  export default koffi
}
