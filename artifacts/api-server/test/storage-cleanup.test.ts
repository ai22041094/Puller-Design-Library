import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanupUnreferencedUploadObjects,
  getUploadReferenceCandidates,
} from '../src/lib/uploadCleanup';

const unusedUpload = '/objects/uploads/123e4567-e89b-42d3-a456-426614174000';
const referencedUpload = '/objects/uploads/123e4567-e89b-42d3-a456-426614174001';
const failingUpload = '/objects/uploads/123e4567-e89b-42d3-a456-426614174002';

test('only deletes unreferenced paths from the private uploads directory', async () => {
  const deleted: string[] = [];
  const result = await cleanupUnreferencedUploadObjects(
    [unusedUpload, referencedUpload],
    new Set([referencedUpload]),
    async (objectPath) => { deleted.push(objectPath); },
  );

  assert.deepEqual(deleted, [unusedUpload]);
  assert.deepEqual(result, {
    deletedCount: 1,
    skippedReferencedCount: 1,
    failedCount: 0,
  });
});

test('reports an object deletion failure without aborting later cleanup', async () => {
  const deleted: string[] = [];
  const result = await cleanupUnreferencedUploadObjects(
    [failingUpload, unusedUpload],
    new Set(),
    async (objectPath) => {
      if (objectPath === failingUpload) throw new Error('storage unavailable');
      deleted.push(objectPath);
    },
  );

  assert.deepEqual(deleted, [unusedUpload]);
  assert.deepEqual(result, {
    deletedCount: 1,
    skippedReferencedCount: 0,
    failedCount: 1,
  });
});

test('rejects paths outside the generated upload namespace before deleting anything', async () => {
  let deleteCalled = false;

  await assert.rejects(
    cleanupUnreferencedUploadObjects(
      ['/objects/existing/drawing.pdf'],
      new Set(),
      async () => { deleteCalled = true; },
    ),
    /Invalid uploaded object paths/,
  );
  assert.equal(deleteCalled, false);
});

test('matches stored object path variants when checking for existing references', () => {
  const candidates = getUploadReferenceCandidates(
    [unusedUpload],
    '/private-bucket/private',
  );

  assert.equal(candidates.get(unusedUpload), unusedUpload);
  assert.equal(candidates.get(`/api/storage${unusedUpload}`), unusedUpload);
  assert.equal(
    candidates.get('https://storage.googleapis.com/private-bucket/private/uploads/123e4567-e89b-42d3-a456-426614174000'),
    unusedUpload,
  );
});

test('accepts the maximum number of objects from a 500-row two-file import', async () => {
  const objectPaths = Array.from(
    { length: 1000 },
    (_, index) =>
      `/objects/uploads/123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`,
  );
  let deletedCount = 0;

  const result = await cleanupUnreferencedUploadObjects(
    objectPaths,
    new Set(),
    async () => { deletedCount += 1; },
  );

  assert.equal(deletedCount, 1000);
  assert.deepEqual(result, {
    deletedCount: 1000,
    skippedReferencedCount: 0,
    failedCount: 0,
  });
});
