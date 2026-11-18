export const DEFAULT_WATERFALL = ['wCBDC', 'tMMF', 'tGOVBOND', 'USDC', 'tCORPBOND'];
export const ASSETS = {
  wCBDC: { label: 'Settlement cash', key: 'cash', currency: 'HKD' },
  tMMF: { label: 'Tokenised MMF', key: 'mmf', currency: 'HKD' },
  tGOVBOND: { label: 'Government bonds', key: 'governmentBonds', currency: 'HKD' },
  USDC: { label: 'USD stablecoin', key: 'stablecoin', currency: 'USD' },
  tCORPBOND: { label: 'Corporate bonds', key: 'corporateBonds', currency: 'HKD' }
};
export function validWaterfall(order) {
  return Array.isArray(order) && order.length === DEFAULT_WATERFALL.length && new Set(order).size === order.length && order.every(asset => DEFAULT_WATERFALL.includes(asset));
}
// Allocate in payment cents; round conversion inputs up and available output down.
export function buildWaterfallPlan(amount, balances, order, haircut, usdHkdRate) {
  let remaining = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
  const legs = [];
  for (const asset of order) {
    const balance = Math.max(0, Math.round((balances[ASSETS[asset].key] || 0) * 100));
    const rate = asset === 'USDC' ? usdHkdRate : 1;
    const factor = asset === 'wCBDC' ? 1 : rate * (1 - haircut);
    const output = Math.min(remaining, Math.floor(balance * factor + 1e-8));
    if (output <= 0) continue;
    const input = Math.ceil(output / factor - 1e-8);
    legs.push({ asset, assetInput: input / 100, quoteOutput: output / 100, minOutput: output / 100 });
    remaining -= output;
  }
  return { legs, shortfall: remaining / 100, cashUsed: legs.find(leg => leg.asset === 'wCBDC')?.quoteOutput || 0, cashNeeded: legs.filter(leg => leg.asset !== 'wCBDC').reduce((sum, leg) => sum + Math.round(leg.quoteOutput * 100), 0) / 100 };
}
