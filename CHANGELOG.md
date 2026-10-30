# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-30

A big step up: the extension is now **GPU & CPU Monitor**.

### Added
- **CPU tab** with one card per physical processor: CPU and RAM bars (RAM read per NUMA node) and the
  package temperature.
- Click a CPU card to expand a smooth, animated grid of **per-core buttons** showing each core's real
  number, colored by load level (gray at 0%, deep red at exactly 100%).
- **Top processes table** on the CPU tab with the owning user, model name for SGLang and vLLM, utilization
  and RAM. Click a row to copy its PID.
- **Appearance file**: `nvidiagpumonitor.appearanceFile` points to a JSON file that controls the core
  shape (circle or box), size, corner radius, gap and the color of every load level. It reloads live.
  See `appearance.example.json`.
- **Model names** for SGLang and vLLM processes on the GPU tab.
- Per-process GPU utilization.
- A **GPU / CPU tab switcher**.
- A **responsive layout** that simplifies in stages as the sidebar narrows, with eased transitions.
- An **Output channel** ("GPU & CPU Monitor") that logs every failure.

### Changed
- Renamed to **GPU & CPU Monitor** (the extension ID and setting keys are unchanged).
- GPU processes are grouped by GPU, then ordered by VRAM from highest to lowest.
- Memory is shown as `G` and `M`, and the index column is hidden on single-GPU or single-CPU machines.
- Progress bars are now fluid and scale with the panel width.
- A thinner scrollbar whose space is reserved, so the layout no longer shifts when it appears.
- Polling is fully asynchronous, samples only the visible tab and skips a refresh while the previous one
  is still running.
- The TDP value was removed from the GPU card.
- README rewritten with a banner and screenshots.

### Fixed
- `nvidia-smi` failures now show a clear message instead of the raw command output.
- A failure while reading CPU data shows a banner instead of failing silently.
- A script error in the panel shows a message instead of leaving the view blank.
- A broken appearance file shows a persistent notice and falls back to the defaults.

## [0.1.2] and earlier

Initial releases: real-time NVIDIA GPU stats in a sidebar panel with utilization, VRAM, memory bandwidth,
power and temperature bars, a compute process table, light and dark theme support and a configurable
refresh interval.

[0.2.0]: https://github.com/Minato3000/gpu-monitoring-service/releases/tag/v0.2.0
