/** 价格上限建议：按市场价增加少量缓冲，避免固定高下限放大低价国家成本。 */
export function calculateRecommendedMaxPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;

  const ratioBuffer = price * 1.2;
  const centBuffer = price + 0.01;
  return roundPrice(Math.max(ratioBuffer, centBuffer));
}

function roundPrice(value: number): number {
  return Math.round(value * 10000) / 10000;
}
