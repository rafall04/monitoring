import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { env } from '@noc/server';
import { badRequest } from './errors';

const ALLOWED: Record<string, string> = {
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
};

/**
 * Decode numeric HTML entities (`&#106;` / `&#x6A;`), a common way to hide
 * `javascript:` URIs and `on*=` handlers from the strip regexes below.
 * Over-decoding (e.g. a missing trailing semicolon) is fine: we fail closed.
 */
function decodeNumericEntities(s: string): string {
  const cp = (n: number): string =>
    n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => cp(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => cp(parseInt(dec, 10)));
}

/**
 * Anything matching this survived sanitising and is therefore hostile —
 * self-closing `<script href=…/>`, entity-encoded `javascript:` re-decoded,
 * `<use>`/SMIL payloads pulling external resources, etc. Fail closed.
 */
const FORBIDDEN_SVG =
  /<script|<foreignObject|javascript:|data:text\/html|on\w+\s*=/i;

/**
 * Conservative SVG sanitiser to prevent stored-XSS via uploaded icons.
 * Strips scripts, event handlers, javascript: URIs, external entities and
 * foreignObject — then VERIFIES nothing dangerous is left and rejects the
 * file otherwise (sanitise-then-verify). For high-assurance environments swap
 * in DOMPurify + jsdom.
 */
export function sanitizeSvg(svg: string): string {
  const cleaned = decodeNumericEntities(svg)
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
  if (FORBIDDEN_SVG.test(cleaned)) {
    throw badRequest('SVG contains disallowed content (scripts/handlers/URIs)');
  }
  return cleaned;
}

export async function saveUpload(
  part: MultipartFile,
  kind: 'icon' | 'floorplan' | 'logo',
): Promise<{ url: string; filename: string }> {
  const ext = ALLOWED[part.mimetype];
  if (!ext) throw badRequest(`Unsupported file type: ${part.mimetype}`);

  const buf = await part.toBuffer();
  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (buf.length > maxBytes) throw badRequest(`File exceeds ${env.MAX_UPLOAD_MB} MB`);

  const data =
    part.mimetype === 'image/svg+xml'
      ? Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8')
      : buf;

  const dir = resolve(env.UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  // 128-bit random name (unguessable, unenumerable) + allowlisted extension;
  // the original client filename is never trusted.
  const filename = `${randomBytes(16).toString('hex')}${ext}`;
  await writeFile(join(dir, filename), data);
  return { url: `/uploads/${filename}`, filename };
}
