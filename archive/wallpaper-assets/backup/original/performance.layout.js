// performance.layout.js

/* After editing, it is recommended renaming the file to "performance.layout.user.js" (or duplicating and  renaming the file) to prevent it from being overwritten by wallpaper updates. */

function buildPerformanceHTML({ metric, spaces }) {
  // helpers
  const BR = `<p><br /></p>`;
  // BR: Inserts an empty line

  const L = (text, isLabel = true) => (isLabel ? `<span class="name">${text}</span>` : text);
  // L: Label text helper
  //    - isLabel = true (default) → wrapped with .name (transparent)
  //    - isLabel = false → raw text (normal emphasis)

  const row = (...args) => `<p>${args.join("")}</p>`;
  // row: Creates one display row

  /*
    metric(options)
    
    Displays a single performance value.
    Only `source` and its corresponding `key` are required.
    
    options:
    - sources : Array of data sources to try in order.
        [
          { source: "hwinfo", key: "<HWiNFO label>", pick?: "value" | "valueraw" | "sensor" | "label" },
          { source: "psutil", key: "<psutil key>", unit?: "<unit>" }
        ]
    
      The first available source is used automatically.

    - format : Display formatter (optional)
        "compact"
          - Requires: numeric text (e.g. "12.34 %")
          - Example: 12.34 % → 12.3%

        "fixed"
          - Requires: numeric text
          - Example: 12.34 % → 012%

        "capacity-percent"
          - Requires: "used/total" string
          - Example: 32 GB/64 GB → 050%
          - Intended for: psutil disk / memory

        "capacity-text"
          - Requires: "used/total" string
          - Example: 123.4 GB/1234.5 GB → 123GB / 1.2TB
          - Intended for: psutil disk / memory

        "net"
          - Requires: numeric value (KB/s)
          - Example: 1234.5 → 1.2 MB/s, 123.4 → 123.4 KB/s

        null / omitted
          - No formatting; uses picked text as-is
    
    - alert: { min?: number, max?: number }
        Adds visual markers when the numeric value is outside the range.
        Uses numeric value only (hwinfo: valueraw, psutil: number).
        Not meaningful when pick is "sensor" or "label".
    
    - name: true | false
        Adds the .name class (transparency will be added and can be controlled from user settings).
  */

  // sources definition
  const CPU_USAGE = [
    { source: "hwinfo", key: "Total CPU Usage", pick: "value" },
    { source: "psutil", key: "cpu", unit: "%" },
  ];
  const CPU_TEMP = [
    { source: "hwinfo", key: "CPU (Tctl/Tdie)", pick: "value" },
    { source: "psutil", key: "cpu_temp", unit: "°C" },
  ];
  const RAM_USAGE = [
    { source: "hwinfo", key: "Physical Memory Load", pick: "value" },
    { source: "psutil", key: "memory", unit: "%" },
  ];
  const RAM_CAPACITY = [{ source: "psutil", key: "memory_gb" }];

  const GPU_USAGE = [
    { source: "hwinfo", key: "GPU Core Load", pick: "value" },
    { source: "psutil", key: "gpu_usage", unit: "%" },
  ];
  const GPU_TEMP = [
    { source: "hwinfo", key: "GPU Temperature", pick: "value" },
    { source: "psutil", key: "gpu_temp", unit: "°C" },
  ];
  const GPU_POWER = [{ source: "hwinfo", key: "GPU Power", pick: "value" }];

  const VRAM_USAGE = [
    { source: "hwinfo", key: "GPU Memory Usage", pick: "value" },
    { source: "psutil", key: "vram_usage", unit: "%" },
  ];
  const VRAM_TEMP = [{ source: "hwinfo", key: "GPU Memory Junction Temperature", pick: "value" }];

  const DISK_C = [{ source: "psutil", key: "c_disk" }];
  const DISK_D = [{ source: "psutil", key: "d_disk" }];

  const NET_DL = [
    { source: "hwinfo", key: "Current DL rate", pick: "value" },
    { source: "psutil", key: "download_speed" },
  ];
  const NET_UP = [
    { source: "hwinfo", key: "Current UP rate", pick: "value" },
    { source: "psutil", key: "upload_speed" },
  ];

  // main layout
  const lines = [
    // line 1: cpu
    row(
      L("CPU"),
      spaces(4),
      metric({ sources: CPU_USAGE, format: "fixed" }),
      spaces(4),
      metric({ sources: CPU_TEMP, format: "fixed", alert: { max: 75 }, name: true }),
    ),
    BR,

    // line 2: ram
    row(
      L("RAM"),
      spaces(4),
      metric({ sources: RAM_USAGE, format: "fixed" }),
      spaces(4),
      metric({ sources: RAM_CAPACITY, format: "capacity-text", name: true }),
    ),
    BR,

    // line 3: gpu
    row(
      L("GPU"),
      spaces(4),
      metric({ sources: GPU_USAGE, format: "fixed" }),
      spaces(4),
      metric({ sources: GPU_TEMP, format: "fixed", alert: { max: 75 }, name: true }),
      spaces(4),
      metric({ sources: GPU_POWER, format: "fixed", name: true }),
    ),
    BR,

    // line 4: vRAM
    row(
      L("VRAM"),
      spaces(3),
      metric({ sources: VRAM_USAGE, format: "fixed" }),
      spaces(4),
      metric({ sources: VRAM_TEMP, format: "fixed", alert: { max: 90 }, name: true }),
    ),
    BR,

    // line 5-6: storage
    row(
      L("[C:]"),
      spaces(3),
      metric({ sources: DISK_C, format: "capacity-percent" }),
      spaces(4),
      metric({ sources: DISK_C, format: "capacity-text", name: true }),
    ),
    BR,
    row(
      L("[D:]"),
      spaces(3),
      metric({ sources: DISK_D, format: "capacity-percent" }),
      spaces(4),
      metric({ sources: DISK_D, format: "capacity-text", name: true }),
    ),
    BR,

    // line 7-8: network
    row(L("DL"), spaces(5), metric({ sources: NET_DL, format: "net" })),
    BR,
    row(L("UP"), spaces(5), metric({ sources: NET_UP, format: "net" })),
  ];

  return lines.join("");
}
