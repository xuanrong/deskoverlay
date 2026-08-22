// 系统健康视图：CPU / 内存 / 网络 / 电源 实时监控 + 系统信息 + 磁盘。
import { Bus } from "../bus.js";
import { invoke } from "../bus.js";
import { ICON_GEAR, ICON_CHIP, ICON_GLOBE, ICON_PLUG } from "../icons.js";
import { esc } from "./common.js";

export function renderSystem(view) {
  view.header.style.display = "none";
  const body = view.body;
  body.innerHTML = `
    <div class="sys-grid">
      <div class="sys-card sc-cpu">
        <div class="sys-card-head"><span class="sys-icon">${ICON_GEAR}</span><span class="sys-label">CPU</span><span class="sys-value" id="s-cpu">--</span></div>
        <div class="sys-bar"><div class="sys-bar-fill" id="s-cpu-bar"></div></div>
        <canvas class="sys-chart" id="s-cpu-chart" width="320" height="48"></canvas>
        <div class="sys-sub" id="s-cpu-sub">--</div>
      </div>
      <div class="sys-card sc-ram">
        <div class="sys-card-head"><span class="sys-icon">${ICON_CHIP}</span><span class="sys-label">内存</span><span class="sys-value" id="s-ram">--</span></div>
        <div class="sys-bar"><div class="sys-bar-fill" id="s-ram-bar"></div></div>
        <canvas class="sys-chart" id="s-ram-chart" width="320" height="48"></canvas>
        <div class="sys-sub" id="s-ram-sub">--</div>
      </div>
      <div class="sys-card sc-net">
        <div class="sys-card-head"><span class="sys-icon">${ICON_GLOBE}</span><span class="sys-label">网络</span></div>
        <div class="sys-net">
          <div class="sys-net-row"><span class="sys-net-dir down">▼ 下载</span><span class="sys-net-val" id="s-net-down">--</span></div>
          <div class="sys-net-row"><span class="sys-net-dir up">▲ 上传</span><span class="sys-net-val" id="s-net-up">--</span></div>
        </div>
        <div class="sys-sub" id="s-net-sub">实时速率</div>
      </div>
      <div class="sys-card sc-power" id="s-power-card">
        <div class="sys-card-head"><span class="sys-icon">${ICON_PLUG}</span><span class="sys-label">电源</span><span class="sys-value" id="s-power">--</span></div>
        <div class="sys-sub" id="s-power-sub">--</div>
      </div>
    </div>
    <div class="sys-info">
      <div class="sys-info-row"><span>CPU 型号</span><b id="s-cpuname">--</b></div>
      <div class="sys-info-row"><span>核心数</span><b id="s-cores">--</b></div>
      <div class="sys-info-row"><span>操作系统</span><b id="s-os">--</b></div>
      <div class="sys-info-row"><span>主机名</span><b id="s-host">--</b></div>
      <div class="sys-info-row"><span>运行时长</span><b id="s-uptime">--</b></div>
    </div>
    <div class="sys-disks">
      <div class="sys-disks-head">磁盘</div>
      <div class="sys-disks-list" id="s-disks"></div>
    </div>`;

  const els = {
    cpu: body.querySelector("#s-cpu"), cpuBar: body.querySelector("#s-cpu-bar"), cpuSub: body.querySelector("#s-cpu-sub"),
    cpuChart: body.querySelector("#s-cpu-chart"),
    ram: body.querySelector("#s-ram"), ramBar: body.querySelector("#s-ram-bar"), ramSub: body.querySelector("#s-ram-sub"),
    ramChart: body.querySelector("#s-ram-chart"),
    netDown: body.querySelector("#s-net-down"), netUp: body.querySelector("#s-net-up"),
    power: body.querySelector("#s-power"), powerSub: body.querySelector("#s-power-sub"), powerCard: body.querySelector("#s-power-card"),
    cpuName: body.querySelector("#s-cpuname"), cores: body.querySelector("#s-cores"), uptime: body.querySelector("#s-uptime"),
    os: body.querySelector("#s-os"), host: body.querySelector("#s-host"),
    disks: body.querySelector("#s-disks"),
  };

  // CPU / 内存历史采样（趋势图用，最多保留 60 个点）
  const MAX_POINTS = 60;
  const hist = { cpu: [], ram: [] };
  function chart(canvas, data, color) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = data.length;
    if (n < 2) return;
    // 折线 + 渐变填色
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.lineCap = "round";
    const pad = 2;
    const x = (i) => pad + (i / (MAX_POINTS - 1)) * (w - pad * 2);
    const y = (v) => h - pad - (Math.min(100, Math.max(0, v)) / 100) * (h - pad * 2);
    // 填充
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color.replace(")", ",0.25)").replace("rgb", "rgba"));
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.moveTo(x(0), h);
    for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(data[i]));
    ctx.lineTo(x(n - 1), h); ctx.closePath();
    ctx.fillStyle = grad;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fill();
    // 线条
    ctx.beginPath();
    for (let i = 0; i < n; i++) { if (i === 0) ctx.moveTo(x(i), y(data[i])); else ctx.lineTo(x(i), y(data[i])); }
    ctx.stroke();
  }

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
    els.netDown.textContent = `↓${fmtNet(output.netDown ?? 0)}`;
    els.netUp.textContent = `↑${fmtNet(output.netUp ?? 0)}`;

    // 电源：显示电量 + 状态；低电量告警
    const batt = output.battery ?? 0;
    const powerStr = output.power || "AC";
    if (powerStr === "BATTERY" || powerStr === "CHARGING") {
      els.power.textContent = `电池 ${batt}%`;
      els.powerSub.textContent = powerStr === "CHARGING" ? "充电中" : "使用电池";
    } else {
      els.power.textContent = "已连接电源";
      els.powerSub.textContent = batt > 0 ? `电池 ${batt}% 已充满` : "外接电源";
    }
    const lowBattery = powerStr === "BATTERY" && batt > 0 && batt <= 20;
    if (els.powerCard) els.powerCard.classList.toggle("low", lowBattery);

    // 系统信息
    els.cpuName.textContent = output.cpuName || "--";
    const logic = output.logicalCores ?? output.cpuCores;
    els.cores.textContent = `${output.cpuCores ?? "-"} 物理 / ${logic ?? "-"} 逻辑`;
    els.os.textContent = output.osName ? [output.osName, output.osVersion].filter(Boolean).join(" · ") : "--";
    els.host.textContent = output.hostName || "--";
    els.uptime.textContent = fmtUptime(output.uptime ?? 0);

    // CPU / 内存趋势
    hist.cpu.push(cpu); if (hist.cpu.length > MAX_POINTS) hist.cpu.shift();
    hist.ram.push(ram); if (hist.ram.length > MAX_POINTS) hist.ram.shift();
    if (firstTick || (hist.cpu.length & 1) === 0 || hist.cpu.length < 24) {
      chart(els.cpuChart, hist.cpu, "rgb(102,170,255)");
      chart(els.ramChart, hist.ram, "rgb(102,204,153)");
      firstTick = false;
    }

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
  let firstTick = true;
  view.onDestroy(off);
  // 系统采样仅在页面打开时进行（后端据此启停采集，空闲时停止）
  invoke("start_system_sampling").catch(() => {});
  view.onDestroy(() => { invoke("stop_system_sampling").catch(() => {}); });
}
