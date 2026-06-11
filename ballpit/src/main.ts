// Entry dispatcher. The default app is the loft-driven ball game (CPU worker
// physics). `?gpu=1` runs the GPU particle sim (WebGPU compute) — the path to
// 100k+ concurrent balls. Dynamic imports so each pulls in only what it needs.
if (new URLSearchParams(location.search).has('gpu')) {
  await import('./gpu-demo');
} else {
  await import('./loft-game');
}
export {};
