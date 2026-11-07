'use strict';
// 工单423 回收探针：独立进程创建回调窗并直调 Shell_NotifyIconW 注册合成托盘图标，
// 然后挂住等待被强杀（taskkill /F，不留注销）——面板侧回收判据（宿主进程句柄
// signaled）据此在时限内广播 reaped。图标用纯色方块（magenta/cyan 由 argv 指定），
// 供 spike 页像素级「条目消失/对照在场」断言（dominantColor 众数即该纯色）。
// 握手：pid/hwnd/uid/ok 写 JSON 到 argv[2]，控制器据此断言与强杀。
//
// koffi 具名类型进程级单登坑只影响同进程重注册——探针是独立短命进程，类型名可自用。
const fs = require('fs');
const koffi = require('koffi');

const out = process.argv[2];
const uid = parseInt(process.argv[3], 10);
const tooltip = process.argv[4] || 'DECK-REAP-PROBE';
const rgb = process.argv[5] || '255,0,255'; // B,G,R 填充色（magenta 默认）

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const shell32 = koffi.load('shell32.dll');

const result = { pid: process.pid, hwnd: 0, uid, ok: false, stage: '' };
const finish = () => {
  try { fs.writeFileSync(out, JSON.stringify(result)); } catch { /* 控制器轮询不到即判负 */ }
};
process.on('uncaughtException', (err) => {
  result.stage = `uncaught: ${err && err.message}`;
  finish();
  process.exit(1);
});

try {
  // 回调窗（host.ts 同款形态）：零尺寸隐藏工具窗，属主是本进程——回收判据看的就是它。
  // 具名类型先登（koffi 函数签名引用它时必须已在册）。
  koffi.proto('__stdcall', 'ReapProbeWndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);
  const wcType = koffi.struct('ReapProbeWC', {
    cbSize: 'uint32', style: 'uint32', lpfnWndProc: 'ReapProbeWndProc *',
    cbClsExtra: 'int32', cbWndExtra: 'int32', hInstance: 'uintptr_t',
    hIcon: 'uintptr_t', hCursor: 'uintptr_t', hbrBackground: 'uintptr_t',
    lpszMenuName: 'uintptr_t', lpszClassName: 'char16_t *', hIconSm: 'uintptr_t',
  });
  const defWindowProc = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)');
  const getModuleHandle = kernel32.func('uintptr_t __stdcall GetModuleHandleW(uintptr_t name)');
  const atom = user32.func('uint16 __stdcall RegisterClassExW(ReapProbeWC *wc)');
  const createWindow = user32.func('uintptr_t __stdcall CreateWindowExW(uint32 ex, const char16_t *cls, const char16_t *name, uint32 style, int x, int y, int w, int h, uintptr_t parent, uintptr_t menu, uintptr_t hinst, uintptr_t param)');
  const wndproc = koffi.register((h, msg, wp, lp) => {
    return defWindowProc(h, msg, wp, lp);
  }, 'ReapProbeWndProc *');
  const hinst = Number(getModuleHandle(0));
  const wc = {
    cbSize: koffi.sizeof(wcType), style: 0, lpfnWndProc: wndproc,
    cbClsExtra: 0, cbWndExtra: 0, hInstance: hinst,
    hIcon: 0, hCursor: 0, hbrBackground: 0,
    lpszMenuName: 0, lpszClassName: 'DeckReapProbeWnd', hIconSm: 0,
  };
  if (!atom(wc)) { result.stage = 'RegisterClassExW'; throw new Error('RegisterClassExW 失败'); }
  const hwnd = Number(createWindow(
    0x80 | 0x08000000 /* WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE */, 'DeckReapProbeWnd', 'DeckReapProbeWnd',
    0x80000000 /* WS_POPUP */, 0, 0, 0, 0, 0, 0, hinst, 0,
  ));
  if (!hwnd) { result.stage = 'CreateWindowExW'; throw new Error('CreateWindowExW 失败'); }
  result.hwnd = hwnd;

  // 纯色 32bpp 图标：CreateIcon(hInst, 32, 32, 1, 32, andBits, xorBits)——AND 全 0
  // （不透明），XOR 填 argv 色（BGR 顺序 + alpha 255）。dominantColor 众数即该色。
  const [b, g, r] = rgb.split(',').map((s) => parseInt(s, 10) & 0xff);
  const xor = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < xor.length; i += 4) { xor[i] = b; xor[i + 1] = g; xor[i + 2] = r; xor[i + 3] = 255; }
  const and = Buffer.alloc(4 * 32); // 1bpp 行跨 4 字节 × 32 行，全 0 = 全不透明
  const createIcon = user32.func('uintptr_t __stdcall CreateIcon(uintptr_t hInst, int w, int h, uint8 planes, uint8 bitsPixel, const void *andBits, const void *xorBits)');
  const hicon = Number(createIcon(hinst, 32, 32, 1, 32, and, xor));
  if (!hicon) { result.stage = 'CreateIcon'; throw new Error('CreateIcon 失败'); }

  // 注册合成图标（nid 构造复用 dist 协议层——一处来源，不手写字节布局）
  const { encodeNotifyIconData } = require(pathJoin());
  const nid = encodeNotifyIconData({
    arch: 'x64', version: 3, hwnd, uid,
    flags: 0x1 | 0x2 | 0x4 /* NIF_MESSAGE | NIF_ICON | NIF_TIP */,
    callbackMessage: 0x8000 + 95, hicon, tooltip,
  });
  const shellNotifyIcon = shell32.func('bool __stdcall Shell_NotifyIconW(uint32 dwMessage, void *nid)');
  const ok = Boolean(shellNotifyIcon(0 /* NIM_ADD */, nid));
  result.ok = ok;
  if (!ok) { result.stage = 'Shell_NotifyIconW'; throw new Error('Shell_NotifyIconW(NIM_ADD) 失败'); }
  finish();
  setInterval(() => {}, 1000); // 挂住等强杀
} catch (err) {
  result.stage = result.stage || 'setup';
  result.error = err && err.message;
  finish();
  process.exit(1);
}

function pathJoin() {
  return require('path').resolve(__dirname, '../../dist/main/trayhost/protocol.js');
}
