const months = { jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june', jul: 'july', aug: 'august', sep: 'september', sept: 'september', oct: 'october', nov: 'november', dec: 'december' };
export function words(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean).map(word => months[word] || word);
}
export function matchingPricelists(items, query, brand = '') {
  const terms = words(query);
  return items.filter(item => {
    if (brand && item.brand !== brand) return false;
    const searchable = words([item.brand, item.title, ...item.keywords].join(' '));
    return terms.every(term => searchable.some(word => word.includes(term)));
  });
}
