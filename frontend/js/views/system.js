// 系统健康视图：CPU / 内存 / 网络 / 电源 实时监控 + 系统信息 + 磁盘。
import { Bus } from "../bus.js";
import { ICON_GEAR, ICON_CHIP, ICON_GLOBE, ICON_PLUG } from "../icons.js";
import { esc } from "./common.js";

export function renderSystem(view) {
  view.header.innerHTML = `<div class="view-title">系统健康</div><div class="view-sub">CPU · 内存 · 网络 · 电源 实时监控</div>`;
  const body = view.body;
  body.innerHTML = `
    <div class="sys-grid">
      <div class="sys-card sc-cpu">
        <div class="sys-card-head"><span class="sys-icon">${ICON_GEAR}</span><span class="sys-label">CPU</span><span class="sys-value" id="s-cpu">--</span></div>
        <div class="sys-bar"><div class="sys-bar-fill" id="s-cpu-bar"></div></div>
        <div class="sys-sub" id="s-cpu-sub">--</div>
      </div>
      <div class="sys-card sc-ram">
        <div class="sys-card-head"><span class="sys-icon">${ICON_CHIP}</span><span class="sys-label">内存</span><span class="sys-value" id="s-ram">--</span></div>
        <div class="sys-bar"><div class="sys-bar-fill" id="s-ram-bar"></div></div>
        <div class="sys-sub" id="s-ram-sub">--</div>
      </div>
      <div class="sys-card sc-net">
        <div class="sys-card-head"><span class="sys-icon">${ICON_GLOBE}</span><span class="sys-label">网络</span><span class="sys-value" id="s-net">--</span></div>
        <div class="sys-sub net-sub" id="s-net-sub">实时速率</div>
      </div>
      <div class="sys-card sc-power">
        <div class="sys-card-head"><span class="sys-icon">${ICON_PLUG}</span><span class="sys-label">电源</span><span class="sys-value" id="s-power">--</span></div>
      </div>
    </div>
    <div class="sys-info">
      <div class="sys-info-row"><span>CPU 型号</span><b id="s-cpuname">--</b></div>
      <div class="sys-info-row"><span>物理核心</span><b id="s-cores">--</b></div>
      <div class="sys-info-row"><span>运行时长</span><b id="s-uptime">--</b></div>
    </div>
    <div class="sys-disks">
      <div class="sys-disks-head">磁盘</div>
      <div class="sys-disks-list" id="s-disks"></div>
    </div>`;

  const els = {
    cpu: body.querySelector("#s-cpu"), cpuBar: body.querySelector("#s-cpu-bar"), cpuSub: body.querySelector("#s-cpu-sub"),
    ram: body.querySelector("#s-ram"), ramBar: body.querySelector("#s-ram-bar"), ramSub: body.querySelector("#s-ram-sub"),
    net: body.querySelector("#s-net"),
    power: body.querySelector("#s-power"),
    cpuName: body.querySelector("#s-cpuname"), cores: body.querySelector("#s-cores"), uptime: body.querySelector("#s-uptime"),
    disks: body.querySelector("#s-disks"),
  };

  function fmtNet(bps) {
    return bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
  }
  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  }

  const off = Bus.on("provider-emit", ({ config_hash, output }) => {
    if (config_hash !== "system") return;
    const cpu = output.cpu ?? 0;
    els.cpu.textContent = cpu.toFixed(0) + "%";
    els.cpuBar.style.width = cpu.toFixed(0) + "%";
    els.cpuSub.textContent = `使用率 · ${output.cpuCores ?? "-"} 核`;
    const ram = output.ram ?? 0;
    els.ram.textContent = ram.toFixed(0) + "%";
    els.ramBar.style.width = ram.toFixed(0) + "%";
    els.ramSub.textContent = `已用 ${(output.ramUsedGb ?? 0).toFixed(1)} / ${(output.ramTotalGb ?? 0).toFixed(1)} GB`;
    els.net.textContent = `↓${fmtNet(output.netDown ?? 0)} ↑${fmtNet(output.netUp ?? 0)}`;
    els.power.textContent = output.power === "BATTERY" ? `电池 ${output.battery ?? 0}%` : "交流电源";
    els.cpuName.textContent = output.cpuName || "--";
    els.cores.textContent = `${output.cpuCores ?? "-"} 核`;
    els.uptime.textContent = fmtUptime(output.uptime ?? 0);
    // 磁盘列表：内容未变化时不重建，避免每秒重绘造成"刷新"感
    const disks = output.disks || [];
    const disksJson = JSON.stringify(disks);
    if (disksJson !== lastDisksJson) {
      lastDisksJson = disksJson;
      els.disks.innerHTML = disks.map((d) => `
      <div class="sys-disk">
        <div class="sys-disk-top">
          <span class="sys-disk-name">${esc(d.name || d.mount)}</span>
          <span class="sys-disk-pct">${(d.pct ?? 0).toFixed(0)}%</span>
          <span class="sys-disk-size">${(d.usedGb ?? 0).toFixed(1)} / ${(d.totalGb ?? 0).toFixed(1)} GB</span>
        </div>
        <div class="sys-bar"><div class="sys-bar-fill disk" style="width:${(d.pct ?? 0).toFixed(0)}%"></div></div>
      </div>`).join("") || `<div class="dash-empty">无磁盘信息</div>`;
    }
  });
  let lastDisksJson = "";
  view.onDestroy(off);
}
