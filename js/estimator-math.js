// Independent website math: rate-first rounding matches the staff app.
export const moneyRound = n => Math.round(n * 100) / 100;
export function validNumber(value, max = 1e9) { return value !== '' && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= max; }
export function rowPrice(item, defaultDiscount) {
  const discount = item.discount === null ? defaultDiscount : item.discount;
  if (!validNumber(item.price) || !validNumber(item.quantity) || !validNumber(discount, 100)) return null;
  const rate = moneyRound(item.price * (1 - Number(discount) / 100) * (item.frls && item.supports_frls ? 1.03 : 1) * (item.pvc && item.supports_pvc ? 1.05 : 1));
  return { rate, amount: moneyRound(rate * Number(item.quantity)) };
}
export function estimateTotal(items, defaultDiscount) {
  if (!validNumber(defaultDiscount, 100)) return null;
  const rows = items.map(item => rowPrice(item, defaultDiscount));
  if (rows.some(row => !row)) return null;
  const subtotal = moneyRound(rows.reduce((sum, row) => sum + row.amount, 0));
  const gst = moneyRound(subtotal * .18);
  return { subtotal, gst, total: moneyRound(subtotal + gst) };
}
export function productKey(grid, cell) { return JSON.stringify([grid.brand, grid.display_name, grid.tag, cell.product]); }
