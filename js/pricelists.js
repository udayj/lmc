import { matchingPricelists } from './pricelist-search.js';
const results = document.querySelector('#pricelist-results');
const status = document.querySelector('#pricelist-status');
const search = document.querySelector('#pricelist-search');
const brand = document.querySelector('#pricelist-brand');
const retry = document.querySelector('#pricelist-retry');
const feedback = document.querySelector('#download-feedback');
const brands = { kei: 'KEI', polycab: 'Polycab', havells: 'Havells', rallison: 'Rallison', akg: 'AKG' };
let items = [];

const more = document.querySelector('#pricelist-more');
const suggestions = document.querySelector('#pricelist-suggestions');
const searchField = document.querySelector('.pricelist-search-field');
const PAGE_SIZE = 6;
let visibleCount = PAGE_SIZE, selectedId = null, activeSuggestion = -1;
let suggestedItems = [];
function matches() {
  return selectedId ? items.filter(item => item.id === selectedId) : matchingPricelists(items, search.value, brand.value);
}
function closeSuggestions() {
  suggestions.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
  activeSuggestion = -1;
}
function suggestionTitle(item) {
  const title = item.title.toLowerCase().startsWith(item.brand.toLowerCase() + ' ') ? item.title.slice(item.brand.length).trim() : item.title;
  return brandName(item.brand) + ' · ' + title;
}
function selectSuggestion(item) {
  selectedId = item.id;
  search.value = suggestionTitle(item);
  visibleCount = PAGE_SIZE;
  closeSuggestions();
  render();
}
function updateSuggestions() {
  closeSuggestions();
  suggestions.replaceChildren();
  if (!search.value.trim() || selectedId) return;
  suggestedItems = matchingPricelists(items, search.value, brand.value).slice(0, PAGE_SIZE);
  if (!suggestedItems.length) return;
  for (const [index, item] of suggestedItems.entries()) {
    const option = document.createElement('div');
    option.id = 'pricelist-suggestion-' + index;
    option.className = 'pricelist-suggestion';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const label = document.createElement('span');
    label.className = 'suggestion-label';
    label.textContent = suggestionTitle(item);
    const detail = document.createElement('span');
    detail.className = 'suggestion-detail';
    detail.textContent = 'Latest';
    option.append(label);
    if (item.latest) option.append(detail);
    option.addEventListener('pointerdown', event => event.preventDefault());
    option.addEventListener('click', () => selectSuggestion(item));
    suggestions.append(option);
  }
  suggestions.hidden = false;
  search.setAttribute('aria-expanded', 'true');
}


function brandName(value) { return brands[value.toLowerCase()] || value.replace(/\b\w/g, c => c.toUpperCase()); }
function render() {
  const matched = matches();
  const shown = matched.slice(0, visibleCount);
  results.replaceChildren();
  status.textContent = matched.length ? 'Showing ' + shown.length + ' of ' + matched.length + ' pricelist' + (matched.length === 1 ? '' : 's') :
    items.length ? 'No matching pricelists. Try another search or choose All brands.' : 'No pricelists are available right now. Please call us for assistance.';
  more.hidden = shown.length >= matched.length;
  more.textContent = 'Show more';
  for (const item of shown) {
    const card = document.createElement('article');
    card.className = 'pricelist-card';
    const mark = document.createElement('span');
    mark.className = 'pricelist-brand';
    mark.textContent = brandName(item.brand);
    const heading = document.createElement('h2');
    heading.textContent = item.title;
    const format = document.createElement('p');
    format.className = 'pricelist-format';
    format.textContent = 'Latest';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-primary download-button';
    button.textContent = 'Download PDF';
    button.setAttribute('aria-label', `Download ${item.title} PDF`);
    button.addEventListener('click', () => download(item, button));
    card.append(mark, heading);
    if (item.latest) card.append(format);
    card.append(button);
    results.append(card);
  }
}

async function download(item, button) {
  button.disabled = true;
  button.textContent = 'Downloading…';
  feedback.textContent = '';
  try {
    const response = await fetch(`/api/pricelists/${item.id}/download`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/pdf')) throw new Error('Download failed');
    const blob = await response.blob();
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = item.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectURL), 60_000);
  } catch {
    feedback.textContent = `Could not download ${item.title}. Please try again or call +91 98300 53838.`;
  } finally {
    button.disabled = false;
    button.textContent = 'Download PDF';
  }
}

async function load() {
  retry.hidden = true;
  more.hidden = true;
  closeSuggestions();
  status.textContent = 'Loading pricelists…';
  results.setAttribute('aria-busy', 'true');
  search.disabled = brand.disabled = true;
  try {
    const response = await fetch('/api/pricelists', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Directory unavailable');
    const data = await response.json();
    if (!Array.isArray(data.pricelists)) throw new Error('Invalid directory');
    items = data.pricelists;
    visibleCount = PAGE_SIZE;
    selectedId = null;
    brand.replaceChildren(new Option('All brands', ''));
    for (const name of [...new Set(items.map(item => item.brand))].sort()) brand.add(new Option(brandName(name), name));
    render();
    search.disabled = brand.disabled = false;
  } catch {
    results.replaceChildren();
    status.textContent = 'Pricelists are temporarily unavailable. Please try again or call +91 98300 53838.';
    retry.hidden = false;
  } finally {
    results.setAttribute('aria-busy', 'false');
  }
}

search.addEventListener('input', () => {
  selectedId = null; visibleCount = PAGE_SIZE; render(); updateSuggestions();
});
search.addEventListener('focus', updateSuggestions);
search.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeSuggestions(); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (suggestions.hidden) updateSuggestions();
    if (suggestions.hidden) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    activeSuggestion = activeSuggestion < 0 ? (step === 1 ? 0 : suggestedItems.length - 1) :
      (activeSuggestion + step + suggestedItems.length) % suggestedItems.length;
    [...suggestions.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === activeSuggestion)));
    const option = suggestions.children[activeSuggestion];
    search.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!suggestions.hidden && activeSuggestion >= 0) selectSuggestion(suggestedItems[activeSuggestion]);
    else { closeSuggestions(); render(); }
  } else if (event.key === 'Tab') closeSuggestions();
});
search.addEventListener('blur', closeSuggestions);
document.addEventListener('pointerdown', event => {
  if (!searchField.contains(event.target)) closeSuggestions();
});
brand.addEventListener('change', () => {
  if (selectedId) search.value = '';
  selectedId = null; visibleCount = PAGE_SIZE; closeSuggestions(); render();
});
more.addEventListener('click', () => {
  const previousCount = visibleCount;
  visibleCount += PAGE_SIZE; render();
  results.children[previousCount]?.querySelector('button').focus({ preventScroll: true });
});
retry.addEventListener('click', load);
load();
