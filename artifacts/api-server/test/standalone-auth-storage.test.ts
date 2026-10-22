import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, pool, usersTable, credentialsTable } from '@workspace/db';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { revokeUserSessions } from '../src/lib/auth';
import { Readable } from 'node:stream';
import { ObjectStorageService } from '../src/lib/objectStorage';

test('scrypt passwords are salted and reject wrong or malformed credentials', async () => {
  const password = `test-${randomUUID()}`;
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('incorrect', a), false);
  assert.equal(await verifyPassword(password), false);
  assert.equal(await verifyPassword(password, 'invalid'), false);
  await assert.rejects(hashPassword('short'), /12 and 128/);
});

test('local upload grants enforce ownership, size, replay and path boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'puller-grant-test-'));
  const service = new ObjectStorageService(root);
  const bytes = Buffer.from('fixture');
  try {
    const url = await service.getObjectEntityUploadURL({ name: 'model.stl', size: bytes.length, contentType: 'model/stl' }, 'owner');
    const id = url.split('/').at(-1)!;
    await assert.rejects(service.receiveUpload(id, 'other', Readable.from(bytes), 'model/stl'), /another account/);
    await assert.rejects(service.receiveUpload(id, 'owner', Readable.from(bytes), 'model/stl', '100'), /size does not match/);
    await service.receiveUpload(id, 'owner', Readable.from(bytes), 'model/stl', String(bytes.length));
    const response = await service.downloadObject(await service.getObjectEntityFile(service.normalizeObjectEntityPath(url)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await assert.rejects(service.receiveUpload(id, 'owner', Readable.from(bytes), 'model/stl'), /Object not found/);
    await assert.rejects(service.getObjectEntityFile('/objects/uploads/../../private'), /Object not found/);
    assert.equal(await service.searchPublicObject('../uploads/' + id), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('password sessions, private local uploads, password rotation and logout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'puller-storage-test-'));
  process.env.UPLOAD_DIR = root;
  const { default: app } = await import('../src/app');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const email = `standalone-${randomUUID()}@example.test`;
  const password = `initial-${randomUUID()}`;
  const nextPassword = `updated-${randomUUID()}`;
  const [user] = await db.insert(usersTable).values({ email, firstName: 'Test' }).returning();
  await db.insert(credentialsTable).values({ userId: user!.id, passwordHash: await hashPassword(password) });
  let cookie = '';
  const call = (url: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
    fetch(origin + url, {
      method, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await call('/api/dashboard')).status, 401);
    assert.equal((await call('/api/auth/login', 'POST', { email, password: 'wrong' })).status, 401);
    assert.equal((await call('/api/auth/login', 'POST', { email, password }, { Origin: 'https://evil.example' })).status, 403);
    const login = await call('/api/auth/login', 'POST', { email, password });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.email, email);
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/);
    assert.equal((await (await call('/api/auth/user')).json()).user.email, email);
    assert.equal((await call('/api/dashboard')).status, 200);
    const bytes = Buffer.from('%PDF-1.4\nfixture\n');
    const metadata = { name: 'fixture.pdf', size: bytes.length, contentType: 'application/pdf' };
    const grantResponse = await call('/api/storage/uploads/request-url', 'POST', metadata);
    assert.equal(grantResponse.status, 200);
    const grant = await grantResponse.json();
    const unauthorized = await fetch(origin + grant.uploadURL, {
      method: 'PUT', headers: { 'Content-Type': metadata.contentType }, body: bytes,
    });
    assert.equal(unauthorized.status, 401);
    const upload = await fetch(origin + grant.uploadURL, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': metadata.contentType }, body: bytes,
    });
    assert.equal(upload.status, 204);
    const fileUrl = '/api/storage' + grant.objectPath;
    const file = await call(fileUrl);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), metadata.contentType);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    assert.equal((await fetch(origin + fileUrl)).status, 401);
    assert.equal((await call('/api/storage/uploads/cleanup', 'POST', { objectPaths: [grant.objectPath] })).status, 200);
    assert.equal((await call(fileUrl)).status, 404);
    assert.equal((await call('/api/auth/change-password', 'POST', { currentPassword: 'wrong', newPassword: nextPassword })).status, 401);
    assert.equal((await call('/api/auth/change-password', 'POST', { currentPassword: password, newPassword: nextPassword })).status, 200);
    assert.equal((await (await call('/api/auth/user')).json()).user, null);
    assert.equal((await call('/api/auth/login', 'POST', { email, password })).status, 401);
    const secondLogin = await call('/api/auth/login', 'POST', { email, password: nextPassword });
    assert.equal(secondLogin.status, 200);
    cookie = secondLogin.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await call('/api/auth/logout', 'POST', {})).status, 200);
    assert.equal((await (await call('/api/auth/user')).json()).user, null);
  } finally {
    await revokeUserSessions(user!.id);
    await db.delete(usersTable).where(eq(usersTable.id, user!.id));
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

after(async () => { await pool.end(); });
