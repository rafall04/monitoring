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
 * Conservative SVG sanitiser to prevent stored-XSS via uploaded icons.
 * Strips scripts, event handlers, javascript: URIs, external entities and
 * foreignObject. For high-assurance environments swap in DOMPurify + jsdom.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

export async function saveUpload(
  part: MultipartFile,
  kind: 'icon' | 'floorplan',
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
  const filename = `${kind}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  await writeFile(join(dir, filename), data);
  return { url: `/uploads/${filename}`, filename };
}
