import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export interface PdfDiagnosticSummary {
  byteLength: number;
  sha256: string;
  validPdfHeader: boolean;
  pageObjectCount: number;
  fontResourceCount: number;
  pageContentStreamCount: number;
  decodedContentBytes: number;
  textShowOperatorCount: number;
  parseError: 'invalid-pdf-header' | 'object-parse-failed' | 'stream-parse-failed' | null;
}

interface PdfObject {
  id: string;
  body: Buffer;
}

function parseObjects(pdf: Buffer): PdfObject[] {
  const text = pdf.toString('latin1');
  return [...text.matchAll(/(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g)]
    .map(([, id, body]) => ({ id, body: Buffer.from(body, 'latin1') }));
}

function streamBytes(object: Buffer, objects: Map<string, Buffer>): Buffer {
  const text = object.toString('latin1');
  const streamAt = text.search(/\bstream\r?\n/);
  if (streamAt < 0) throw new Error('missing stream');
  const marker = text.slice(streamAt).match(/^stream\r?\n/);
  if (!marker) throw new Error('invalid stream marker');

  const dataStart = streamAt + marker[0].length;
  const dictionary = text.slice(0, streamAt);
  const directLength = dictionary.match(/\/Length\s+(\d+)\b(?!\s+0\s+R)/)?.[1];
  const indirectLengthId = dictionary.match(/\/Length\s+(\d+)\s+0\s+R\b/)?.[1];
  const indirectLength = indirectLengthId
    ? objects.get(indirectLengthId)?.toString('latin1').trim().match(/^(\d+)\b/)?.[1]
    : undefined;
  const length = directLength ?? indirectLength;
  const requestedLength = length ? Number(length) : undefined;
  if (requestedLength !== undefined && dataStart + requestedLength > object.length) {
    throw new Error('stream length exceeds object');
  }
  const raw = requestedLength !== undefined
    ? object.subarray(dataStart, dataStart + requestedLength)
    : (() => {
      const end = text.indexOf('\nendstream', dataStart);
      if (end < 0) throw new Error('missing endstream');
      return object.subarray(dataStart, end);
    })();

  return /\/FlateDecode\b/.test(dictionary) ? inflateSync(raw) : raw;
}

function contentReferences(page: Buffer): string[] {
  const contents = page.toString('latin1').match(/\/Contents\s+(\[[\s\S]*?\]|\d+\s+0\s+R)/)?.[1];
  return contents ? [...contents.matchAll(/(\d+)\s+0\s+R/g)].map(([, id]) => id) : [];
}

/**
 * Produces a privacy-preserving structural PDF summary for diagnostics.
 * It never throws and never includes document content in its result.
 */
export function summarizePdf(pdf: Buffer): PdfDiagnosticSummary {
  const summary: PdfDiagnosticSummary = {
    byteLength: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    validPdfHeader: pdf.subarray(0, 5).toString('ascii') === '%PDF-',
    pageObjectCount: 0,
    fontResourceCount: 0,
    pageContentStreamCount: 0,
    decodedContentBytes: 0,
    textShowOperatorCount: 0,
    parseError: null,
  };
  if (!summary.validPdfHeader) {
    summary.parseError = 'invalid-pdf-header';
    return summary;
  }

  const objects = parseObjects(pdf);
  if (objects.length === 0) {
    summary.parseError = 'object-parse-failed';
    return summary;
  }
  const objectMap = new Map(objects.map(object => [object.id, object.body]));
  const text = pdf.toString('latin1');
  summary.fontResourceCount = (text.match(/\/(?:FontFile\d?|Subtype\s*\/Type0)\b/g) ?? []).length;

  const pages = objects
    .map(object => object.body)
    .filter(object => /\/Type\s*\/Page\b/.test(object.toString('latin1')));
  summary.pageObjectCount = pages.length;

  try {
    const contentIds = pages.flatMap(contentReferences);
    summary.pageContentStreamCount = contentIds.length;
    for (const id of contentIds) {
      const object = objectMap.get(id);
      if (!object) throw new Error('missing content object');
      const content = streamBytes(object, objectMap);
      summary.decodedContentBytes += content.length;
      summary.textShowOperatorCount += (content.toString('latin1').match(/\b(?:Tj|TJ)\b/g) ?? []).length;
    }
  } catch {
    summary.parseError = 'stream-parse-failed';
  }
  return summary;
}
