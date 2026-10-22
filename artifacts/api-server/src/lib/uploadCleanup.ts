const UPLOAD_OBJECT_PATH =
  /^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type UploadCleanupResult = {
  deletedCount: number;
  skippedReferencedCount: number;
  failedCount: number;
};

const DELETE_CONCURRENCY = 20;

export async function cleanupUnreferencedUploadObjects(
  objectPaths: string[],
  referencedPaths: ReadonlySet<string>,
  deleteObject: (objectPath: string) => Promise<void>,
): Promise<UploadCleanupResult> {
  if (
    objectPaths.length === 0 ||
    objectPaths.length > 1000 ||
    objectPaths.some((objectPath) => !UPLOAD_OBJECT_PATH.test(objectPath)) ||
    new Set(objectPaths).size !== objectPaths.length
  ) {
    throw new Error('Invalid uploaded object paths.');
  }

  const result: UploadCleanupResult = {
    deletedCount: 0,
    skippedReferencedCount: 0,
    failedCount: 0,
  };

  const unreferencedPaths: string[] = [];
  for (const objectPath of objectPaths) {
    if (referencedPaths.has(objectPath)) {
      result.skippedReferencedCount += 1;
    } else {
      unreferencedPaths.push(objectPath);
    }
  }

  for (let start = 0; start < unreferencedPaths.length; start += DELETE_CONCURRENCY) {
    const outcomes = await Promise.all(
      unreferencedPaths
        .slice(start, start + DELETE_CONCURRENCY)
        .map(async (objectPath) => {
          try {
            await deleteObject(objectPath);
            return true;
          } catch {
            return false;
          }
        }),
    );
    result.deletedCount += outcomes.filter(Boolean).length;
    result.failedCount += outcomes.filter((deleted) => !deleted).length;
  }

  return result;
}

export function getUploadReferenceCandidates(
  objectPaths: string[],
  privateObjectDir: string,
): Map<string, string> {
  const candidates = new Map<string, string>();
  const privateDir = privateObjectDir.replace(/\/+$/, '');

  for (const objectPath of objectPaths) {
    if (!UPLOAD_OBJECT_PATH.test(objectPath)) {
      throw new Error('Invalid uploaded object path.');
    }
    candidates.set(objectPath, objectPath);
    candidates.set(`/api/storage${objectPath}`, objectPath);
    candidates.set(
      `https://storage.googleapis.com${privateDir}/${objectPath.slice('/objects/'.length)}`,
      objectPath,
    );
  }

  return candidates;
}
