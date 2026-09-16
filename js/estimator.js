import { estimateTotal, rowPrice, validNumber, productKey } from './estimator-math.js';
import { track } from './analytics.js';
const $ = id => document.getElementById(id);
const money = n => n.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brandName = s => ({ kei: 'KEI', polycab: 'Polycab', havells: 'Havells', rallison: 'Rallison' }[s.toLowerCase()] || s);
let catalog = [], grid = null, items = [], defaultDiscount = '0', mode = 'open', gridController, gridVersion = 0;
let challenge, sentPhone = '', retryAt = 0, firstAdded = false, calculated = false, otpAvailable = false;
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function button(text, action, className = '') { const b = node('button', text, className); b.type = 'button'; b.addEventListener('click', action); return b; }
async function api(path, body, signal) {
  const options = { signal: signal || AbortSignal.timeout(25000), cache: 'no-store' };
  if (body !== undefined) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const res = await fetch('/api/estimator/' + path, options);
  const data = await res.json();
  if (!res.ok) { const error = new Error(data.error || 'Please try again.'); error.status = res.status; throw error; }
  return data;
}
function errorText(error) { return error.name === 'TimeoutError' ? 'This is taking longer than expected. Please try again.' : error.message || 'Please try again.'; }
function lockForLogin() {
  gridVersion++; gridController?.abort(); grid = null; items = []; renderCart(); $('grid').replaceChildren();
  $('tool').hidden = true; $('login-panel').hidden = false; $('sign-out').hidden = true; $('name-form').hidden = true;
}
async function start() {
  $('estimator-retry').hidden = true; $('estimator-status').textContent = 'Loading estimator…';
  try {
    const state = await api('session'); mode = state.mode; otpAvailable = state.otp_available;
    if (mode === 'otp' && !state.authenticated) {
      lockForLogin(); $('otp-channel').textContent = state.channel; $('send-code').disabled = !otpAvailable;
      $('estimator-status').textContent = otpAvailable ? '' : 'Mobile verification is temporarily unavailable. Please try again later.';
      $('estimator-retry').hidden = otpAvailable; return;
    }
    await openTool();
  } catch (error) { $('estimator-status').textContent = errorText(error); $('estimator-retry').hidden = false; }
}
async function openTool() {
  $('login-panel').hidden = true; $('tool').hidden = false; $('sign-out').hidden = mode !== 'otp';
  $('estimator-status').textContent = 'Loading available pricelists…';
  for (const id of ['brand', 'category', 'pricelist']) $(id).disabled = true;
  try {
    const data = await api('catalog'); catalog = data.brands;
    fillSelect('brand', catalog.map(b => [b.brand, brandName(b.brand)]));
    if (!catalog.length) { $('estimator-status').textContent = 'No processed pricelists are available right now.'; return; }
    $('estimator-status').textContent = ''; track('estimator_opened', { access_mode: mode }); chooseBrand();
  } catch (error) {
    if (error.status === 401) { mode = 'otp'; lockForLogin(); }
    $('estimator-status').textContent = errorText(error); $('estimator-retry').hidden = false;
  }
}
function fillSelect(id, values) { $(id).replaceChildren(...values.map(([v, label]) => new Option(label, v))); $(id).disabled = !values.length; }
function currentBrand() { return catalog.find(b => b.brand === $('brand').value); }
function currentCategory() { return currentBrand()?.categories.find(c => c.category === $('category').value); }
function currentList() { return currentCategory()?.pricelists[Number($('pricelist').value)]; }
function chooseBrand() { fillSelect('category', (currentBrand()?.categories || []).map(c => [c.category, c.category])); chooseCategory(); }
function chooseCategory() {
  const lists = currentCategory()?.pricelists || [];
  fillSelect('pricelist', lists.map((p, i) => [String(i), p.display_name]));
  loadGrid();
}
async function loadGrid() {
  const version = ++gridVersion; gridController?.abort(); const controller = gridController = new AbortController();
  grid = null; $('grid').replaceChildren(); $('grid-retry').hidden = true;
  const list = currentList(); if (!list) { $('grid-status').textContent = 'No pricelists in this category.'; return; }
  $('grid-status').textContent = 'Loading prices…'; $('grid').setAttribute('aria-busy', 'true');
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const query = new URLSearchParams({ brand: $('brand').value, category: $('category').value, tag: list.tag, display_name: list.display_name });
    const result = await api('grid?' + query, undefined, controller.signal);
    if (version !== gridVersion) return;
    grid = result.grids[0] || null; renderGrid();
  } catch (error) {
    if (version !== gridVersion) return;
    if (error.status === 401) { mode = 'otp'; lockForLogin(); start(); }
    $('grid-status').textContent = error.name === 'AbortError' ? 'Prices took too long to load. Please try again.' : errorText(error);
    $('grid-retry').hidden = false;
  } finally { clearTimeout(timeout); if (version === gridVersion) $('grid').setAttribute('aria-busy', 'false'); }
}
function renderGrid() {
  const scrollPositions = [...$('grid').querySelectorAll('.est-grid-scroll')].map(el => [el.scrollLeft, el.scrollTop]);
  const focusedKey = $('grid').contains(document.activeElement) ? document.activeElement.dataset.key : null;
  $('grid').replaceChildren();
  if (!grid) { $('grid-status').textContent = 'No prices available for this selection.'; return; }
  const cells = grid.cells;
  $('grid-status').textContent = cells.length ? `${cells.length} prices · Select a price to add it to your estimate.` : 'No matching products. Try another size or description.';
  const selected = new Set(items.map(i => i.key));
  for (const section of [...new Set(cells.map(c => c.section || ''))]) {
    const part = cells.filter(c => (c.section || '') === section);
    const rows = grid.rows.filter(r => part.some(c => c.row === r)), cols = grid.columns.filter(col => part.some(c => c.column === col));
    if (section) $('grid').append(node('h3', section));
    const wrap = node('div', undefined, 'est-grid-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${section || grid.category} prices`);
    const table = node('table', undefined, 'est-grid'), thead = node('thead'), head = node('tr');
    for (const title of ['Size', ...cols]) { const th = node('th', title); th.scope = 'col'; head.append(th); }
    thead.append(head); table.append(thead);
    const tbody = node('tbody'), positions = new Map();
    for (const cell of part) { const key = JSON.stringify([cell.row, cell.column]); positions.set(key, [...(positions.get(key) || []), cell]); }
    for (const row of rows) {
      const tr = node('tr'), th = node('th', row); th.scope = 'row'; tr.append(th);
      for (const col of cols) {
        const td = node('td'), matches = positions.get(JSON.stringify([row, col])) || [];
        for (const cell of matches) {
          const key = productKey(grid, cell), chosen = selected.has(key);
          const b = button(`${cell.price.toLocaleString('en-IN')} ${chosen ? '✓' : '+'}`, () => toggleCell(cell), 'est-price' + (chosen ? ' selected' : ''));
          b.dataset.key = key;
          b.setAttribute('aria-pressed', String(chosen)); b.setAttribute('aria-label', `${chosen ? 'Remove' : 'Add'} ${cell.label}, ${money(cell.price)}`); b.title = cell.label;
          b.disabled = !validNumber(cell.price); td.append(b);
        }
        if (!matches.length) td.textContent = '—'; tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody); wrap.append(table); $('grid').append(wrap);
  }
  [...$('grid').querySelectorAll('.est-grid-scroll')].forEach((el, i) => { if (scrollPositions[i]) { el.scrollLeft = scrollPositions[i][0]; el.scrollTop = scrollPositions[i][1]; } });
  if (focusedKey) [...$('grid').querySelectorAll('.est-price')].find(el => el.dataset.key === focusedKey)?.focus({ preventScroll: true });
}
function toggleCell(cell) {
  if (!grid) return;
  const key = productKey(grid, cell), existing = items.findIndex(i => i.key === key);
  if (existing >= 0) items.splice(existing, 1);
  else {
    items.push({ ...cell, key, brand: grid.brand, pricelist: grid.display_name, quantity: '1', discount: null, frls: false, pvc: false });
    if (!firstAdded) { firstAdded = true; track('first_item_added', { brand: grid.brand, category: grid.category, access_mode: mode }); }
    recordCalculation();
  }
  renderGrid(); renderCart();
}
function recordCalculation() {
  if (!calculated && items.length && estimateTotal(items, defaultDiscount)?.total > 0) { calculated = true; track('estimate_calculated', { access_mode: mode }); }
}
function preventWheelChange(input) {
  // Match the app cart: remove focus before the wheel can step a numeric value.
  // Leave the wheel event uncancelled so the page still scrolls normally.
  input.addEventListener('wheel', () => input.blur(), { passive: true });
}
function inputNumber(label, value, max, update) {
  const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = String(max); input.step = 'any'; input.required = true; input.value = value;
  input.setAttribute('aria-label', label); input.inputMode = 'decimal';
  preventWheelChange(input);
  input.addEventListener('input', () => { update(input.value); input.setAttribute('aria-invalid', String(!validNumber(input.value, max))); updateTotals(); updateRowAmounts(); recordCalculation(); });
  return input;
}
function renderCart() {
  $('estimate-items').replaceChildren(); $('empty-estimate').hidden = items.length > 0; $('clear-estimate').disabled = !items.length;
  $('item-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  items.forEach((item, index) => {
    const card = node('article', undefined, 'estimate-item'), heading = node('div', undefined, 'estimate-item-heading');
    const title = node('div'); title.append(node('h3', item.label), node('p', `${brandName(item.brand)} · ${item.pricelist}`, 'estimate-origin'));
    const remove = button('×', () => { items.splice(index, 1); renderCart(); renderGrid(); }, 'text-button estimate-remove'); remove.setAttribute('aria-label', `Remove ${item.label} from estimate`); remove.title = 'Remove this item';
    heading.append(title, remove); card.append(heading);
    const inputs = node('div', undefined, 'estimate-row-inputs'), qty = node('label', 'Quantity');
    qty.append(inputNumber(`Quantity for item ${index + 1}`, item.quantity, 1e9, v => item.quantity = v));
    const discount = node('label', 'Discount %');
    const reset = button('Reset', () => { item.discount = null; renderCart(); recordCalculation(); }, 'text-button discount-reset');
    reset.hidden = item.discount === null; reset.setAttribute('aria-label', `Use default discount for item ${index + 1}`);
    const dInput = inputNumber(`Discount for item ${index + 1}`, item.discount === null ? defaultDiscount : item.discount, 100, v => { item.discount = v; reset.hidden = false; });
    discount.append(dInput, reset);
    inputs.append(qty, discount); card.append(inputs);
    const loadings = node('div', undefined, 'estimate-loadings');
    for (const [field, supported, label] of [['frls', item.supports_frls, 'FRLS'], ['pvc', item.supports_pvc, 'PVC']]) {
      if (!supported) continue;
      const l = node('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item[field]; checkbox.setAttribute('aria-label', `${label} for item ${index + 1}`);
      checkbox.addEventListener('change', () => { item[field] = checkbox.checked; updateTotals(); updateRowAmounts(); recordCalculation(); }); l.append(checkbox, document.createTextNode(label)); loadings.append(l);
    }
    card.append(loadings);
    const prices = node('div', undefined, 'estimate-row-prices'); prices.dataset.row = String(index); card.append(prices); $('estimate-items').append(card);
  });
  updateRowAmounts(); updateTotals();
}
function updateRowAmounts() {
  document.querySelectorAll('[data-row]').forEach(element => {
    const item = items[Number(element.dataset.row)], price = rowPrice(item, defaultDiscount);
    element.replaceChildren(node('span', `List ${money(item.price)}`), node('span', price ? `Net ${money(price.rate)}` : 'Check inputs'), node('strong', price ? money(price.amount) : '—'));
  });
}
function updateTotals() {
  const totals = estimateTotal(items, defaultDiscount); $('estimate-input-error').hidden = !!totals;
  $('print-estimate').disabled = !items.length || !totals;
  $('mobile-estimate-summary').textContent = `${items.length} item${items.length === 1 ? '' : 's'} · ${totals ? money(totals.total) : 'Check inputs'} →`;
  $('mobile-estimate-link').hidden = !items.length;
  for (const name of ['subtotal', 'gst', 'total']) $(name).textContent = totals ? money(totals[name]) : '—';
}
$('brand').addEventListener('change', chooseBrand); $('category').addEventListener('change', chooseCategory);
$('pricelist').addEventListener('change', () => { loadGrid(); });
preventWheelChange($('default-discount'));
$('default-discount').addEventListener('input', () => {
  defaultDiscount = $('default-discount').value; $('default-discount').setAttribute('aria-invalid', String(!validNumber(defaultDiscount, 100)));
  renderCart(); recordCalculation();
});
$('clear-estimate').addEventListener('click', () => { items = []; renderCart(); renderGrid(); });
$('grid-retry').addEventListener('click', loadGrid); $('estimator-retry').addEventListener('click', start);
$('phone-form').addEventListener('submit', async event => {
  event.preventDefault(); if (Date.now() < retryAt) return;
  $('send-code').disabled = true; $('login-error').textContent = '';
  try {
    const result = await api('auth/send', { phone: $('phone').value }); challenge = result.challenge; sentPhone = $('phone').value;
    retryAt = Date.now() + result.retry_after * 1000; $('code-form').hidden = false; $('phone-form').hidden = true;
    $('code-destination').textContent = `Enter the code sent to ${sentPhone}.`; $('code').value = ''; $('code').focus();
  } catch (error) { $('login-error').textContent = errorText(error); }
  finally { $('send-code').disabled = Date.now() < retryAt; }
});
$('change-phone').addEventListener('click', () => { challenge = null; $('code-form').hidden = true; $('phone-form').hidden = false; $('phone').focus(); });
$('resend-code').addEventListener('click', () => { $('phone').value = sentPhone; $('phone-form').requestSubmit(); });
setInterval(() => { const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)); $('resend-code').disabled = seconds > 0; $('resend-code').textContent = seconds ? `Resend in ${seconds}s` : 'Resend code'; if (!seconds && retryAt && otpAvailable) $('send-code').disabled = false; }, 1000);
$('code-form').addEventListener('submit', async event => {
  event.preventDefault(); $('verify-code').disabled = true; $('login-error').textContent = '';
  try { const result = await api('auth/verify', { challenge, code: $('code').value.trim() }); challenge = null; $('code').value = ''; track('otp_verified'); await openTool(); $('name-form').hidden = !result.needs_name; }
  catch (error) { $('login-error').textContent = errorText(error); }
  finally { $('verify-code').disabled = false; }
});
$('name-form').addEventListener('submit', async event => {
  event.preventDefault(); $('save-name').disabled = true; $('name-error').textContent = '';
  try { await api('auth/name', { name: $('contact-name').value }); $('name-form').hidden = true; $('contact-name').value = ''; }
  catch (error) { $('name-error').textContent = errorText(error); }
  finally { $('save-name').disabled = false; }
});
$('skip-name').addEventListener('click', () => { $('name-form').hidden = true; $('contact-name').value = ''; });
$('sign-out').addEventListener('click', async () => { try { await api('auth/logout', {}); lockForLogin(); $('code-form').hidden = true; $('phone-form').hidden = false; $('phone').value = ''; $('estimator-status').textContent = ''; } catch (error) { $('estimator-status').textContent = errorText(error); } });
renderCart(); start();

function preparePrintEstimate() {
  const sheet = $('print-estimate-sheet'); sheet.replaceChildren();
  const totals = estimateTotal(items, defaultDiscount);
  if (!items.length || !totals) return;
  sheet.append(node('h1', 'Price Estimation Tool'), node('p', new Date().toLocaleDateString('en-IN') + ' · Sponsored by Lloyds Mercantile Corporation'));
  const table = node('table'), head = node('thead'), header = node('tr');
  for (const title of ['Product / pricelist', 'Qty', 'List rate', 'Discount', 'Net rate', 'Amount']) header.append(node('th', title));
  head.append(header); table.append(head); const body = node('tbody');
  for (const item of items) {
    const price = rowPrice(item, defaultDiscount), row = node('tr'), product = node('td');
    product.append(node('strong', item.label), node('small', brandName(item.brand) + ' · ' + item.pricelist));
    const loadings = [item.supports_frls && item.frls ? 'FRLS' : '', item.supports_pvc && item.pvc ? 'PVC' : ''].filter(Boolean);
    if (loadings.length) product.append(node('small', loadings.join(' · ')));
    row.append(product);
    for (const value of [item.quantity, money(item.price), (item.discount === null ? defaultDiscount : item.discount) + '%', money(price.rate), money(price.amount)]) row.append(node('td', value));
    body.append(row);
  }
  table.append(body); sheet.append(table);
  const summary = node('dl', undefined, 'print-totals');
  for (const [label, key] of [['Subtotal', 'subtotal'], ['GST (18%)', 'gst'], ['Estimated total', 'total']]) {
    const line = node('div'); line.append(node('dt', label), node('dd', money(totals[key]))); summary.append(line);
  }
  sheet.append(summary, node('p', 'This estimate was prepared by the user and is not endorsed by Lloyds Mercantile Corporation. This tool is intended to save time. Please speak to Lloyds Mercantile Corporation to confirm prices and availability.'), node('p', '+91 98309 06922 · +91 98300 53838 · SALES@LMCCABLES.COM · lmccables.com'));
}
window.addEventListener('beforeprint', preparePrintEstimate);
$('print-estimate').addEventListener('click', () => { if (!items.length || !estimateTotal(items, defaultDiscount)) return; preparePrintEstimate(); window.print(); });

// Hide the mobile shortcut while its destination is already on screen.
new IntersectionObserver(([entry]) => {
  $('mobile-estimate-link').classList.toggle('at-estimate', entry.isIntersecting);
}, { threshold: 0 }).observe($('your-estimate'));
