import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface GpuInfo {
  index: number;
  name: string;
  temperature: number;
  gpuUtil: number;
  memUtil: number;
  memUsed: number;
  memTotal: number;
  powerDraw: number;
  powerLimit: number;
}

interface GpuProcess {
  pid: number;
  name: string;
  memUsed: number;
}

interface GpuData {
  gpus: GpuInfo[];
  processes: GpuProcess[];
  timestamp: number;
  error: string | null;
}

interface CpuCore {
  name: string;
  usage: number;
}

interface CpuData {
  name: string;
  usage: number;
  cores: CpuCore[];
  memoryUsed: number;
  memoryTotal: number;
  power: number | null;
  temperature: number | null;
  timestamp: number;
  error: string | null;
}

let previousCpuTimes: os.CpuInfo[] | undefined;
let previousCpuEnergy: { energy: number; timestamp: number } | undefined;

function readCpuTemperature(): number | null {
  try {
    const thermalRoot = '/sys/class/thermal';
    const zones = fs.readdirSync(thermalRoot).filter(name => name.startsWith('thermal_zone'));
    const temperatures = zones.map(zone => {
      const value = Number(fs.readFileSync(path.join(thermalRoot, zone, 'temp'), 'utf8').trim());
      return value > 1000 ? value / 1000 : value;
    }).filter(value => Number.isFinite(value) && value > 0 && value < 120);
    return temperatures.length > 0 ? Math.round(Math.max(...temperatures)) : null;
  } catch {
    return null;
  }
}

function readCpuPower(): number | null {
  try {
    const powerRoot = '/sys/class/powercap';
    const domains = fs.readdirSync(powerRoot).filter(name => name.startsWith('intel-rapl'));
    let energy = 0;
    for (const domain of domains) {
      const file = path.join(powerRoot, domain, 'energy_uj');
      if (fs.existsSync(file)) {
        energy += Number(fs.readFileSync(file, 'utf8').trim());
      }
    }
    if (!Number.isFinite(energy)) { return null; }
    const now = Date.now();
    const previous = previousCpuEnergy;
    previousCpuEnergy = { energy, timestamp: now };
    if (!previous || now <= previous.timestamp || energy < previous.energy) { return null; }
    return Math.round(((energy - previous.energy) / 1_000_000) / ((now - previous.timestamp) / 1000));
  } catch {
    return null;
  }
}

function parseCpuData(): CpuData {
  const timestamp = Date.now();
  try {
    const current = os.cpus();
    if (current.length === 0) {
      throw new Error('No CPU information available');
    }

    const cores = current.map((cpu, index) => {
      const previous = previousCpuTimes?.[index];
      const currentTotal = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      const currentIdle = cpu.times.idle;
      const previousTotal = previous
        ? Object.values(previous.times).reduce((sum, value) => sum + value, 0)
        : currentTotal;
      const previousIdle = previous?.times.idle ?? currentIdle;
      const totalDelta = currentTotal - previousTotal;
      const idleDelta = currentIdle - previousIdle;
      const usage = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
      return { name: `CPU ${index + 1}`, usage: Math.round(usage) };
    });
    previousCpuTimes = current;

    const usage = cores.length > 0
      ? Math.round(cores.reduce((sum, core) => sum + core.usage, 0) / cores.length)
      : 0;
    const memoryTotal = os.totalmem();
    const memoryUsed = memoryTotal - os.freemem();

    return {
      name: current[0].model || 'CPU Usage',
      usage,
      cores,
      memoryUsed,
      memoryTotal,
      power: readCpuPower(),
      temperature: readCpuTemperature(),
      timestamp,
      error: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: 'CPU Usage', usage: 0, cores: [], memoryUsed: 0, memoryTotal: 0, power: null, temperature: null, timestamp, error: message };
  }
}

function parseGpuData(nvidiaSmiPath: string): GpuData {
  const timestamp = Date.now();
  try {
    const gpuRaw = execSync(
      `${nvidiaSmiPath} --query-gpu=index,name,temperature.gpu,utilization.gpu,` +
      `utilization.memory,memory.used,memory.total,power.draw,power.limit ` +
      `--format=csv,noheader,nounits`,
      { encoding: 'utf8', timeout: 5000 }
    );

    const gpus: GpuInfo[] = gpuRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          index:       parseInt(p[0], 10),
          name:        p[1],
          temperature: parseInt(p[2], 10),
          gpuUtil:     parseInt(p[3], 10),
          memUtil:     parseInt(p[4], 10),
          memUsed:     parseInt(p[5], 10),
          memTotal:    parseInt(p[6], 10),
          powerDraw:   parseFloat(p[7]) || 0,
          powerLimit:  parseFloat(p[8]) || 0,
        };
      });

    const procRaw = execSync(
      `${nvidiaSmiPath} --query-compute-apps=pid,process_name,used_gpu_memory ` +
      `--format=csv,noheader,nounits`,
      { encoding: 'utf8', timeout: 5000 }
    );

    const processes: GpuProcess[] = procRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          pid:     parseInt(p[0], 10),
          name:    p[1],
          memUsed: parseInt(p[2], 10),
        };
      });

    return { gpus, processes, timestamp, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { gpus: [], processes: [], timestamp, error: message };
  }
}

function getWebviewContent(): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GPU Monitor</title>
  <style>
    :root {
      --bg-card:   var(--vscode-editor-inactiveSelectionBackground);
      --border:    var(--vscode-panel-border);
      --text:      var(--vscode-foreground);
      --text-dim:  var(--vscode-descriptionForeground);
      --accent:    var(--vscode-activityBarBadge-background);
      --green:     var(--vscode-terminal-ansiGreen);
      --yellow:    var(--vscode-terminal-ansiYellow);
      --red:       var(--vscode-terminal-ansiRed);
      --cyan:      var(--vscode-terminal-ansiCyan);
      --font-mono: var(--vscode-editor-font-family);
      --font-size: var(--vscode-editor-font-size);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--vscode-sideBar-background);
      color: var(--text);
      font-family: var(--font-mono), 'Courier New', monospace;
      font-size: var(--font-size, 12px);
      padding: 8px;
      overflow-x: hidden;
    }
    #loading {
      color: var(--text-dim);
      text-align: center;
      padding: 20px 0;
      font-size: 0.9em;
    }
    .error-banner {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      padding: 8px 10px;
      border-radius: 3px;
      font-size: 0.82em;
      margin-bottom: 8px;
      word-break: break-all;
      line-height: 1.4;
    }
    .gpu-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .gpu-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 9px;
      padding-bottom: 7px;
      border-bottom: 1px solid var(--border);
    }
    .gpu-name {
      color: var(--cyan);
      font-weight: bold;
      font-size: 1.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80%;
    }
    .gpu-index-badge {
      background: var(--accent, #007acc);
      color: #fff;
      border-radius: 3px;
      padding: 1px 7px;
      font-size: 0.8em;
      flex-shrink: 0;
    }
    .stat-row {
      display: grid;
      grid-template-columns: 60px 1fr 46px;
      align-items: center;
      gap: 6px;
      margin: 3px 0;
    }
    .stat-label {
      color: var(--text-dim);
      font-size: 0.82em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat-bar { letter-spacing: -1px; }
    .flex-bar { position: relative; min-width: 14ch; width: 100%; height: 1em; overflow: hidden; letter-spacing: -1px; white-space: nowrap; line-height: 1; }
    .flex-bar-empty, .flex-bar-fill { position: absolute; left: 0; top: 0; overflow: hidden; white-space: nowrap; }
    .flex-bar-empty { color: var(--border, #333); }
    .flex-bar-fill { height: 1em; color: var(--green); }
    .flex-bar-fill.warn { color: var(--yellow); }
    .flex-bar-fill.hot { color: var(--red); }
    .stat-value {
      text-align: right;
      font-size: 0.85em;
      color: var(--text-dim);
    }
    .bar-filled      { color: var(--green); }
    .bar-filled.warn { color: var(--yellow); }
    .bar-filled.hot  { color: var(--red); }
    .bar-empty       { color: var(--border, #333); }
    .footer-row {
      display: flex;
      justify-content: space-between;
      margin-top: 7px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 0.8em;
      gap: 4px;
    }
    .footer-row span { white-space: nowrap; }
    .temp-ok   { color: var(--green); }
    .temp-warm { color: var(--yellow); }
    .temp-hot  { color: var(--red); }
    .section-header {
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 0.78em;
      padding: 6px 0 4px 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 4px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.83em; }
    th {
      color: var(--text-dim);
      text-align: left;
      padding: 3px 5px;
      font-weight: normal;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.8em;
    }
    td { padding: 3px 5px; border-top: 1px solid var(--border); }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .proc-pid  { color: var(--text-dim); }
    .proc-name {
      color: var(--cyan);
      max-width: 130px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .proc-mem  { color: var(--yellow); text-align: right; }
    .proc-section { margin-bottom: 8px; }
    .timestamp {
      color: var(--text-dim);
      font-size: 0.72em;
      text-align: right;
      padding-top: 2px;
      opacity: 0.7;
    }
    .hidden { display: none !important; }
    .tabs { display: flex; gap: 4px; margin-bottom: 8px; }
    .tab { flex: 1; border: 1px solid var(--border); background: transparent; color: var(--text-dim); padding: 5px; cursor: pointer; font: inherit; }
    .tab.active { background: var(--accent, #007acc); color: #fff; }
    .core-grid { display: flex; flex-wrap: wrap; gap: 6px; }
    .core-card { position: relative; display: flex; align-items: center; justify-content: center; flex: 0 0 38px; width: 38px; height: 38px; min-width: 38px; min-height: 38px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; overflow: visible; }
    .core-color { width: 22px; height: 22px; border-radius: 3px; }
    .core-color.low { background: var(--green); }
    .core-color.warn { background: var(--yellow); }
    .core-color.hot { background: var(--red); }
    .core-card::after { content: attr(data-tooltip); position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 10; display: none; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); border: 1px solid var(--border); border-radius: 3px; padding: 4px 7px; white-space: nowrap; font-size: 0.8em; box-shadow: 0 2px 6px rgba(0,0,0,0.25); }
    .core-card:hover::after { display: block; }
    .core-card-header { display: flex; justify-content: space-between; align-items: center; gap: 5px; color: var(--text-dim); font-size: 0.82em; margin-bottom: 5px; white-space: nowrap; }
    .core-card-value { color: var(--text); }
    .core-card .stat-bar { margin-top: auto; }
  </style>
</head>
<body>
  <div id="root">
    <div class="tabs">
      <button class="tab active" data-mode="gpu">GPU</button>
      <button class="tab" data-mode="cpu">CPU</button>
    </div>
    <div id="loading">Waiting for GPU data...</div>
    <div id="error-banner" class="error-banner hidden"></div>
    <div id="gpu-cards"></div>
    <div id="cpu-content" class="hidden"></div>
    <div id="processes-section" class="proc-section hidden">
      <div class="section-header">Compute Processes</div>
      <table>
        <thead>
          <tr>
            <th>PID</th>
            <th>Process</th>
            <th style="text-align:right">VRAM</th>
          </tr>
        </thead>
        <tbody id="processes-body"></tbody>
      </table>
    </div>
    <div id="timestamp" class="timestamp hidden"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const BAR_WIDTH = 14;

    function renderBar(percent, warn, hot, width) {
      warn = warn === undefined ? 75 : warn;
      hot  = hot  === undefined ? 90 : hot;
      width = width === undefined ? BAR_WIDTH : width;
      const pct     = Math.max(0, Math.min(100, percent || 0));
      const filled  = Math.round((pct / 100) * width);
      const empty   = width - filled;
      let cls = 'bar-filled';
      if (pct >= hot)  { cls = 'bar-filled hot'; }
      else if (pct >= warn) { cls = 'bar-filled warn'; }
      const f = filled > 0 ? '<span class="' + cls + '">' + '▓'.repeat(filled) + '</span>' : '';
      const e = empty  > 0 ? '<span class="bar-empty">'  + '░'.repeat(empty)  + '</span>' : '';
      return f + e;
    }

    function formatMem(mib) {
      if (!mib || isNaN(mib)) { return '0 MiB'; }
      return mib >= 1024 ? (mib / 1024).toFixed(1) + ' GiB' : mib + ' MiB';
    }

    function formatBytes(bytes) {
      return formatMem(Math.round(bytes / (1024 * 1024)));
    }

    function renderFlexBar(percent, warn, hot) {
      warn = warn === undefined ? 75 : warn;
      hot = hot === undefined ? 90 : hot;
      const pct = Math.max(0, Math.min(100, percent || 0));
      let cls = 'flex-bar-fill';
      if (pct >= hot) { cls += ' hot'; }
      else if (pct >= warn) { cls += ' warn'; }
      const texture = '░'.repeat(100);
      const filled = '▓'.repeat(100);
      return '<div class="flex-bar"><span class="flex-bar-empty">' + texture + '</span>' +
        '<span class="' + cls + '" style="width:' + pct + '%">' + filled + '</span></div>';
    }

    function renderCpu(data) {
      const memoryPct = data.memoryTotal > 0 ? (data.memoryUsed / data.memoryTotal) * 100 : 0;
      const rows = data.cores.map(function(core) {
        let level = 'low';
        if (core.usage >= 90) { level = 'hot'; }
        else if (core.usage >= 75) { level = 'warn'; }
        return '<div class="core-card" data-tooltip="' + core.name + ': ' + core.usage + '%"><div class="core-color ' + level + '"></div></div>';
      }).join('');
      return '<div class="gpu-card"><div class="gpu-card-header"><span class="gpu-name">' + escHtml(data.name || 'CPU Usage') + '</span>' +
        '<span class="gpu-index-badge">' + data.usage + '%</span></div>' +
        '<div class="stat-row"><span class="stat-label">TOTAL</span><span class="stat-bar">' + renderFlexBar(data.usage) + '</span><span class="stat-value">' + data.usage + '%</span></div>' +
        '<div class="stat-row"><span class="stat-label">RAM</span><span class="stat-bar">' + renderFlexBar(memoryPct) + '</span><span class="stat-value">' + Math.round(memoryPct) + '%</span></div>' +
        '<div class="footer-row"><span>' + formatBytes(data.memoryUsed) + ' / ' + formatBytes(data.memoryTotal) + '</span><span>POWER ' + (data.power === null ? 'N/A' : data.power + 'W') + '</span><span>TEMP ' + (data.temperature === null ? 'N/A' : data.temperature + '°C') + '</span></div></div>' +
        '<div class="section-header">Per-core usage</div><div class="core-grid">' + rows + '</div>';
    }

    function tempClass(c) {
      if (c >= 85) { return 'temp-hot'; }
      if (c >= 70) { return 'temp-warm'; }
      return 'temp-ok';
    }

    function escHtml(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderGpuCard(g) {
      const memPct   = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
      const pwrPct   = g.powerLimit > 0 ? (g.powerDraw / g.powerLimit) * 100 : 0;
      const tClass   = tempClass(g.temperature);
      return [
        '<div class="gpu-card">',
        '  <div class="gpu-card-header">',
        '    <span class="gpu-name">' + escHtml(g.name) + '</span>',
        '    <span class="gpu-index-badge">GPU ' + g.index + '</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">GPU</span>',
        '    <span class="stat-bar">' + renderFlexBar(g.gpuUtil) + '</span>',
        '    <span class="stat-value">' + g.gpuUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">VRAM</span>',
        '    <span class="stat-bar">' + renderFlexBar(memPct) + '</span>',
        '    <span class="stat-value">' + Math.round(memPct) + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">MEM BW</span>',
        '    <span class="stat-bar">' + renderFlexBar(g.memUtil) + '</span>',
        '    <span class="stat-value">' + g.memUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">POWER</span>',
        '    <span class="stat-bar">' + renderFlexBar(pwrPct, 70, 90) + '</span>',
        '    <span class="stat-value">' + Math.round(g.powerDraw) + 'W</span>',
        '  </div>',
        '  <div class="footer-row">',
        '    <span>' + formatMem(g.memUsed) + ' / ' + formatMem(g.memTotal) + '</span>',
        '    <span>TEMP <span class="' + tClass + '">' + g.temperature + '°C</span></span>',
        '    <span>TDP ' + Math.round(g.powerLimit) + 'W</span>',
        '  </div>',
        '</div>',
      ].join('\\n');
    }

    function renderProcRow(p) {
      return [
        '<tr>',
        '  <td class="proc-pid">' + p.pid + '</td>',
        '  <td class="proc-name" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</td>',
        '  <td class="proc-mem">' + formatMem(p.memUsed) + '</td>',
        '</tr>',
      ].join('');
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'gpuData' && msg.type !== 'cpuData') { return; }
      const data = msg.payload;

      const loadingEl   = document.getElementById('loading');
      const errorEl     = document.getElementById('error-banner');
      const cardsEl     = document.getElementById('gpu-cards');
      const cpuEl       = document.getElementById('cpu-content');
      const procSecEl   = document.getElementById('processes-section');
      const procBodyEl  = document.getElementById('processes-body');
      const tsEl        = document.getElementById('timestamp');

      if (loadingEl) { loadingEl.classList.add('hidden'); }

      if (data.error) {
        errorEl.textContent = '⚠ ' + (msg.type === 'gpuData' ? 'nvidia-smi' : 'CPU') + ' error: ' + data.error;
        errorEl.classList.remove('hidden');
        cardsEl.innerHTML = '';
        cpuEl.innerHTML = '';
        procSecEl.classList.add('hidden');
        return;
      }

      errorEl.classList.add('hidden');
      if (msg.type === 'gpuData') {
        cardsEl.innerHTML = data.gpus.map(renderGpuCard).join('');
        cpuEl.innerHTML = '';

        if (data.processes && data.processes.length > 0) {
          procBodyEl.innerHTML = data.processes.map(renderProcRow).join('');
          procSecEl.classList.remove('hidden');
        } else {
          procSecEl.classList.add('hidden');
        }
      } else {
        cardsEl.innerHTML = '';
        procSecEl.classList.add('hidden');
        cpuEl.innerHTML = renderCpu(data);
      }

      tsEl.textContent = 'Updated ' + new Date(data.timestamp).toLocaleTimeString();
      tsEl.classList.remove('hidden');
    });

    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(other) { other.classList.remove('active'); });
        tab.classList.add('active');
        const mode = tab.getAttribute('data-mode') || 'gpu';
        document.getElementById('gpu-cards').classList.toggle('hidden', mode !== 'gpu');
        document.getElementById('processes-section').classList.toggle('hidden', mode !== 'gpu');
        document.getElementById('cpu-content').classList.toggle('hidden', mode !== 'cpu');
        document.getElementById('loading').textContent = 'Waiting for ' + mode.toUpperCase() + ' data...';
        vscode.postMessage({ type: 'setMode', mode: mode });
      });
    });
  </script>
</body>
</html>`;
}

class GpuMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nvidiagpumonitor.panel';

  private _view?: vscode.WebviewView;
  private _intervalHandle?: ReturnType<typeof setInterval>;
  private _mode: 'gpu' | 'cpu' = 'gpu';

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent();
    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'setMode' && (message.mode === 'gpu' || message.mode === 'cpu')) {
        this._mode = message.mode;
        this._startPolling();
      }
    });

    this._startPolling();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._startPolling();
      } else {
        this._stopPolling();
      }
    });

    webviewView.onDidDispose(() => {
      this._stopPolling();
    });
  }

  private _startPolling(): void {
    this._stopPolling();
    const config = vscode.workspace.getConfiguration('nvidiagpumonitor');
    const interval = config.get<number>('refreshInterval', 2000);
    const smiPath = config.get<string>('nvidiaSmiPath', 'nvidia-smi');

    this._sendData(smiPath);
    this._intervalHandle = setInterval(() => this._sendData(smiPath), interval);
  }

  private _stopPolling(): void {
    if (this._intervalHandle !== undefined) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
    }
  }

  private _sendData(smiPath: string): void {
    if (!this._view?.visible) { return; }
    if (this._mode === 'cpu') {
      this._view.webview.postMessage({ type: 'cpuData', payload: parseCpuData() });
    } else {
      this._view.webview.postMessage({ type: 'gpuData', payload: parseGpuData(smiPath) });
    }
  }

  public restartPolling(): void {
    this._startPolling();
  }

  public forceRefresh(): void {
    const config = vscode.workspace.getConfiguration('nvidiagpumonitor');
    const smiPath = config.get<string>('nvidiaSmiPath', 'nvidia-smi');
    this._sendData(smiPath);
  }

  public dispose(): void {
    this._stopPolling();
  }
}

let provider: GpuMonitorViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  provider = new GpuMonitorViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GpuMonitorViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nvidiagpumonitor.refresh', () => {
      provider?.forceRefresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('nvidiagpumonitor')) {
        provider?.restartPolling();
      }
    })
  );
}

export function deactivate(): void {
  provider?.dispose();
}
