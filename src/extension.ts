import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface GpuInfo {
  index: number;
  uuid: string;
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
  gpu: number;
  pid: number;
  name: string;
  framework: string | null;
  model: string | null;
  gpuUtil: number;
  memUsed: number;
}

interface GpuData {
  gpus: GpuInfo[];
  processes: GpuProcess[];
  timestamp: number;
  error: string | null;
}

interface CpuCore {
  id: number;
  util: number;
}

interface CpuPackage {
  id: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temperature: number | null;
  cores: CpuCore[];
}

interface CpuProcess {
  socket: number;
  pid: number;
  user: string;
  name: string;
  model: string | null;
  cpuUtil: number;
  memUsed: number;
}

interface CpuData {
  packages: CpuPackage[];
  processes: CpuProcess[];
  appearance?: Appearance;
}

interface CoreLevel {
  max: number;
  color: string;
  text: string;
  opacity: number;
}

interface Appearance {
  core: { shape: 'box' | 'circle'; size: number; radius: string; gap: number };
  levels: CoreLevel[];
}

/** Defaults; every field can be overridden from the JSON file named by `nvidiagpumonitor.appearanceFile`. */
const DEFAULT_APPEARANCE: Appearance = {
  core: { shape: 'circle', size: 28, radius: '50%', gap: 5 },
  levels: [
    { max: 0,   color: 'var(--vscode-terminal-ansiBrightBlack, #6b6b6b)',          text: '#dddddd', opacity: 0.6 },
    { max: 24,  color: 'var(--vscode-terminal-ansiGreen)',                          text: '#ffffff', opacity: 1 },
    { max: 49,  color: 'var(--vscode-terminal-ansiYellow)',                         text: '#000000', opacity: 1 },
    { max: 74,  color: 'var(--vscode-charts-orange, #d18616)',                      text: '#ffffff', opacity: 1 },
    { max: 99,  color: 'var(--vscode-terminal-ansiRed)',                            text: '#ffffff', opacity: 1 },
    { max: 100, color: 'color-mix(in srgb, var(--vscode-terminal-ansiRed) 55%, #000)', text: '#ffffff', opacity: 1 },
  ],
};

const COLOR_RE = /^[#a-zA-Z0-9(),.%\s-]{1,120}$/;

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Merge user JSON over the defaults. Anything missing or invalid falls back, so a typo never breaks the panel. */
function buildAppearance(raw: unknown): Appearance {
  const out: Appearance = JSON.parse(JSON.stringify(DEFAULT_APPEARANCE));
  if (!raw || typeof raw !== 'object') { return out; }
  const r = raw as { core?: Record<string, unknown>; levels?: unknown };

  if (r.core && typeof r.core === 'object') {
    const shape = r.core.shape === 'circle' ? 'circle' : r.core.shape === 'box' ? 'box' : out.core.shape;
    out.core.shape = shape;
    out.core.size = clampNum(r.core.size, 14, 48, out.core.size);
    out.core.gap = clampNum(r.core.gap, 0, 16, out.core.gap);
    const radius = clampNum(r.core.radius, 0, 24, 6);
    out.core.radius = shape === 'circle' ? '50%' : `${radius}px`;
  }

  if (Array.isArray(r.levels) && r.levels.length > 0) {
    const levels: CoreLevel[] = [];
    for (const l of r.levels as Record<string, unknown>[]) {
      if (!l || typeof l.max !== 'number' || typeof l.color !== 'string' || !COLOR_RE.test(l.color)) { levels.length = 0; break; }
      levels.push({
        max: clampNum(l.max, 0, 100, 100),
        color: l.color,
        text: typeof l.text === 'string' && COLOR_RE.test(l.text) ? l.text : '#ffffff',
        opacity: clampNum(l.opacity, 0, 1, 1),
      });
    }
    if (levels.length > 0) { out.levels = levels.sort((a, b) => a.max - b.max); }
  }
  return out;
}

function resolveAppearancePath(file: string): string {
  const home = process.env.HOME ?? '';
  let f = file.trim();
  if (f.startsWith('~/')) { f = path.join(home, f.slice(2)); }
  if (!path.isAbsolute(f)) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) { f = path.join(root, f); }
  }
  return f;
}

let prevCpuTimes: { idle: number; total: number }[] | undefined;

let topologyCache: { name: string; pkg: number }[] | undefined;

function readCpuTopology(): { name: string; pkg: number }[] {
  if (!topologyCache) { topologyCache = readCpuTopologyUncached(); }
  return topologyCache;
}

function readCpuTopologyUncached(): { name: string; pkg: number }[] {
  const topo: { name: string; pkg: number }[] = [];
  try {
    const blocks = fs.readFileSync('/proc/cpuinfo', 'utf8').split(/\n\s*\n/);
    for (const b of blocks) {
      const proc = b.match(/^processor\s*:\s*(\d+)/m);
      if (!proc) { continue; }
      const name = b.match(/^model name\s*:\s*(.+)$/m);
      const pkg = b.match(/^physical id\s*:\s*(\d+)/m);
      topo[parseInt(proc[1], 10)] = {
        name: name ? name[1].trim() : 'CPU',
        pkg: pkg ? parseInt(pkg[1], 10) : 0,
      };
    }
  } catch {
    // non-Linux or unreadable: fall back to a single package below
  }
  return topo;
}

const CLK_TCK = 100;
const PAGE_SIZE = 4096;
const TOP_CPU_PROCS = 15;

interface ProcSample { ticks: number; rss: number; cpu: number; name: string }

let prevProcTicks: Map<number, number> | undefined;
let prevProcAt = 0;

async function readProcSamples(): Promise<Map<number, ProcSample>> {
  const out = new Map<number, ProcSample>();
  let pids: string[] = [];
  try {
    pids = (await fs.promises.readdir('/proc')).filter(d => /^\d+$/.test(d));
  } catch {
    return out;
  }
  await Promise.all(pids.map(async d => {
    try {
      const raw = await fs.promises.readFile(`/proc/${d}/stat`, 'utf8');
      const open = raw.indexOf('(');
      const close = raw.lastIndexOf(')');
      const f = raw.slice(close + 2).split(' ');
      out.set(parseInt(d, 10), {
        name:  raw.slice(open + 1, close),
        ticks: parseInt(f[11], 10) + parseInt(f[12], 10),
        rss:   parseInt(f[21], 10) * PAGE_SIZE,
        cpu:   parseInt(f[36], 10),
      });
    } catch {
      // process exited while reading
    }
  }));
  return out;
}

let uidNames: Map<number, string> | undefined;

function userName(uid: number): string {
  if (!uidNames) {
    uidNames = new Map();
    try {
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const f = line.split(':');
        if (f.length > 2 && !uidNames.has(parseInt(f[2], 10))) { uidNames.set(parseInt(f[2], 10), f[0]); }
      }
    } catch {
      // fall back to numeric uid
    }
  }
  return uidNames.get(uid) ?? String(uid);
}

async function parseCpuProcesses(topo: { name: string; pkg: number }[]): Promise<CpuProcess[]> {
  const now = Date.now();
  const samples = await readProcSamples();
  const prev = prevProcTicks;
  const dt = (now - prevProcAt) / 1000;
  prevProcTicks = new Map([...samples].map(([pid, s]) => [pid, s.ticks]));
  prevProcAt = now;
  if (!prev || dt <= 0) { return []; }

  const rows: CpuProcess[] = [];
  for (const [pid, s] of samples) {
    const before = prev.get(pid);
    if (before === undefined) { continue; }
    const util = Math.round(((s.ticks - before) / CLK_TCK / dt) * 100);
    rows.push({
      socket: topo[s.cpu]?.pkg ?? 0,
      pid,
      user: '',
      name: s.name,
      model: null,
      cpuUtil: Math.max(0, util),
      memUsed: Math.round(s.rss / 1048576),
    });
  }
  const top = rows
    .sort((a, b) => b.cpuUtil - a.cpuUtil || b.memUsed - a.memUsed)
    .slice(0, TOP_CPU_PROCS);
  await Promise.all(top.map(async r => {
    r.model = describeProcess(r.pid).model;
    try {
      r.user = userName((await fs.promises.stat(`/proc/${r.pid}`)).uid);
    } catch {
      r.user = '?';
    }
  }));
  return top.sort((a, b) => a.socket - b.socket || b.memUsed - a.memUsed);
}

let tempFiles: Map<number, string> | undefined;

/** Package temperature (°C) per socket from the coretemp hwmon driver; empty if unavailable. */
function readPackageTemps(): Map<number, number> {
  if (!tempFiles) {
    tempFiles = new Map();
    try {
      for (const hw of fs.readdirSync('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${hw}`;
        try {
          if (fs.readFileSync(`${dir}/name`, 'utf8').trim() !== 'coretemp') { continue; }
          for (const f of fs.readdirSync(dir).filter(n => /^temp\d+_label$/.test(n))) {
            const m = fs.readFileSync(`${dir}/${f}`, 'utf8').match(/Package id (\d+)/);
            if (m) { tempFiles.set(parseInt(m[1], 10), `${dir}/${f.replace('_label', '_input')}`); }
          }
        } catch {
          // entry without a name or unreadable labels
        }
      }
    } catch {
      // no hwmon on this system
    }
  }
  const out = new Map<number, number>();
  for (const [pkg, file] of tempFiles) {
    try { out.set(pkg, Math.round(parseInt(fs.readFileSync(file, 'utf8'), 10) / 1000)); } catch { /* sensor gone */ }
  }
  return out;
}

/** Used/total RAM in MiB for a NUMA node, or null if the node isn't exposed. */
function readNodeMem(node: number): { used: number; total: number } | null {
  try {
    const txt = fs.readFileSync(`/sys/devices/system/node/node${node}/meminfo`, 'utf8');
    const kb = (key: string): number => {
      const m = txt.match(new RegExp(`${key}:\\s+(\\d+)\\s+kB`));
      return m ? parseInt(m[1], 10) : 0;
    };
    const total = kb('MemTotal');
    if (!total) { return null; }
    const free = kb('MemFree') + kb('FilePages') + kb('SReclaimable');
    return { used: Math.max(0, Math.round((total - free) / 1024)), total: Math.round(total / 1024) };
  } catch {
    return null;
  }
}

let lastCpuAt = 0;

/** Utilisation is a delta between two samples, so take a short priming sample when the last one is stale. */
async function parseCpuData(): Promise<CpuData> {
  if (!prevCpuTimes || Date.now() - lastCpuAt > 10000) {
    await sampleCpu();
    await new Promise(r => setTimeout(r, 500));
  }
  return sampleCpu();
}

async function sampleCpu(): Promise<CpuData> {
  lastCpuAt = Date.now();
  const cpus = os.cpus();
  const times = cpus.map(c => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  const prev = prevCpuTimes;
  prevCpuTimes = times;

  const topo = readCpuTopology();
  const packages = new Map<number, CpuPackage>();
  const sums = new Map<number, number>();

  times.forEach((t, i) => {
    const dTotal = prev ? t.total - prev[i].total : 0;
    const dIdle = prev ? t.idle - prev[i].idle : 0;
    const util = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
    const info = topo[i] ?? { name: cpus[i].model.trim(), pkg: 0 };
    let pkg = packages.get(info.pkg);
    if (!pkg) {
      pkg = { id: info.pkg, name: info.name, util: 0, memUsed: 0, memTotal: 0, temperature: null, cores: [] };
      packages.set(info.pkg, pkg);
    }
    pkg.cores.push({ id: i, util });
    sums.set(info.pkg, (sums.get(info.pkg) ?? 0) + util);
  });

  const result = [...packages.values()].sort((a, b) => a.id - b.id);
  for (const pkg of result) {
    pkg.util = Math.round((sums.get(pkg.id) ?? 0) / pkg.cores.length);
    pkg.temperature = readPackageTemps().get(pkg.id) ?? null;
    const node = readNodeMem(pkg.id);
    pkg.memTotal = node ? node.total : Math.round(os.totalmem() / 1048576);
    pkg.memUsed = node ? node.used : Math.round((os.totalmem() - os.freemem()) / 1048576);
  }
  return { packages: result, processes: await parseCpuProcesses(topo) };
}

let output: vscode.OutputChannel | undefined;

function log(message: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** Turn a raw nvidia-smi failure into something a person can act on. The raw text still goes to the log. */
function friendlySmiError(err: unknown, smiPath: string): string {
  const e = err as { message?: string; code?: number | string; killed?: boolean } | undefined;
  const raw = String(e?.message ?? err ?? '').trim();
  if (e?.killed || /timed out|ETIMEDOUT/i.test(raw)) {
    return 'nvidia-smi did not respond in time. The driver may be busy or hung.';
  }
  if (e?.code === 127 || e?.code === 'ENOENT' || /not found|not recognized|no such file/i.test(raw)) {
    return `nvidia-smi was not found ("${smiPath}"). Install the NVIDIA driver or set nvidiagpumonitor.nvidiaSmiPath.`;
  }
  if (/couldn't communicate|failed because|driver/i.test(raw)) {
    return 'nvidia-smi could not talk to the NVIDIA driver. Is the driver loaded?';
  }
  if (/no devices were found/i.test(raw)) {
    return 'No NVIDIA GPUs were found on this machine.';
  }
  const first = raw.split('\n').find(l => l.trim().length > 0) ?? 'unknown error';
  return first.length > 160 ? first.slice(0, 157) + '...' : first;
}

function run(cmd: string, timeout = 3000): Promise<string> {
  return new Promise(resolve => {
    exec(cmd, { encoding: 'utf8', timeout }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

function runStrict(cmd: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
      if (!err) { resolve(stdout); return; }
      const text = String(stderr || '').trim() || (typeof err.code === 'number' ? `nvidia-smi exited with code ${err.code}` : err.message);
      reject(Object.assign(new Error(text), { code: err.code, killed: err.killed }));
    });
  });
}

/** Per-process SM utilisation (%), keyed by "gpuIndex:pid". Empty if pmon is unavailable. */
async function getProcessUtil(nvidiaSmiPath: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const line of (await run(`${nvidiaSmiPath} pmon -c 1 -s u`)).split('\n')) {
    if (line.startsWith('#') || !line.trim()) { continue; }
    const c = line.trim().split(/\s+/);
    const gpu = parseInt(c[0], 10);
    const pid = parseInt(c[1], 10);
    if (isNaN(gpu) || isNaN(pid)) { continue; }
    map.set(`${gpu}:${pid}`, parseInt(c[3], 10) || 0);
  }
  return map;
}

function parseModelArg(args: string): { framework: string; model: string | null } | null {
  const lower = args.toLowerCase();
  let framework: string | null = null;
  if (/sglang/.test(lower)) { framework = 'sglang'; }
  else if (/vllm/.test(lower)) { framework = 'vllm'; }
  if (!framework) { return null; }

  const served = args.match(/--served-model-name(?:[=\s]+)(\S+)/);
  if (served) { return { framework, model: served[1] }; }
  const flag = args.match(/--(?:model-path|model)(?:[=\s]+)(\S+)/);
  if (flag) { return { framework, model: flag[1] }; }
  const positional = args.match(/\bvllm\s+serve\s+(\S+)/);
  if (positional && !positional[1].startsWith('-')) { return { framework, model: positional[1] }; }
  return { framework, model: null };
}

/** Resolve the (sglang/vllm) model of a PID, walking up parents since
 *  worker processes don't carry the launch arguments themselves. */
const describeCache = new Map<number, { at: number; value: { framework: string | null; model: string | null } }>();

function describeProcess(pid: number): { framework: string | null; model: string | null } {
  const hit = describeCache.get(pid);
  if (hit && Date.now() - hit.at < 30000) { return hit.value; }
  const value = describeProcessUncached(pid);
  describeCache.set(pid, { at: Date.now(), value });
  if (describeCache.size > 500) {
    for (const [k, v] of describeCache) {
      if (Date.now() - v.at > 30000) { describeCache.delete(k); }
    }
  }
  return value;
}

function readProcInfo(pid: number): { ppid: number; args: string } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    return { ppid, args };
  } catch {
    return null;
  }
}

function describeProcessUncached(pid: number): { framework: string | null; model: string | null } {
  let framework: string | null = null;
  let model: string | null = null;
  let cur = pid;
  for (let depth = 0; depth < 6 && cur > 1; depth++) {
    const info = readProcInfo(cur);
    if (!info) { break; }
    const parsed = parseModelArg(info.args);
    if (parsed) {
      framework = framework ?? parsed.framework;
      if (parsed.model) { model = parsed.model; break; }
    }
    cur = info.ppid;
  }
  return { framework, model };
}

async function parseGpuData(nvidiaSmiPath: string): Promise<GpuData> {
  const timestamp = Date.now();
  try {
    const [gpuRaw, procRaw, utilMap] = await Promise.all([
      runStrict(
        `${nvidiaSmiPath} --query-gpu=index,gpu_uuid,name,temperature.gpu,utilization.gpu,` +
        `utilization.memory,memory.used,memory.total,power.draw,power.limit ` +
        `--format=csv,noheader,nounits`
      ),
      runStrict(
        `${nvidiaSmiPath} --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory ` +
        `--format=csv,noheader,nounits`
      ),
      getProcessUtil(nvidiaSmiPath),
    ]);

    const gpus: GpuInfo[] = gpuRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          index:       parseInt(p[0], 10),
          uuid:        p[1],
          name:        p[2],
          temperature: parseInt(p[3], 10),
          gpuUtil:     parseInt(p[4], 10),
          memUtil:     parseInt(p[5], 10),
          memUsed:     parseInt(p[6], 10),
          memTotal:    parseInt(p[7], 10),
          powerDraw:   parseFloat(p[8]) || 0,
          powerLimit:  parseFloat(p[9]) || 0,
        };
      });

    const uuidToIndex = new Map(gpus.map(g => [g.uuid, g.index]));

    const processes: GpuProcess[] = procRaw
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const p = line.split(',').map(s => s.trim());
        const gpu = uuidToIndex.get(p[0]) ?? -1;
        const pid = parseInt(p[1], 10);
        const info = describeProcess(pid);
        return {
          gpu,
          pid,
          name:      p[2],
          framework: info.framework,
          model:     info.model,
          gpuUtil:   utilMap.get(`${gpu}:${pid}`) ?? 0,
          memUsed:   parseInt(p[3], 10) || 0,
        };
      })
      .sort((a, b) => a.gpu - b.gpu || b.memUsed - a.memUsed);

    return { gpus, processes, timestamp, error: null };
  } catch (err: unknown) {
    log(`GPU refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    return { gpus: [], processes: [], timestamp, error: friendlySmiError(err, nvidiaSmiPath) };
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
    :root {
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
      --dur:  0.4s;
    }
    html { overflow-y: auto; scrollbar-gutter: stable; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7)); }
    ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground, rgba(191, 191, 191, 0.4)); }
    :root { --core-size: 28px; --core-radius: 50%; --core-gap: 5px; }
    #root { container-type: inline-size; container-name: panel; }
    body {
      font-variant-numeric: tabular-nums;
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
    .note {
      color: var(--yellow);
      font-size: 0.78em;
      line-height: 1.4;
      padding: 0 2px 6px;
      word-break: break-word;
    }
    .error-banner {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      padding: 8px 10px;
      border-radius: 3px;
      font-size: 0.82em;
      margin-bottom: 8px;
      overflow-wrap: anywhere;
      line-height: 1.4;
    }
    .gpu-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 8px;
      transition: padding var(--dur) var(--ease);
    }
    .gpu-card-header {
      display: flex;
      align-items: center;
      margin-bottom: 9px;
      padding-bottom: 7px;
      border-bottom: 1px solid var(--border);
    }
    /* Side spacers take no room normally; when the name collapses they grow and center the badge. */
    .gpu-card-header::before, .gpu-card-header::after {
      content: '';
      flex: 0 0 0;
      transition: flex-grow var(--dur) var(--ease);
    }
    .gpu-name {
      color: var(--cyan);
      font-weight: bold;
      font-size: 1.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1 1 0;
      min-width: 0;
      max-width: 100%;
      margin-right: 8px;
      transition: flex-grow var(--dur) var(--ease), max-width var(--dur) var(--ease), opacity var(--dur) var(--ease), margin var(--dur) var(--ease);
    }
    .gpu-index-badge {
      background: var(--accent, #007acc);
      color: #fff;
      border-radius: 3px;
      padding: 1px 7px;
      font-size: 0.8em;
      flex-shrink: 0;
      text-align: center;
      transition: padding var(--dur) var(--ease);
    }
    .stat-row {
      display: grid;
      grid-template-columns: 52px 1fr 44px;
      align-items: center;
      gap: 6px;
      margin: 3px 0;
      max-height: 24px;
      transition: grid-template-columns var(--dur) var(--ease), gap var(--dur) var(--ease),
                  max-height var(--dur) var(--ease), margin var(--dur) var(--ease), opacity var(--dur) var(--ease);
    }
    .stat-label {
      color: var(--text-dim);
      font-size: 0.82em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat-bar {
      height: 8px;
      background: var(--border, #333);
      border-radius: 2px;
      overflow: hidden;
      min-width: 0;
      transition: opacity var(--dur) var(--ease);
    }
    .bar-fill {
      height: 100%;
      background: var(--green);
      border-radius: 2px;
      transition: width 0.3s ease, background-color 0.3s ease;
    }
    .bar-fill.warn { background: var(--yellow); }
    .bar-fill.hot  { background: var(--red); }
    .stat-value {
      text-align: right;
      font-size: 0.85em;
      color: var(--text-dim);
    }
    .footer-row {
      display: flex;
      justify-content: space-between;
      margin-top: 7px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 0.8em;
      gap: 4px;
      max-height: 30px;
      overflow: hidden;
      transition: max-height var(--dur) var(--ease), margin var(--dur) var(--ease),
                  padding var(--dur) var(--ease), opacity var(--dur) var(--ease);
    }
    .footer-row span { white-space: nowrap; }
    .footer-row .tot, .footer-row .temp { white-space: pre; }
    .tot, .temp {
      white-space: pre;
      display: inline-block;
      vertical-align: bottom;
      max-width: 90px;
      overflow: hidden;
      transition: max-width var(--dur) var(--ease), opacity var(--dur) var(--ease);
    }
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
    table { width: 100%; border-collapse: collapse; font-size: 0.83em; table-layout: fixed; }
    th.col-dev  { width: 30px; }
    th.col-user { width: 68px; }
    th.col-util { width: 46px; }
    th.col-mem  { width: 52px; }
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
    .proc-row { cursor: pointer; }
    .proc-row.copied td { background: var(--vscode-list-activeSelectionBackground); }
    tr:hover td { background: var(--vscode-list-hoverBackground); }
    .proc-pid  { color: var(--text-dim); }
    .proc-user { color: var(--text); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .proc-name {
      color: var(--cyan);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .proc-mem  { color: var(--yellow); text-align: right; white-space: nowrap; }
    .proc-util { text-align: right; white-space: nowrap; }
    .proc-model { color: var(--green); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .proc-section { margin-bottom: 8px; }
    .timestamp {
      color: var(--text-dim);
      font-size: 0.72em;
      text-align: right;
      padding-top: 2px;
      opacity: 0.7;
    }
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }
    .tab {
      flex: 1;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-dim);
      font-family: inherit;
      font-size: 0.9em;
      letter-spacing: 0.08em;
      padding: 5px 0;
      cursor: pointer;
    }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent, #007acc); }
    .cpu-card { cursor: pointer; user-select: none; }
    .cpu-card .stat-row.mem-row { margin-bottom: 2px; }
    .chev {
      text-align: center;
      color: var(--text-dim);
      font-size: 0.8em;
      line-height: 1;
      margin-top: 4px;
      transition: transform 0.45s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .cpu-card.open .chev { transform: rotate(180deg); }
    .cpu-expand {
      display: grid;
      grid-template-rows: 0fr;
      opacity: 0;
      transition: grid-template-rows 0.45s cubic-bezier(0.22, 1, 0.36, 1),
                  opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .cpu-card.open .cpu-expand { grid-template-rows: 1fr; opacity: 1; }
    .cpu-expand > div { overflow: hidden; min-height: 0; }
    .cpu-grid {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--core-gap);
      margin-top: 8px;
    }
    .core {
      width: var(--core-size);
      height: var(--core-size);
      border-radius: var(--core-radius);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.68em;
      font-weight: bold;
      color: #fff;
      cursor: default;
      transition: background-color 0.6s ease, opacity 0.6s ease;
    }
    .core-break { flex: 0 0 100%; border-top: 1px dashed var(--border); height: 0; margin: 1px 0; }
    .core { flex: 0 0 auto; transition: background-color 0.6s ease, opacity 0.6s ease, width var(--dur) var(--ease), height var(--dur) var(--ease), font-size var(--dur) var(--ease), border-radius var(--dur) var(--ease); }
    .cpu-grid { transition: gap var(--dur) var(--ease); }
    .single-dev .col-dev { display: none; }

    /* Responsive tiers, driven by the panel's own width. Hidden parts fade and collapse.
       Each cutoff sits just below the width at which the content stops fitting. */
    @container panel (max-width: 250px) {
      .col-user { display: none; }
    }
    @container panel (max-width: 210px) {
      .tot { max-width: 0; opacity: 0; }
      .row-bw { max-height: 0; opacity: 0; margin: 0; }
      .footer-row { justify-content: center; gap: 10px; }
    }
    @container panel (max-width: 190px) {
      .col-util { display: none; }
    }
    @container panel (max-width: 160px) {
      .gpu-card-header::before, .gpu-card-header::after { flex-grow: 1; }
      .gpu-name { flex-grow: 0; max-width: 0; opacity: 0; margin-right: 0; }
      .stat-row { grid-template-columns: 1fr 0fr 1fr; gap: 14px; }
      .gpu-index-badge { padding: 2px 18px; }
      .stat-bar { opacity: 0; }
      .stat-label { text-align: right; }
      .stat-value { text-align: left; }
      .row-pwr { max-height: 0; opacity: 0; margin: 0; }
      .temp { max-width: 0; opacity: 0; }
      .gpu-card { padding: 8px; }
      .core { width: calc(var(--core-size) * 0.8); height: calc(var(--core-size) * 0.8); font-size: 0.6em; }
      .cpu-grid { gap: calc(var(--core-gap) * 0.6); }
      th, td { text-align: center !important; }
    }
    @container panel (max-width: 120px) {
      .footer-row { max-height: 0; opacity: 0; margin-top: 0; padding-top: 0; border-top-color: transparent; }
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="root">
    <div class="tabs">
      <button class="tab active" data-tab="gpu">GPU</button>
      <button class="tab" data-tab="cpu">CPU</button>
    </div>
    <div id="panel-error" class="error-banner hidden"></div>
    <div id="tab-cpu" class="hidden">
      <div id="cpu-error" class="error-banner hidden"></div>
      <div id="appearance-note" class="note hidden"></div>
      <div id="cpu-cards"><div id="cpu-loading" class="timestamp" style="text-align:center">Waiting for CPU data...</div></div>
      <div id="cpu-procs-section" class="proc-section hidden">
        <div class="section-header">Top Processes</div>
        <table id="cpu-proc-table">
          <thead>
            <tr>
              <th class="col-dev">CPU</th>
              <th class="col-user">User</th>
              <th>Process</th>
              <th class="col-util" style="text-align:right">Util</th>
              <th class="col-mem" style="text-align:right">RAM</th>
            </tr>
          </thead>
          <tbody id="cpu-processes-body"></tbody>
        </table>
      </div>
    </div>
    <div id="tab-gpu">
    <div id="loading">Waiting for GPU data...</div>
    <div id="error-banner" class="error-banner hidden"></div>
    <div id="gpu-cards"></div>
    <div id="processes-section" class="proc-section hidden">
      <div class="section-header">Compute Processes</div>
      <table id="gpu-proc-table">
        <thead>
          <tr>
            <th class="col-dev">GPU</th>
            <th>Process</th>
            <th class="col-util" style="text-align:right">Util</th>
            <th class="col-mem" style="text-align:right">VRAM</th>
          </tr>
        </thead>
        <tbody id="processes-body"></tbody>
      </table>
    </div>
    <div id="timestamp" class="timestamp hidden"></div>
    </div>
  </div>

  <script>
    const vscodeApi = acquireVsCodeApi();

    // Last line of defence: a bug in the panel shows a message instead of a silently blank view.
    function showPanelError(msg) {
      const el = document.getElementById('panel-error');
      if (el) {
        el.textContent = '⚠ Panel error: ' + msg;
        el.classList.remove('hidden');
      }
      vscodeApi.postMessage({ type: 'webviewError', message: String(msg) });
    }
    function clearPanelError() {
      const el = document.getElementById('panel-error');
      if (el) { el.classList.add('hidden'); }
    }
    window.addEventListener('error', function(e) { showPanelError(e.message || 'unknown error'); });
    window.addEventListener('unhandledrejection', function(e) {
      showPanelError((e.reason && e.reason.message) || e.reason || 'unhandled rejection');
    });

    function renderBar(percent, warn, hot) {
      warn = warn === undefined ? 75 : warn;
      hot  = hot  === undefined ? 90 : hot;
      const pct = Math.max(0, Math.min(100, percent || 0));
      let cls = 'bar-fill';
      if (pct >= hot)  { cls += ' hot'; }
      else if (pct >= warn) { cls += ' warn'; }
      return '<div class="' + cls + '" style="width:' + pct + '%"></div>';
    }

    function formatMem(mib) {
      if (!mib || isNaN(mib)) { return '0M'; }
      return mib >= 1024 ? (mib / 1024).toFixed(1) + 'G' : mib + 'M';
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
        '    <span class="stat-bar">' + renderBar(g.gpuUtil) + '</span>',
        '    <span class="stat-value">' + g.gpuUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">VRAM</span>',
        '    <span class="stat-bar">' + renderBar(memPct) + '</span>',
        '    <span class="stat-value">' + Math.round(memPct) + '%</span>',
        '  </div>',
        '  <div class="stat-row row-bw">',
        '    <span class="stat-label">MEM BW</span>',
        '    <span class="stat-bar">' + renderBar(g.memUtil) + '</span>',
        '    <span class="stat-value">' + g.memUtil + '%</span>',
        '  </div>',
        '  <div class="stat-row row-pwr">',
        '    <span class="stat-label">POWER</span>',
        '    <span class="stat-bar">' + renderBar(pwrPct, 70, 90) + '</span>',
        '    <span class="stat-value">' + Math.round(g.powerDraw) + 'W</span>',
        '  </div>',
        '  <div class="footer-row">',
        '    <span>' + formatMem(g.memUsed) + '<span class="tot"> / ' + formatMem(g.memTotal) + '</span></span>',
        '    <span class="temp">TEMP <span class="' + tClass + '">' + g.temperature + '°C</span></span>',
        '  </div>',
        '</div>',
      ].join('\\n');
    }

    function renderProcRow(p) {
      const label = p.model || p.name;
      const cls = p.model ? 'proc-model' : 'proc-name';
      return [
        '<tr class="proc-row" data-pid="' + p.pid + '" title="Click to copy PID ' + p.pid + '">',
        '  <td class="proc-pid col-dev">' + p.gpu + '</td>',
        '  <td><div class="' + cls + '" title="' + escHtml(label) + '">' + escHtml(label) + '</div></td>',
        '  <td class="proc-util col-util">' + (p.gpuUtil > 0 ? p.gpuUtil + '%' : '-') + '</td>',
        '  <td class="proc-mem">' + formatMem(p.memUsed) + '</td>',
        '</tr>',
      ].join('');
    }

    function copyPidOnClick(e) {
      const row = e.target.closest('.proc-row');
      if (!row) { return; }
      vscodeApi.postMessage({ type: 'copyPid', pid: row.dataset.pid });
      row.classList.add('copied');
      setTimeout(function() { row.classList.remove('copied'); }, 400);
    }
    document.getElementById('processes-body').addEventListener('click', copyPidOnClick);
    document.getElementById('cpu-processes-body').addEventListener('click', copyPidOnClick);

    const openCpu = {};

    let coreLevels = [];
    let appearanceKey = '';

    function applyAppearance(a) {
      if (!a) { return; }
      const key = JSON.stringify(a);
      if (key === appearanceKey) { return; }
      appearanceKey = key;
      const st = document.documentElement.style;
      st.setProperty('--core-size', a.core.size + 'px');
      st.setProperty('--core-radius', a.core.radius);
      st.setProperty('--core-gap', a.core.gap + 'px');
      coreLevels = a.levels;
    }

    function levelFor(u) {
      for (let i = 0; i < coreLevels.length; i++) {
        if (u <= coreLevels[i].max) { return coreLevels[i]; }
      }
      return coreLevels[coreLevels.length - 1];
    }

    function coreStyle(u) {
      const lv = levelFor(u);
      return lv ? 'background-color:' + lv.color + ';color:' + lv.text + ';opacity:' + lv.opacity : '';
    }

    function paintCore(el, u) {
      const lv = levelFor(u);
      if (!lv) { return; }
      el.style.backgroundColor = lv.color;
      el.style.color = lv.text;
      el.style.opacity = lv.opacity;
    }

    function barFillClass(pct) {
      return 'bar-fill' + (pct >= 90 ? ' hot' : pct >= 75 ? ' warn' : '');
    }

    function renderCpuCard(pkg) {
      const memPct = pkg.memTotal > 0 ? Math.round((pkg.memUsed / pkg.memTotal) * 100) : 0;
      const cores = pkg.cores.map(function(c, i) {
        const gap = i > 0 && c.id !== pkg.cores[i - 1].id + 1 ? '<div class="core-break"></div>' : '';
        return gap + '<div class="core" style="' + coreStyle(c.util) + '" title="Core ' + c.id + ': ' + c.util + '%">' + c.id + '</div>';
      }).join('');
      return [
        '<div class="gpu-card cpu-card' + (openCpu[pkg.id] ? ' open' : '') + '" data-pkg="' + pkg.id + '">',
        '  <div class="gpu-card-header">',
        '    <span class="gpu-name" title="' + escHtml(pkg.name) + '">' + escHtml(pkg.name) + '</span>',
        '    <span class="gpu-index-badge">CPU ' + pkg.id + '</span>',
        '  </div>',
        '  <div class="stat-row">',
        '    <span class="stat-label">CPU</span>',
        '    <span class="stat-bar"><div class="' + barFillClass(pkg.util) + '" data-bar="cpu" style="width:' + pkg.util + '%"></div></span>',
        '    <span class="stat-value" data-val="cpu">' + pkg.util + '%</span>',
        '  </div>',
        '  <div class="stat-row mem-row">',
        '    <span class="stat-label">RAM</span>',
        '    <span class="stat-bar"><div class="' + barFillClass(memPct) + '" data-bar="mem" style="width:' + memPct + '%"></div></span>',
        '    <span class="stat-value" data-val="mem">' + memPct + '%</span>',
        '  </div>',
        '  <div class="footer-row"><span><span data-val="memused">' + formatMem(pkg.memUsed) + '</span><span class="tot"> / ' + formatMem(pkg.memTotal) + '</span></span>' + cpuTempHtml(pkg.temperature) + '</div>',
        '  <div class="cpu-expand"><div><div class="cpu-grid">' + cores + '</div></div></div>',
        '  <div class="chev">&#9662;</div>',
        '</div>',
      ].join('');
    }

    function cpuTempHtml(t) {
      if (t === null || t === undefined) { return '<span class="temp"></span>'; }
      return '<span class="temp">TEMP <span class="' + tempClass(t) + '" data-val="temp">' + t + '°C</span></span>';
    }

    function patchCpuCard(card, pkg) {
      const memPct = pkg.memTotal > 0 ? Math.round((pkg.memUsed / pkg.memTotal) * 100) : 0;
      const cpuBar = card.querySelector('[data-bar="cpu"]');
      const memBar = card.querySelector('[data-bar="mem"]');
      cpuBar.className = barFillClass(pkg.util); cpuBar.style.width = pkg.util + '%';
      memBar.className = barFillClass(memPct);   memBar.style.width = memPct + '%';
      card.querySelector('[data-val="cpu"]').textContent = pkg.util + '%';
      card.querySelector('[data-val="mem"]').textContent = memPct + '%';
      card.querySelector('[data-val="memused"]').textContent = formatMem(pkg.memUsed);
      const tEl = card.querySelector('[data-val="temp"]');
      if (tEl && pkg.temperature !== null) {
        tEl.textContent = pkg.temperature + '°C';
        tEl.className = tempClass(pkg.temperature);
      }
      card.querySelector('.tot').textContent = ' / ' + formatMem(pkg.memTotal);
      const els = card.querySelectorAll('.core');
      pkg.cores.forEach(function(c, i) {
        const el = els[i];
        if (!el) { return; }
        paintCore(el, c.util);
        el.title = 'Core ' + c.id + ': ' + c.util + '%';
      });
    }

    function updateCpu(pkgs) {
      const root = document.getElementById('cpu-cards');
      const cards = root.querySelectorAll('.cpu-card');
      if (cards.length !== pkgs.length) {
        root.innerHTML = pkgs.map(renderCpuCard).join('');
        return;
      }
      pkgs.forEach(function(p, i) { patchCpuCard(cards[i], p); });
    }

    function renderCpuProcRow(p) {
      const label = p.model || p.name;
      const cls = p.model ? 'proc-model' : 'proc-name';
      return [
        '<tr class="proc-row" data-pid="' + p.pid + '" title="Click to copy PID ' + p.pid + '">',
        '  <td class="proc-pid col-dev">' + p.socket + '</td>',
        '  <td class="col-user"><div class="proc-user" title="' + escHtml(p.user) + '">' + escHtml(p.user) + '</div></td>',
        '  <td><div class="' + cls + '" title="' + escHtml(label) + '">' + escHtml(label) + '</div></td>',
        '  <td class="proc-util col-util">' + (p.cpuUtil > 0 ? p.cpuUtil + '%' : '-') + '</td>',
        '  <td class="proc-mem">' + formatMem(p.memUsed) + '</td>',
        '</tr>',
      ].join('');
    }

    function updateCpuProcs(procs) {
      const sec = document.getElementById('cpu-procs-section');
      if (!procs || procs.length === 0) { sec.classList.add('hidden'); return; }
      document.getElementById('cpu-processes-body').innerHTML = procs.map(renderCpuProcRow).join('');
      sec.classList.remove('hidden');
    }

    document.getElementById('cpu-cards').addEventListener('click', function(e) {
      const card = e.target.closest('.cpu-card');
      if (!card) { return; }
      openCpu[card.dataset.pkg] = card.classList.toggle('open');
    });

    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(b) { b.classList.toggle('active', b === btn); });
        document.getElementById('tab-gpu').classList.toggle('hidden', btn.dataset.tab !== 'gpu');
        document.getElementById('tab-cpu').classList.toggle('hidden', btn.dataset.tab !== 'cpu');
        vscodeApi.postMessage({ type: 'tab', tab: btn.dataset.tab });
      });
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'cpuData') { return; }
      applyAppearance(msg.payload.appearance);
      document.getElementById('cpu-error').classList.add('hidden');
      const note = document.getElementById('appearance-note');
      if (msg.payload.appearanceError) {
        note.textContent = 'Appearance file problem, using defaults: ' + msg.payload.appearanceError;
        note.classList.remove('hidden');
      } else {
        note.classList.add('hidden');
      }
      const pkgs = msg.payload.packages;
      updateCpu(pkgs);
      document.getElementById('cpu-proc-table').classList.toggle('single-dev', pkgs.length === 1);
      updateCpuProcs(msg.payload.processes);
      clearPanelError();
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'error') { return; }
      if (msg.tab === 'cpu') {
        const el = document.getElementById('cpu-error');
        el.textContent = '⚠ ' + msg.message;
        el.classList.remove('hidden');
      } else {
        const el = document.getElementById('error-banner');
        el.textContent = '⚠ ' + msg.message;
        el.classList.remove('hidden');
        document.getElementById('gpu-cards').innerHTML = '';
        document.getElementById('processes-section').classList.add('hidden');
        document.getElementById('loading').classList.add('hidden');
      }
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type !== 'gpuData') { return; }
      const data = msg.payload;

      const loadingEl   = document.getElementById('loading');
      const errorEl     = document.getElementById('error-banner');
      const cardsEl     = document.getElementById('gpu-cards');
      const procSecEl   = document.getElementById('processes-section');
      const procBodyEl  = document.getElementById('processes-body');
      const tsEl        = document.getElementById('timestamp');

      if (loadingEl) { loadingEl.classList.add('hidden'); }

      if (data.error) {
        errorEl.textContent = '⚠ ' + data.error;
        errorEl.classList.remove('hidden');
        cardsEl.innerHTML = '';
        procSecEl.classList.add('hidden');
        return;
      }

      errorEl.classList.add('hidden');
      cardsEl.innerHTML = data.gpus.map(renderGpuCard).join('');
      document.getElementById('gpu-proc-table').classList.toggle('single-dev', data.gpus.length === 1);

      if (data.processes && data.processes.length > 0) {
        procBodyEl.innerHTML = data.processes.map(renderProcRow).join('');
        procSecEl.classList.remove('hidden');
      } else {
        procSecEl.classList.add('hidden');
      }

      tsEl.textContent = 'Updated ' + new Date(data.timestamp).toLocaleTimeString();
      tsEl.classList.remove('hidden');
      clearPanelError();
    });
  </script>
</body>
</html>`;
}

class GpuMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nvidiagpumonitor.panel';

  private _view?: vscode.WebviewView;
  private _intervalHandle?: ReturnType<typeof setInterval>;
  private _tab: 'gpu' | 'cpu' = 'gpu';
  private _busy = false;
  private _appearance: Appearance = DEFAULT_APPEARANCE;
  private _appearanceFile = '';
  private _lastAppearanceError = '';
  private _appearanceError: string | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    this._tab = 'gpu';

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent();

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg?.type === 'copyPid' && /^\d+$/.test(String(msg.pid))) {
        await vscode.env.clipboard.writeText(String(msg.pid));
        vscode.window.setStatusBarMessage(`Copied PID ${msg.pid}`, 2000);
      } else if (msg?.type === 'webviewError' && typeof msg.message === 'string') {
        log(`Panel error: ${msg.message.slice(0, 500)}`);
      } else if (msg?.type === 'tab' && (msg.tab === 'gpu' || msg.tab === 'cpu')) {
        this._tab = msg.tab;
        void this._sendData(this._smiPath());
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

    void this._sendData(smiPath);
    this._intervalHandle = setInterval(() => void this._sendData(smiPath), interval);
  }

  private _stopPolling(): void {
    if (this._intervalHandle !== undefined) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
    }
  }

  /** (Re)load the appearance JSON and watch it so edits apply without reloading the window. */
  public loadAppearance(): void {
    if (this._appearanceFile) { fs.unwatchFile(this._appearanceFile); }
    const configured = vscode.workspace.getConfiguration('nvidiagpumonitor').get<string>('appearanceFile', '').trim();
    this._appearanceFile = configured ? resolveAppearancePath(configured) : '';

    if (!this._appearanceFile) {
      this._appearance = DEFAULT_APPEARANCE;
      this._appearanceError = null;
      return;
    }
    try {
      this._appearance = buildAppearance(JSON.parse(fs.readFileSync(this._appearanceFile, 'utf8')));
      this._lastAppearanceError = '';
      this._appearanceError = null;
    } catch (err: unknown) {
      this._appearance = DEFAULT_APPEARANCE;
      this._appearanceError = err instanceof Error ? err.message : String(err);
      log(`Appearance file error: ${this._appearanceError}`);
      const msg = `GPU & CPU Monitor: could not read appearance file (${err instanceof Error ? err.message : String(err)}). Using defaults.`;
      if (msg !== this._lastAppearanceError) {
        this._lastAppearanceError = msg;
        void vscode.window.showWarningMessage(msg);
      }
    }
    const file = this._appearanceFile;
    fs.watchFile(file, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) { this.loadAppearance(); }
    });
  }

  private _smiPath(): string {
    return vscode.workspace.getConfiguration('nvidiagpumonitor').get<string>('nvidiaSmiPath', 'nvidia-smi');
  }

  private _post(message: unknown): void {
    try {
      void Promise.resolve(this._view?.webview.postMessage(message)).catch(err => log(`postMessage failed: ${String(err)}`));
    } catch (err: unknown) {
      log(`postMessage threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Only the visible tab is sampled, and a refresh is skipped while the previous one is running. */
  private async _sendData(smiPath: string): Promise<void> {
    if (!this._view?.visible || this._busy) { return; }
    this._busy = true;
    const tab = this._tab;
    try {
      const payload = tab === 'cpu'
        ? { ...(await parseCpuData()), appearance: this._appearance, appearanceError: this._appearanceError }
        : await parseGpuData(smiPath);
      if (this._view?.visible && tab === this._tab) {
        this._post({ type: tab === 'cpu' ? 'cpuData' : 'gpuData', payload });
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`${tab.toUpperCase()} refresh failed: ${detail}`);
      if (this._view?.visible && tab === this._tab) {
        this._post({ type: 'error', tab, message: `Could not read ${tab.toUpperCase()} data (${detail.slice(0, 120)}).` });
      }
    } finally {
      this._busy = false;
    }
  }

  public restartPolling(): void {
    this._startPolling();
  }

  public forceRefresh(): void {
    void this._sendData(this._smiPath());
  }

  public dispose(): void {
    this._stopPolling();
    if (this._appearanceFile) { fs.unwatchFile(this._appearanceFile); }
  }
}

let provider: GpuMonitorViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('GPU & CPU Monitor');
  context.subscriptions.push(output);
  provider = new GpuMonitorViewProvider(context.extensionUri);
  provider.loadAppearance();

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
        provider?.loadAppearance();
        provider?.restartPolling();
      }
    })
  );
}

export function deactivate(): void {
  provider?.dispose();
}
