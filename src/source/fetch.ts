/**
 * Retrieve a source independently of the model that cited it. An agent that
 * hands the verifier its own copy of a page could hand over a truncated or
 * altered one; fetching the URL again closes that gap.
 */

import type { SourceDocument } from '../types.js';
import { htmlMainContent, htmlTitle, htmlToText } from './html.js';

export interface FetchSourceOptions {
  /** Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Default 20000. */
  timeoutMs?: number;
  /** Responses larger than this are rejected. Default 10 MB. */
  maxBytes?: number;
  /** Sent as User-Agent; some sites reject anonymous clients. */
  userAgent?: string;
}

/** Content that can be turned into text: HTML, or anything textual. */
export function sourceFromBody(body: string, contentType: string, url?: string): SourceDocument {
  const type = contentType.toLowerCase();
  if (type.includes('html') || (!type && /^\s*<(!doctype html|html)\b/i.test(body))) {
    // Match against the main content first; the full page (menus, footers,
    // sidebars) is only a fallback, so it cannot lend chrome to a fuzzy match.
    const full = htmlToText(body);
    const main = htmlMainContent(body);
    const mainText = main === undefined ? '' : htmlToText(main);
    return mainText
      ? { url, title: htmlTitle(body), text: mainText, extraTexts: [full] }
      : { url, title: htmlTitle(body), text: full };
  }
  return { url, text: body };
}

/** Fetch `url` and return it as a `SourceDocument` with extracted text. */
export async function fetchSource(url: string, options: FetchSourceOptions = {}): Promise<SourceDocument> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const res = await doFetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (/pdf/i.test(contentType)) {
      throw new Error('PDF sources are not supported; extract the text (e.g. pdftotext) and pass the .txt file');
    }
    if (!/text|html|xml|json|^$/i.test(contentType)) throw new Error(`unsupported content type ${contentType}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
    return sourceFromBody(decode(bytes, contentType), contentType, url);
  } catch (err) {
    const reason = controller.signal.aborted ? 'timed out' : err instanceof Error ? err.message : String(err);
    throw new Error(`could not fetch ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
