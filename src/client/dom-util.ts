// Minimal HTML-escape used by anywhere we splice user/catalog strings
// into innerHTML. Three distinct call sites had identical copies before
// this was lifted out (search.ts, constellation-typeahead.ts, main.ts).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
