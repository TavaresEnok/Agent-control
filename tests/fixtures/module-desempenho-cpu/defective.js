// Arquivo sintético: apenas a função será extraída.
function computeHeavyReport() {
  const deadline = performance.now() + 220;
  let acc = 1;
  while (performance.now() < deadline) {
    for (let i = 0; i < 5000; i += 1) {
      acc = (acc * 1664525 + 1013904223) >>> 0;
    }
  }
  return {total: acc, items: 42};
}
