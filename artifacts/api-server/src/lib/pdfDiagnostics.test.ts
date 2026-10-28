import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { summarizePdf } from './pdfDiagnostics';

function pdfWithIndirectCompressedContent(): Buffer {
  const content = deflateSync(Buffer.from('BT /F1 12 Tf (Synthetic payslip) Tj ET', 'latin1'));
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Page /Contents 3 0 R /Resources << /Font << /F1 4 0 R >> >> >> endobj',
    `2 0 obj ${content.length} endobj`,
    `3 0 obj << /Length 2 0 R /Filter /FlateDecode >> stream\n${content.toString('latin1')}\nendstream endobj`,
    '4 0 obj << /Type /Font /Subtype /Type0 >> endobj',
    '%%EOF',
  ].join('\n'), 'latin1');
}

test('summarizes compressed content with an indirect stream length', () => {
  const pdf = pdfWithIndirectCompressedContent();
  const summary = summarizePdf(pdf);
  assert.equal(summary.byteLength, pdf.length);
  assert.equal(summary.sha256.length, 64);
  assert.equal(summary.validPdfHeader, true);
  assert.equal(summary.pageObjectCount, 1);
  assert.ok(summary.fontResourceCount >= 1);
  assert.equal(summary.pageContentStreamCount, 1);
  assert.ok(summary.decodedContentBytes > 0);
  assert.equal(summary.textShowOperatorCount, 1);
  assert.equal(summary.parseError, null);
});

test('safely summarizes malformed input without exposing its contents', () => {
  const summary = summarizePdf(Buffer.from('not a PDF: private content must not be logged'));
  assert.equal(summary.validPdfHeader, false);
  assert.equal(summary.pageObjectCount, 0);
  assert.equal(summary.decodedContentBytes, 0);
  assert.equal(summary.parseError, 'invalid-pdf-header');
  assert.equal(summary.sha256.length, 64);
});

test('reports an unparseable content stream without throwing', () => {
  const summary = summarizePdf(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n2 0 obj << /Length 99 >> stream\nx\nendstream endobj'));
  assert.equal(summary.validPdfHeader, true);
  assert.equal(summary.pageObjectCount, 1);
  assert.equal(summary.pageContentStreamCount, 1);
  assert.equal(summary.parseError, 'stream-parse-failed');
});
