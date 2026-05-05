import { describe, it, expect } from 'vitest';
import { escapeHtml } from './dom-util';

describe('dom-util / escapeHtml', () => {
  it('escapes the four HTML-significant characters', () => {
    expect(escapeHtml('<a href="x" class=\'y\'>&z')).toBe(
      '&lt;a href=&quot;x&quot; class=\'y\'&gt;&amp;z',
    );
  });

  it('returns the input unchanged when there is nothing to escape', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('')).toBe('');
  });

  it('escapes & first so subsequent escapes are not doubled', () => {
    // The order matters: replacing & last would turn the &lt; introduced
    // by < into &amp;lt;. Sanity-check the actual output.
    expect(escapeHtml('a < b & b > c')).toBe('a &lt; b &amp; b &gt; c');
  });

  it('does not escape single quotes', () => {
    // Not strictly necessary inside HTML attribute values when the
    // attribute is double-quoted, which is the project convention. Pinning
    // current behaviour so we notice if it ever changes.
    expect(escapeHtml("o'reilly")).toBe("o'reilly");
  });

  it('handles a string of only escapable chars', () => {
    expect(escapeHtml('<<>>&&""')).toBe('&lt;&lt;&gt;&gt;&amp;&amp;&quot;&quot;');
  });

  it('passes Unicode through untouched', () => {
    expect(escapeHtml('αβγ — étoile 🜁')).toBe('αβγ — étoile 🜁');
  });
});
