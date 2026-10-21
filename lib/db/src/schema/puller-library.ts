import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const vendorsTable = pgTable(
  "vendors",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    logoUrl: text("logo_url"),
    contactPerson: text("contact_person"),
    email: text("email"),
    phone: text("phone"),
    country: text("country"),
    status: text("status").notNull().default("active"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    vendorCodeIndex: uniqueIndex("vendors_code_unique").on(table.code),
  }),
);

export const customersTable = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    vendorId: integer("vendor_id")
      .notNull()
      .references(() => vendorsTable.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    logoUrl: text("logo_url"),
    depotCode: text("depot_code"),
    location: text("location"),
    marketType: text("market_type"),
    contactPerson: text("contact_person"),
    status: text("status").notNull().default("active"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    customerCodeIndex: uniqueIndex("customers_vendor_code_unique").on(
      table.vendorId,
      table.code,
    ),
  }),
);

export const pullersTable = pgTable(
  "pullers",
  {
    id: serial("id").primaryKey(),
    uniqueIdentifier: text("unique_identifier").notNull(),
    partName: text("part_name").notNull(),
    waveCode: text("wave_code"),
    developmentNumber: text("development_number"),
    mouldOrderNumber: text("mould_order_number"),
    size: text("size"),
    compatibilityType: text("compatibility_type"),
    material: text("material"),
    assemblyType: text("assembly_type"),
    logoMark: text("logo_mark"),
    color: text("color"),
    finish: text("finish"),
    specialProcess: text("special_process"),
    torqueCpsc: text("torque_cpsc"),
    pcsPerShot: text("pcs_per_shot"),
    inHouseOutsource: text("in_house_outsource"),
    capacity: text("capacity"),
    cost: text("cost"),
    needleDetector: text("needle_detector"),
    vendorId: integer("vendor_id")
      .notNull()
      .references(() => vendorsTable.id),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id),
    buyerName: text("buyer_name"),
    depotCode: text("depot_code"),
    requestedBy: text("requested_by"),
    marketType: text("market_type"),
    status: text("status").notNull().default("draft"),
    requirementName: text("requirement_name"),
    requirementNumber: text("requirement_number"),
    remarks: text("remarks"),
    imageUrl: text("image_url"),
    imageLabel: text("image_label"),
    drawing2dUrl: text("drawing_2d_url"),
    drawing2dName: text("drawing_2d_name"),
    drawing3dUrl: text("drawing_3d_url"),
    drawing3dName: text("drawing_3d_name"),
    dimensionUnit: text("dimension_unit").notNull().default("mm"),
    overallLength: doublePrecision("overall_length"),
    overallWidth: doublePrecision("overall_width"),
    overallHeight: doublePrecision("overall_height"),
    thickness: doublePrecision("thickness"),
    holeDiameter: doublePrecision("hole_diameter"),
    holeSpacing: doublePrecision("hole_spacing"),
    weight: doublePrecision("weight"),
    favorite: boolean("favorite").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueIdentifierIndex: uniqueIndex("pullers_unique_identifier_unique").on(
      table.uniqueIdentifier,
    ),
  }),
);

export const pullerVersionsTable = pgTable(
  "puller_versions",
  {
    id: serial("id").primaryKey(),
    pullerId: integer("puller_id")
      .notNull()
      .references(() => pullersTable.id),
    versionNumber: integer("version_number").notNull(),
    designImageUrl: text("design_image_url"),
    drawing2dUrl: text("drawing_2d_url"),
    drawing3dUrl: text("drawing_3d_url"),
    changesDescription: text("changes_description").notNull(),
    approvalStatus: text("approval_status").notNull().default("draft"),
    createdBy: text("created_by").notNull().default("R&D team"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pullerVersionIndex: uniqueIndex("puller_versions_puller_version_unique").on(
      table.pullerId,
      table.versionNumber,
    ),
  }),
);