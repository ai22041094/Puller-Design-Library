import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {} from "../src/middlewares/authMiddleware";
import express, { type Request } from "express";
import { eq, inArray } from "drizzle-orm";
import { db, pool, customersTable, pullersTable, vendorsTable } from "@workspace/db";
import pullerLibraryRouter from "../src/routes/puller-library";

type PullerInsert = typeof pullersTable.$inferInsert;

async function createPuller(
  vendorId: number,
  customerId: number,
  suffix: string,
  overrides: Partial<PullerInsert> = {},
) {
  const [puller] = await db
    .insert(pullersTable)
    .values({
      uniqueIdentifier: `bulk-import-test-${suffix}`,
      partName: "Bulk import test puller",
      vendorId,
      customerId,
      ...overrides,
    })
    .returning();
  return puller;
}

async function readPullers(ids: number[]) {
  const rows = await db
    .select()
    .from(pullersTable)
    .where(inArray(pullersTable.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

test("bulk puller imports commit valid data and reject invalid batches atomically", async (t) => {
  const suffix = randomUUID();
  const [vendor] = await db
    .insert(vendorsTable)
    .values({ name: `Bulk import test ${suffix}`, code: `bulk-${suffix}` })
    .returning();
  const [customer] = await db
    .insert(customersTable)
    .values({
      vendorId: vendor.id,
      name: `Bulk import test ${suffix}`,
      code: `bulk-${suffix}`,
    })
    .returning();

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    req.isAuthenticated = function (
      this: Request,
    ): this is Express.AuthedRequest {
      return true;
    };
    next();
  });
  app.use("/api", pullerLibraryRouter);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/pullers/bulk-import`;

  async function withPullers<T>(
    count: number,
    run: (rows: Awaited<ReturnType<typeof createPuller>>[]) => Promise<T>,
    overrides: Partial<PullerInsert>[] = [],
  ): Promise<T> {
    const rows = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createPuller(
          vendor.id,
          customer.id,
          `${suffix}-${randomUUID()}-${index}`,
          overrides[index],
        ),
      ),
    );
    try {
      return await run(rows);
    } finally {
      await db
        .delete(pullersTable)
        .where(inArray(pullersTable.id, rows.map((row) => row.id)));
    }
  }

  async function submit(items: unknown[]) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
  }

  try {
    await t.test("imports specification-only rows", async () => {
      await withPullers(1, async ([puller]) => {
        const response = await submit([
          { pullerId: puller.id, specifications: { waveCode: "WAVE-42" } },
        ]);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { importedCount: 1 });
        assert.equal(
          (await readPullers([puller.id])).get(puller.id)?.waveCode,
          "WAVE-42",
        );
      });
    });

    await t.test("imports 2D and 3D media", async () => {
      await withPullers(1, async ([puller]) => {
        const response = await submit([
          {
            pullerId: puller.id,
            media: {
              drawing2dUrl: "/objects/test/drawing.pdf",
              drawing2dName: "drawing.pdf",
              drawing3dUrl: "/objects/test/model.glb",
              drawing3dName: "model.glb",
            },
          },
        ]);
        assert.equal(response.status, 200);
        const updated = (await readPullers([puller.id])).get(puller.id);
        assert.equal(updated?.drawing2dUrl, "/objects/test/drawing.pdf");
        assert.equal(updated?.drawing2dName, "drawing.pdf");
        assert.equal(updated?.drawing3dUrl, "/objects/test/model.glb");
        assert.equal(updated?.drawing3dName, "model.glb");
      });
    });

    await t.test(
      "rejects a batch containing a missing puller without updating valid rows",
      async () => {
      await withPullers(1, async ([puller]) => {
        const before = await readPullers([puller.id]);
        let missingId = 2_147_483_647;
        while (
          (
            await db
              .select({ id: pullersTable.id })
              .from(pullersTable)
              .where(eq(pullersTable.id, missingId))
          ).length
        ) {
          missingId -= 1;
        }
        const response = await submit([
          { pullerId: puller.id, specifications: { waveCode: "SHOULD-ROLL-BACK" } },
          { pullerId: missingId, specifications: { size: "Should not save" } },
        ]);
        assert.equal(response.status, 409);
        assert.deepEqual(await readPullers([puller.id]), before);
      });
      },
    );

    await t.test("rejects duplicate puller IDs without changes", async () => {
      await withPullers(1, async ([puller]) => {
        const before = await readPullers([puller.id]);
        const response = await submit([
          { pullerId: puller.id, specifications: { waveCode: "SHOULD-NOT-SAVE" } },
          { pullerId: puller.id, specifications: { size: "Should not save" } },
        ]);
        assert.equal(response.status, 400);
        assert.deepEqual(await readPullers([puller.id]), before);
      });
    });

    await t.test(
      "rejects conflicting specifications without partially updating the batch",
      async () => {
      await withPullers(
        2,
        async ([first, second]) => {
          const before = await readPullers([first.id, second.id]);
          const response = await submit([
            { pullerId: first.id, specifications: { waveCode: "SHOULD-ROLL-BACK" } },
            { pullerId: second.id, specifications: { size: "Different size" } },
          ]);
          assert.equal(response.status, 409);
          assert.deepEqual(await readPullers([first.id, second.id]), before);
        },
        [{}, { size: "Existing size" }],
      );
      },
    );

    await t.test(
      "serializes concurrent conflicting imports and rolls back the rejected batch",
      async () => {
        await withPullers(3, async ([shared, firstBatchOnly, secondBatchOnly]) => {
          const [firstResponse, secondResponse] = await Promise.all([
            submit([
              {
                pullerId: shared.id,
                specifications: { waveCode: "CONCURRENT-WAVE-A" },
              },
              {
                pullerId: firstBatchOnly.id,
                specifications: { size: "Batch A size" },
              },
            ]),
            submit([
              {
                pullerId: shared.id,
                specifications: { waveCode: "CONCURRENT-WAVE-B" },
              },
              {
                pullerId: secondBatchOnly.id,
                specifications: { size: "Batch B size" },
              },
            ]),
          ]);

          const successfulResponses = [firstResponse, secondResponse].filter(
            (response) => response.status === 200,
          );
          const rejectedResponses = [firstResponse, secondResponse].filter(
            (response) => response.status === 409,
          );
          assert.equal(successfulResponses.length, 1);
          assert.equal(rejectedResponses.length, 1);

          const [firstRows, secondRows] = await Promise.all([
            readPullers([shared.id, firstBatchOnly.id]),
            readPullers([shared.id, secondBatchOnly.id]),
          ]);
          const acceptedWaveCode = firstResponse.status === 200
            ? "CONCURRENT-WAVE-A"
            : "CONCURRENT-WAVE-B";
          assert.equal(firstRows.get(shared.id)?.waveCode, acceptedWaveCode);
          assert.equal(secondRows.get(shared.id)?.waveCode, acceptedWaveCode);

          const firstBatchAccepted = firstResponse.status === 200;
          assert.equal(
            firstRows.get(firstBatchOnly.id)?.size,
            firstBatchAccepted ? "Batch A size" : null,
          );
          assert.equal(
            secondRows.get(secondBatchOnly.id)?.size,
            firstBatchAccepted ? null : "Batch B size",
          );
          assert.deepEqual(await successfulResponses[0].json(), { importedCount: 2 });
          assert.match((await rejectedResponses[0].json()).error, /waveCode already has a different value/);
        });
      },
    );

    await t.test(
      "rejects an occupied media slot without partially updating the batch",
      async () => {
      await withPullers(
        2,
        async ([first, second]) => {
          const before = await readPullers([first.id, second.id]);
          const response = await submit([
            {
              pullerId: first.id,
              media: {
                drawing3dUrl: "/objects/test/new-model.stl",
                drawing3dName: "new-model.stl",
              },
            },
            {
              pullerId: second.id,
              media: {
                drawing2dUrl: "/objects/test/replacement.pdf",
                drawing2dName: "replacement.pdf",
              },
            },
          ]);
          assert.equal(response.status, 409);
          assert.deepEqual(await readPullers([first.id, second.id]), before);
        },
        [
          {},
          {
            drawing2dUrl: "/objects/test/existing.pdf",
            drawing2dName: "existing.pdf",
          },
        ],
      );
      },
    );

    await t.test(
      "does not update rows when existing specifications are identical",
      async () => {
      await withPullers(
        1,
        async ([puller]) => {
          const before = await readPullers([puller.id]);
          const response = await submit([
            { pullerId: puller.id, specifications: { waveCode: "SAME-WAVE" } },
          ]);
          assert.equal(response.status, 200);
          assert.deepEqual(await readPullers([puller.id]), before);
        },
        [{ waveCode: "SAME-WAVE" }],
      );
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.delete(customersTable).where(eq(customersTable.id, customer.id));
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendor.id));
    await pool.end();
  }
});
