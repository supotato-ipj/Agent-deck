declare module 'koffi' {
  export interface KoffiLib {
    func(signature: string): (...args: any[]) => any
  }
  const koffi: {
    load(name: string): KoffiLib
    struct(name: string, def: Record<string, string>): unknown
    union(name: string, def: Record<string, string>): unknown
    decode(value: Buffer | bigint | number, type: string): any
    sizeof(type: unknown): number
  }
  export default koffi
}
