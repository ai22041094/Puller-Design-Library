import { Readable } from 'stream';
import path from 'path';
import {
  CleanupUploadedObjectsBody,
  CleanupUploadedObjectsResponse,
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';
import { inArray, or } from 'drizzle-orm';

import { ObjectPermission } from '../lib/objectAcl';
import { db, pullerVersionsTable, pullersTable } from '@workspace/db';
import {
  cleanupUnreferencedUploadObjects,
  getUploadReferenceCandidates,
} from '../lib/uploadCleanup';
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

function hasAuthenticatedSession(
  req: Request,
): req is Request & { isAuthenticated: () => boolean } {
  if (
    !('isAuthenticated' in req) ||
    typeof req.isAuthenticated !== 'function'
  ) {
    return false;
  }

  return req.isAuthenticated();
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires auth middleware so public callers cannot mint write-capable URLs.
 */
router.post(
  '/storage/uploads/request-url',
  async (req: Request, res: Response) => {
    if (!hasAuthenticatedSession(req)) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;
      const allowedTypes: Record<string, string[]> = {
        '.png': ['image/png'],
        '.jpg': ['image/jpeg'],
        '.jpeg': ['image/jpeg'],
        '.webp': ['image/webp'],
        '.pdf': ['application/pdf'],
        '.glb': ['model/gltf-binary', 'application/octet-stream'],
        '.stl': ['model/stl', 'application/octet-stream'],
      };
      const extension = path.extname(name).toLowerCase();
      if (!allowedTypes[extension]?.includes(contentType)) {
        res.status(400).json({ error: 'Unsupported file type' });
        return;
      }
      if (size > 50 * 1024 * 1024) {
        res.status(400).json({ error: 'Files must be 50 MB or smaller' });
        return;
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

router.post(
  '/storage/uploads/cleanup',
  async (req: Request, res: Response): Promise<void> => {
    if (!hasAuthenticatedSession(req)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = CleanupUploadedObjectsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid uploaded object paths.' });
      return;
    }

    try {
      const { objectPaths } = parsed.data;
      const candidates = getUploadReferenceCandidates(
        objectPaths,
        objectStorageService.getPrivateObjectDir(),
      );
      const referenceValues = [...candidates.keys()];
      const pullerReferences = await db
        .select({
          imageUrl: pullersTable.imageUrl,
          drawing2dUrl: pullersTable.drawing2dUrl,
          drawing3dUrl: pullersTable.drawing3dUrl,
        })
        .from(pullersTable)
        .where(
          or(
            inArray(pullersTable.imageUrl, referenceValues),
            inArray(pullersTable.drawing2dUrl, referenceValues),
            inArray(pullersTable.drawing3dUrl, referenceValues),
          ),
        );
      const versionReferences = await db
        .select({
          designImageUrl: pullerVersionsTable.designImageUrl,
          drawing2dUrl: pullerVersionsTable.drawing2dUrl,
          drawing3dUrl: pullerVersionsTable.drawing3dUrl,
        })
        .from(pullerVersionsTable)
        .where(
          or(
            inArray(pullerVersionsTable.designImageUrl, referenceValues),
            inArray(pullerVersionsTable.drawing2dUrl, referenceValues),
            inArray(pullerVersionsTable.drawing3dUrl, referenceValues),
          ),
        );

      const referencedPaths = new Set<string>();
      for (const row of [...pullerReferences, ...versionReferences]) {
        for (const reference of Object.values(row)) {
          if (reference) {
            const objectPath = candidates.get(reference);
            if (objectPath) referencedPaths.add(objectPath);
          }
        }
      }

      const result = await cleanupUnreferencedUploadObjects(
        objectPaths,
        referencedPaths,
        (objectPath) => objectStorageService.deleteUploadedObject(objectPath),
      );
      res.json(CleanupUploadedObjectsResponse.parse(result));
    } catch (error) {
      req.log.error({ err: error }, 'Failed to clean up rejected import uploads');
      res.status(500).json({ error: 'Uploaded file cleanup could not be completed.' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  try {
    if (!hasAuthenticatedSession(req)) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
