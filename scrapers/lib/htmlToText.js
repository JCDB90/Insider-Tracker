'use strict';
/**
 * Shared HTML→plain-text conversion for FCA National Storage Mechanism artefact
 * pages, used by uk.js and buybacks/uk-buybacks.js. FCA's /details API dropped
 * the embedded _source.document_content field at some point before 2026-07-14
 * (still returns metadata only — company, download_link, etc.) — the actual
 * MAR Art. 19 / Art. 5 form text is now only reachable via the artefact HTML at
 * data.fca.org.uk/artefacts/{download_link}, which this converts to the same
 * flat text shape the existing regex-based parsers already expect.
 */

function htmlToText(html) {
  if (!html) return '';
  // Remove style/script blocks
  let t = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  // Replace block elements with newlines
  t = t.replace(/<\/(?:tr|p|div|br|li|h[1-6])[^>]*>/gi, '\n');
  // Replace cell separators with spaces
  t = t.replace(/<\/(?:td|th)[^>]*>/gi, ' ');
  // Strip remaining tags
  t = t.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Collapse whitespace
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

module.exports = { htmlToText };
