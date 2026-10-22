import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class ObjectNotFoundError extends Error {
  constructor() { super('Object not found'); this.name = 'ObjectNotFoundError'; }
}
export class UploadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Metadata = { name: string; size: number; contentType: string };
type Ticket = Metadata & { owner: string; expires: number };
type LocalFile = { filename: string; size: number; contentType: string };
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class ObjectStorageService {
  constructor(private readonly root = path.resolve(process.env.UPLOAD_DIR || './data')) {}

  // Only used to recognize legacy database references during import cleanup.
  getPrivateObjectDir() { return process.env.LEGACY_PRIVATE_OBJECT_DIR || '/legacy/private'; }

  private objectFilename(id: string) {
    if (!UPLOAD_ID.test(id)) throw new ObjectNotFoundError();
    return path.join(this.root, 'uploads', id);
  }

  async getObjectEntityUploadURL(metadata: Metadata, owner: string) {
    const id = randomUUID();
    await mkdir(path.join(this.root, '.tickets'), { recursive: true });
    await writeFile(path.join(this.root, '.tickets', id), JSON.stringify({
      ...metadata, owner, expires: Date.now() + 15 * 60 * 1000,
    } satisfies Ticket), { flag: 'wx', mode: 0o600 });
    return `/api/storage/uploads/${id}`;
  }

  normalizeObjectEntityPath(url: string) {
    const id = url.split('/').at(-1) || '';
    if (!UPLOAD_ID.test(id)) throw new ObjectNotFoundError();
    return `/objects/uploads/${id}`;
  }

  async receiveUpload(id: string, owner: string, source: Readable, contentType: string, length?: string) {
    const filename = this.objectFilename(id);
    const ticketPath = path.join(this.root, '.tickets', id);
    const temporary = `${filename}.part`;
    let lock;
    try {
      lock = await open(`${ticketPath}.lock`, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new UploadError(409, 'Upload already in progress.');
      if (isMissing(error)) throw new ObjectNotFoundError();
      throw error;
    }
    try {
      let ticket: Ticket;
      try { ticket = JSON.parse(await readFile(ticketPath, 'utf8')); }
      catch (error) { if (isMissing(error)) throw new ObjectNotFoundError(); throw error; }
      if (ticket.owner !== owner) throw new UploadError(403, 'Upload belongs to another account.');
      if (ticket.expires < Date.now()) throw new UploadError(410, 'Upload expired. Request a new upload.');
      if (contentType.split(';')[0] !== ticket.contentType) throw new UploadError(400, 'Content type does not match.');
      if (length !== undefined && Number(length) !== ticket.size) throw new UploadError(400, 'File size does not match.');
      await mkdir(path.dirname(filename), { recursive: true });
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > ticket.size || bytes > 50 * 1024 * 1024) callback(new UploadError(413, 'File exceeds the declared size.'));
          else callback(null, chunk);
        },
      });
      await pipeline(source, limit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (bytes !== ticket.size) throw new UploadError(400, 'File size does not match.');
      await writeFile(`${filename}.json`, JSON.stringify({
        name: ticket.name, size: bytes, contentType: ticket.contentType,
      }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
      await rm(ticketPath);
    } finally {
      await lock.close();
      await rm(`${ticketPath}.lock`, { force: true });
      await rm(temporary, { force: true });
    }
  }

  private async file(filename: string): Promise<LocalFile> {
    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new ObjectNotFoundError();
      let metadata: Partial<Metadata> = {};
      try { metadata = JSON.parse(await readFile(`${filename}.json`, 'utf8')); }
      catch (error) { if (!isMissing(error)) throw error; }
      return { filename, size: info.size, contentType: metadata.contentType || 'application/octet-stream' };
    } catch (error) { if (isMissing(error)) throw new ObjectNotFoundError(); throw error; }
  }

  async getObjectEntityFile(objectPath: string) {
    const match = /^\/objects\/uploads\/([^/]+)$/.exec(objectPath);
    if (!match) throw new ObjectNotFoundError();
    return this.file(this.objectFilename(match[1]!));
  }

  async deleteUploadedObject(objectPath: string) {
    const match = /^\/objects\/uploads\/([^/]+)$/.exec(objectPath);
    if (!match) throw new ObjectNotFoundError();
    const filename = this.objectFilename(match[1]!);
    await rm(filename, { force: true });
    await rm(`${filename}.json`, { force: true });
  }

  async searchPublicObject(filePath: string): Promise<LocalFile | null> {
    const publicRoot = path.join(this.root, 'public');
    try {
      const filename = await realpath(path.resolve(publicRoot, filePath));
      const canonicalRoot = await realpath(publicRoot);
      if (!filename.startsWith(canonicalRoot + path.sep)) return null;
      return await this.file(filename);
    } catch (error) { if (isMissing(error) || error instanceof ObjectNotFoundError) return null; throw error; }
  }

  async downloadObject(file: LocalFile): Promise<Response> {
    return new Response(Readable.toWeb(createReadStream(file.filename)) as ReadableStream, {
      headers: {
        'Content-Type': file.contentType, 'Content-Length': String(file.size),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}
