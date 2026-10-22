import { Router, type IRouter } from "express";
import path from "path";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import {
  CreateCustomerBody,
  CreatePullerBody,
  CreatePullerVersionBody,
  CreateVendorBody,
  CreateVendorResponse,
  CreateCustomerResponse,
  CreatePullerResponse,
  CreatePullerVersionResponse,
  DashboardSummary,
  GetDashboardResponse,
  GetPullerParams,
  GetPullerResponse,
  GetVendorParams,
  GetVendorResponse,
  ListCustomersQueryParams,
  ListCustomersResponse,
  ListCustomersResponseItem,
  ListPullerVersionsParams,
  ListPullerVersionsResponse,
  ListPullersQueryParams,
  ListPullersResponse,
  ListVendorsResponse,
  ListVendorsResponseItem,
  ComparePullersBody,
  ComparePullersResponse,
  BulkImportPullersBody,
  BulkImportPullersResponse,
  PullerVersionInput,
  UpdatePullerBody,
  UpdatePullerParams,
  UpdatePullerMediaBody,
  UpdatePullerMediaParams,
  UpdatePullerMediaResponse,
  UpdatePullerResponse,
  UpdateVendorBody,
  UpdateVendorParams,
  UpdateVendorResponse,
} from "@workspace/api-zod";
import {
  customersTable,
  db,
  pullerVersionsTable,
  pullersTable,
  vendorsTable,
} from "@workspace/db";

const router: IRouter = Router();

router.use((req, res, next) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
});

const pullerColumns = getTableColumns(pullersTable);

type PullerRow = typeof pullersTable.$inferSelect & {
  vendorName: string;
  customerName: string;
  versionCount: number;
};

type PullerFilters = {
  q?: string;
  vendorId?: number;
  customerId?: number;
  size?: string;
  material?: string;
  finish?: string;
  status?: string;
  market?: string;
  page?: number;
  limit?: number;
  sort?: "recent" | "identifier" | "vendor";
};

function toNumber(value: number | string | null): number {
  return Number(value ?? 0);
}

async function getPullerRows(
  filters?: PullerFilters,
): Promise<PullerRow[]> {
  const conditions = [];
  if (filters?.vendorId !== undefined) {
    conditions.push(eq(pullersTable.vendorId, filters.vendorId));
  }
  if (filters?.customerId !== undefined) {
    conditions.push(eq(pullersTable.customerId, filters.customerId));
  }
  if (filters?.size) {
    conditions.push(ilike(pullersTable.size, `%${filters.size}%`));
  }
  if (filters?.material) {
    conditions.push(ilike(pullersTable.material, `%${filters.material}%`));
  }
  if (filters?.finish) {
    conditions.push(ilike(pullersTable.finish, `%${filters.finish}%`));
  }
  if (filters?.status) {
    conditions.push(eq(pullersTable.status, filters.status));
  }
  if (filters?.market) {
    conditions.push(ilike(pullersTable.marketType, `%${filters.market}%`));
  }
  if (filters?.q) {
    const query = `%${filters.q}%`;
    conditions.push(
      or(
        ilike(pullersTable.uniqueIdentifier, query),
        ilike(pullersTable.partName, query),
        ilike(pullersTable.waveCode, query),
        ilike(pullersTable.developmentNumber, query),
        ilike(pullersTable.mouldOrderNumber, query),
        ilike(pullersTable.logoMark, query),
        ilike(vendorsTable.name, query),
        ilike(customersTable.name, query),
      ),
    );
  }

  const rows = await db
    .select({
      ...pullerColumns,
      vendorName: vendorsTable.name,
      customerName: customersTable.name,
      versionCount: sql<number>`count(distinct ${pullerVersionsTable.id})`,
    })
    .from(pullersTable)
    .innerJoin(vendorsTable, eq(pullersTable.vendorId, vendorsTable.id))
    .innerJoin(customersTable, eq(pullersTable.customerId, customersTable.id))
    .leftJoin(
      pullerVersionsTable,
      eq(pullerVersionsTable.pullerId, pullersTable.id),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(pullersTable.id, vendorsTable.name, customersTable.name)
    .orderBy(
      filters?.sort === "identifier"
        ? asc(pullersTable.uniqueIdentifier)
        : filters?.sort === "vendor"
          ? asc(vendorsTable.name)
          : desc(pullersTable.updatedAt),
    );

  return rows.map((row) => ({ ...row, versionCount: toNumber(row.versionCount) }));
}

async function toPuller(row: PullerRow) {
  return {
    ...row,
    versionCount: row.versionCount,
  };
}

async function getVendorRows() {
  const rows = await db
    .select({
      ...getTableColumns(vendorsTable),
      pullerCount: sql<number>`count(distinct ${pullersTable.id})`,
      customerCount: sql<number>`count(distinct ${customersTable.id})`,
    })
    .from(vendorsTable)
    .leftJoin(pullersTable, eq(pullersTable.vendorId, vendorsTable.id))
    .leftJoin(customersTable, eq(customersTable.vendorId, vendorsTable.id))
    .groupBy(vendorsTable.id)
    .orderBy(asc(vendorsTable.name));

  return rows.map((row) => ({
    ...row,
    pullerCount: toNumber(row.pullerCount),
    customerCount: toNumber(row.customerCount),
  }));
}

async function getCustomerRows(vendorId?: number) {
  const rows = await db
    .select({
      ...getTableColumns(customersTable),
      vendorName: vendorsTable.name,
      pullerCount: sql<number>`count(distinct ${pullersTable.id})`,
    })
    .from(customersTable)
    .innerJoin(vendorsTable, eq(customersTable.vendorId, vendorsTable.id))
    .leftJoin(pullersTable, eq(pullersTable.customerId, customersTable.id))
    .where(vendorId === undefined ? undefined : eq(customersTable.vendorId, vendorId))
    .groupBy(customersTable.id, vendorsTable.name)
    .orderBy(asc(customersTable.name));

  return rows.map((row) => ({
    ...row,
    pullerCount: toNumber(row.pullerCount),
  }));
}

router.get("/dashboard", async (_req, res): Promise<void> => {
  const [vendors, customers, pullers, development, review, approved, mould, vendorCounts, recent, updated] =
    await Promise.all([
      db.select({ count: count() }).from(vendorsTable),
      db.select({ count: count() }).from(customersTable),
      db.select({ count: count() }).from(pullersTable),
      db.select({ count: count() }).from(pullersTable).where(eq(pullersTable.status, "development")),
      db.select({ count: count() }).from(pullersTable).where(eq(pullersTable.status, "review")),
      db.select({ count: count() }).from(pullersTable).where(eq(pullersTable.status, "approved")),
      db.select({ count: count() }).from(pullersTable).where(eq(pullersTable.status, "mould")),
      db
        .select({ vendorId: vendorsTable.id, vendorName: vendorsTable.name, count: sql<number>`count(${pullersTable.id})` })
        .from(vendorsTable)
        .leftJoin(pullersTable, eq(pullersTable.vendorId, vendorsTable.id))
        .groupBy(vendorsTable.id)
        .orderBy(desc(sql`count(${pullersTable.id})`), asc(vendorsTable.name)),
      getPullerRows({ page: 1, limit: 5, sort: "recent" }),
      getPullerRows({ page: 1, limit: 5, sort: "recent" }),
    ]);

  const payload = {
    metrics: {
      totalVendors: toNumber(vendors[0]?.count),
      totalCustomers: toNumber(customers[0]?.count),
      totalPullers: toNumber(pullers[0]?.count),
      activeDesigns: toNumber(pullers[0]?.count) - toNumber(development[0]?.count),
      underDevelopment: toNumber(development[0]?.count),
      awaitingApproval: toNumber(review[0]?.count),
      approvedDesigns: toNumber(approved[0]?.count),
      mouldsInProgress: toNumber(mould[0]?.count),
    },
    vendorCounts: vendorCounts.map((item) => ({ ...item, count: toNumber(item.count) })),
    recentPullers: await Promise.all(recent.map(toPuller)),
    recentlyUpdated: await Promise.all(updated.map(toPuller)),
  };

  res.json(GetDashboardResponse.parse(payload));
});

router.get("/vendors", async (_req, res): Promise<void> => {
  res.json(ListVendorsResponse.parse(await getVendorRows()));
});

router.post("/vendors", async (req, res): Promise<void> => {
  const parsed = CreateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [vendor] = await db.insert(vendorsTable).values(parsed.data).returning();
  const row = (await getVendorRows()).find((item) => item.id === vendor.id);
  res.status(201).json(CreateVendorResponse.parse(row));
});

router.get("/vendors/:vendorId", async (req, res): Promise<void> => {
  const params = GetVendorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = (await getVendorRows()).find((item) => item.id === params.data.vendorId);
  if (!row) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  res.json(GetVendorResponse.parse(row));
});

router.patch("/vendors/:vendorId", async (req, res): Promise<void> => {
  const params = UpdateVendorParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateVendorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [vendor] = await db
    .update(vendorsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(vendorsTable.id, params.data.vendorId))
    .returning();
  if (!vendor) {
    res.status(404).json({ error: "Vendor not found" });
    return;
  }
  const row = (await getVendorRows()).find((item) => item.id === vendor.id);
  res.json(UpdateVendorResponse.parse(row));
});

router.get("/customers", async (req, res): Promise<void> => {
  const params = ListCustomersQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  res.json(ListCustomersResponse.parse(await getCustomerRows(params.data.vendorId)));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [customer] = await db.insert(customersTable).values(parsed.data).returning();
  const row = (await getCustomerRows()).find((item) => item.id === customer.id);
  res.status(201).json(CreateCustomerResponse.parse(row));
});

router.get("/pullers", async (req, res): Promise<void> => {
  const parsed = ListPullersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = parsed.data;
  const rows = await getPullerRows(filters);
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 24;
  const start = (page - 1) * limit;
  const items = await Promise.all(rows.slice(start, start + limit).map(toPuller));
  res.json(ListPullersResponse.parse({ items, total: rows.length, page, limit }));
});

router.post("/pullers", async (req, res): Promise<void> => {
  const parsed = CreatePullerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await db
    .select({ id: pullersTable.id })
    .from(pullersTable)
    .where(eq(pullersTable.uniqueIdentifier, parsed.data.uniqueIdentifier));
  if (existing.length) {
    res.status(409).json({ error: "Puller identifier already exists" });
    return;
  }
  const [puller] = await db.insert(pullersTable).values(parsed.data).returning();
  const row = (await getPullerRows({ q: puller.uniqueIdentifier })).find((item) => item.id === puller.id);
  res.status(201).json(CreatePullerResponse.parse(row));
});

router.post("/pullers/bulk-import", async (req, res): Promise<void> => {
  const parsed = BulkImportPullersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const items = parsed.data.items;
  const ids = items.map((item) => item.pullerId);
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ error: "Each puller may appear only once in an import." });
    return;
  }
  if (items.some((item) =>
    !Object.keys(item.specifications ?? {}).length &&
    !item.media?.drawing2dUrl &&
    !item.media?.drawing3dUrl
  )) {
    res.status(400).json({ error: "Each import row must contain a specification value or a media file." });
    return;
  }

  const allowedExtensions = {
    drawing2d: new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]),
    drawing3d: new Set([".glb", ".stl"]),
  };
  for (const item of items) {
    const media = item.media;
    if (!media) continue;
    for (const kind of ["drawing2d", "drawing3d"] as const) {
      const url = media[`${kind}Url`];
      const name = media[`${kind}Name`];
      if ((url && !name) || (!url && name)) {
        res.status(400).json({ error: `Both the ${kind} file path and file name are required.` });
        return;
      }
      if (url && (!url.startsWith("/objects/") || !allowedExtensions[kind].has(path.extname(name!).toLowerCase()))) {
        res.status(400).json({ error: `Unsupported ${kind} media reference.` });
        return;
      }
    }
  }

  try {
    const importedCount = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(pullersTable)
        .where(inArray(pullersTable.id, ids))
        .for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const conflicts: string[] = [];
      const updates: { id: number; values: Record<string, unknown> }[] = [];

      for (const item of items) {
        const current = byId.get(item.pullerId);
        if (!current) {
          conflicts.push(`Puller record ${item.pullerId} no longer exists.`);
          continue;
        }

        const values: Record<string, unknown> = {};
        const specifications = item.specifications ?? {};
        for (const [field, value] of Object.entries(specifications)) {
          if (value === undefined) continue;
          const existing = current[field as keyof typeof current];
          if (existing !== null && existing !== value) {
            conflicts.push(`${current.uniqueIdentifier}: ${field} already has a different value.`);
            continue;
          }
          if (existing === null) values[field] = value;
        }

        for (const kind of ["drawing2d", "drawing3d"] as const) {
          const url = item.media?.[`${kind}Url`];
          const name = item.media?.[`${kind}Name`];
          if (!url || !name) continue;
          const existingUrl = current[`${kind}Url`];
          const existingName = current[`${kind}Name`];
          if (existingUrl || existingName) {
            conflicts.push(`${current.uniqueIdentifier}: ${kind === "drawing2d" ? "2D drawing" : "3D model"} already exists.`);
            continue;
          }
          values[`${kind}Url`] = url;
          values[`${kind}Name`] = name;
        }
        if (Object.keys(values).length) updates.push({ id: item.pullerId, values });
      }

      if (conflicts.length) {
        throw new Error(`IMPORT_CONFLICT:${conflicts.join(" ")}`);
      }

      for (const update of updates) {
        await tx
          .update(pullersTable)
          .set({ ...update.values, updatedAt: new Date() } as Partial<typeof pullersTable.$inferInsert>)
          .where(eq(pullersTable.id, update.id));
      }
      return items.length;
    });

    res.json(BulkImportPullersResponse.parse({ importedCount }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("IMPORT_CONFLICT:")) {
      res.status(409).json({ error: error.message.slice("IMPORT_CONFLICT:".length) });
      return;
    }
    throw error;
  }
});

router.get("/pullers/:pullerId", async (req, res): Promise<void> => {
  const params = GetPullerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = (await getPullerRows()).find((item) => item.id === params.data.pullerId);
  if (!row) {
    res.status(404).json({ error: "Puller not found" });
    return;
  }
  res.json(GetPullerResponse.parse(await toPuller(row)));
});

router.patch("/pullers/:pullerId", async (req, res): Promise<void> => {
  const params = UpdatePullerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePullerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [puller] = await db
    .update(pullersTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pullersTable.id, params.data.pullerId))
    .returning();
  if (!puller) {
    res.status(404).json({ error: "Puller not found" });
    return;
  }
  const row = (await getPullerRows({ q: puller.uniqueIdentifier })).find((item) => item.id === puller.id);
  res.json(UpdatePullerResponse.parse(await toPuller(row!)));
});

router.patch("/pullers/:pullerId/media", async (req, res): Promise<void> => {
  const params = UpdatePullerMediaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePullerMediaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [updated] = await db
    .update(pullersTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pullersTable.id, params.data.pullerId))
    .returning({ id: pullersTable.id });
  if (!updated) {
    res.status(404).json({ error: "Puller not found" });
    return;
  }
  const row = (await getPullerRows()).find((item) => item.id === updated.id);
  res.json(UpdatePullerMediaResponse.parse(await toPuller(row!)));
});

router.get("/pullers/:pullerId/versions", async (req, res): Promise<void> => {
  const params = ListPullerVersionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const versions = await db
    .select()
    .from(pullerVersionsTable)
    .where(eq(pullerVersionsTable.pullerId, params.data.pullerId))
    .orderBy(desc(pullerVersionsTable.versionNumber));
  res.json(ListPullerVersionsResponse.parse(versions));
});

router.post("/pullers/:pullerId/versions", async (req, res): Promise<void> => {
  const params = ListPullerVersionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreatePullerVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const current = await db
    .select({ max: sql<number>`coalesce(max(${pullerVersionsTable.versionNumber}), 0)` })
    .from(pullerVersionsTable)
    .where(eq(pullerVersionsTable.pullerId, params.data.pullerId));
  const [version] = await db
    .insert(pullerVersionsTable)
    .values({
      ...parsed.data,
      pullerId: params.data.pullerId,
      versionNumber: toNumber(current[0]?.max) + 1,
    })
    .returning();
  res.status(201).json(CreatePullerVersionResponse.parse(version));
});

router.post("/pullers/compare", async (req, res): Promise<void> => {
  const parsed = ComparePullersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await getPullerRows();
  const selected = parsed.data.ids
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is PullerRow => Boolean(row));
  res.json(ComparePullersResponse.parse(await Promise.all(selected.map(toPuller))));
});

export default router;