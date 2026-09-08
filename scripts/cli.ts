#!/usr/bin/env npx tsx

import {
  z,
  createCommand,
  runCli,
  cacheCommands,
  cliTypes,
  wrapUntrustedField,
  buildSafeOutput,
  TRUNCATION_DEFAULTS,
} from "@local/cli-utils";
import type { GlobalFlags } from "@local/cli-utils";
import {
  InFlowMCPClient,
  type ExplicitMutationConfirmation,
  type MutationResult,
} from "./mcp-client.js";
import { readReorderThresholds } from "./reorder-settings.js";
import {
  fetchStockNoPhotoReport,
  type StockNoPhotoReport,
} from "./stock-no-photo.js";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";


type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" ? (value as AnyRecord) : {};
}

function readWrappedReorderThresholds(product: AnyRecord, pathPrefix: string) {
  const thresholds = readReorderThresholds(product);
  if (!thresholds.reorderSettings) return thresholds;

  return {
    ...thresholds,
    reorderSettings: thresholds.reorderSettings.map((setting, index) => ({
      ...setting,
      locationName: wrapUntrustedField(
        `${pathPrefix}.reorderSettings[${index}].locationName`,
        setting.locationName ?? "",
        { maxChars: TRUNCATION_DEFAULTS.subject }
      ),
    })),
  };
}

function wrapProduct(product: AnyRecord, pathPrefix: string) {
  const customFields = asRecord(product.customFields);
  const category = asRecord(product.category);

  return {
    name: wrapUntrustedField(
      `${pathPrefix}.name`,
      product.name ?? "",
      { maxChars: TRUNCATION_DEFAULTS.subject }
    ),
    description: wrapUntrustedField(
      `${pathPrefix}.description`,
      product.description ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    customFields: Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        wrapUntrustedField(
          `${pathPrefix}.customFields.${key}`,
          value == null ? "" : String(value),
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      ])
    ),
    category: category.name
      ? {
          categoryId: category.categoryId,
          name: wrapUntrustedField(
            `${pathPrefix}.category.name`,
            category.name,
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
        }
      : undefined,
  };
}

function wrapAddress(address: AnyRecord, pathPrefix: string) {
  const fields: Record<string, ReturnType<typeof wrapUntrustedField>> = {};
  for (const key of [
    "street1",
    "street2",
    "city",
    "state",
    "postalCode",
    "country",
  ]) {
    if (address[key] !== undefined) {
      fields[key] = wrapUntrustedField(
        `${pathPrefix}.${key}`,
        address[key] ?? "",
        { maxChars: TRUNCATION_DEFAULTS.subject }
      );
    }
  }
  return fields;
}

function wrapCustomer(customer: AnyRecord, pathPrefix: string) {
  const billingAddress = asRecord(customer.billingAddress);
  const shippingAddress = asRecord(customer.shippingAddress);
  const customFields = asRecord(customer.customFields);

  return {
    name: wrapUntrustedField(
      `${pathPrefix}.name`,
      customer.name ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    email: wrapUntrustedField(
      `${pathPrefix}.email`,
      customer.email ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    phone: wrapUntrustedField(
      `${pathPrefix}.phone`,
      customer.phone ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    fax: wrapUntrustedField(
      `${pathPrefix}.fax`,
      customer.fax ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    website: wrapUntrustedField(
      `${pathPrefix}.website`,
      customer.website ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    billingAddress: wrapAddress(billingAddress, `${pathPrefix}.billingAddress`),
    shippingAddress: wrapAddress(shippingAddress, `${pathPrefix}.shippingAddress`),
    remarks: wrapUntrustedField(
      `${pathPrefix}.remarks`,
      customer.remarks ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    customFields: Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        wrapUntrustedField(
          `${pathPrefix}.customFields.${key}`,
          value == null ? "" : String(value),
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      ])
    ),
  };
}

function wrapVendor(vendor: AnyRecord, pathPrefix: string) {
  const address = asRecord(vendor.address);
  const customFields = asRecord(vendor.customFields);

  return {
    name: wrapUntrustedField(
      `${pathPrefix}.name`,
      vendor.name ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    email: wrapUntrustedField(
      `${pathPrefix}.email`,
      vendor.email ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    phone: wrapUntrustedField(
      `${pathPrefix}.phone`,
      vendor.phone ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    fax: wrapUntrustedField(
      `${pathPrefix}.fax`,
      vendor.fax ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    website: wrapUntrustedField(
      `${pathPrefix}.website`,
      vendor.website ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    address: wrapAddress(address, `${pathPrefix}.address`),
    customFields: Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        wrapUntrustedField(
          `${pathPrefix}.customFields.${key}`,
          value == null ? "" : String(value),
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      ])
    ),
  };
}

function wrapOrderLines(lines: unknown[], pathPrefix: string) {
  return (lines ?? []).map((rawLine, index) => {
    const line = asRecord(rawLine);
    return {
      ...line,
      description: wrapUntrustedField(
        `${pathPrefix}[${index}].description`,
        line.description ?? "",
        { maxChars: TRUNCATION_DEFAULTS.body }
      ),
    };
  });
}

const TRUSTED_SALES_ORDER_LINE_KEY =
  /^(?:barcode|containerNumber|createdDate|currencyCode|lineNum|modifiedDate|orderNumber|quantity|serial|serialNumber|serialNumbers|shippedDate|sku|standardQuantity|status|timestamp|trackingNumber|unitCost|unitPrice|uom|uomQuantity)$/i;
const TRUSTED_SALES_ORDER_LINE_ID_KEY = /(?:^id$|Id$|Ids$)/;

function wrapSalesOrderLineValue(
  value: unknown,
  pathPrefix: string,
  key = ""
): unknown {
  if (typeof value === "string") {
    const isTrusted =
      TRUSTED_SALES_ORDER_LINE_KEY.test(key) ||
      TRUSTED_SALES_ORDER_LINE_ID_KEY.test(key);
    return isTrusted
      ? value
      : wrapUntrustedField(pathPrefix, value, {
          maxChars: TRUNCATION_DEFAULTS.body,
        });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      wrapSalesOrderLineValue(item, `${pathPrefix}[${index}]`, key)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as AnyRecord).map(([childKey, child]) => [
        childKey,
        wrapSalesOrderLineValue(
          child,
          `${pathPrefix}.${childKey}`,
          childKey
        ),
      ])
    );
  }
  return value;
}

function wrapSalesOrderLineFamily(lines: unknown, pathPrefix: string) {
  if (!Array.isArray(lines)) return undefined;
  return lines.map((line, index) =>
    wrapSalesOrderLineValue(line, `${pathPrefix}[${index}]`)
  );
}

function wrapLocation(location: AnyRecord, pathPrefix: string) {
  const address = asRecord(location.address);

  return {
    name: wrapUntrustedField(
      `${pathPrefix}.name`,
      location.name ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    address: wrapAddress(address, `${pathPrefix}.address`),
  };
}

function wrapSalesOrderContent(order: AnyRecord, pathPrefix: string) {
  const customer = asRecord(order.customer);
  const billingAddress = asRecord(order.billingAddress);
  const shippingAddress = asRecord(order.shippingAddress);
  const customFields = asRecord(order.customFields);
  const lines = Array.isArray(order.lines) ? (order.lines as unknown[]) : [];

  return {
    customer: Object.keys(customer).length > 0
      ? {
          customerId: customer.customerId,
          ...wrapCustomer(customer, `${pathPrefix}.customer`),
        }
      : undefined,
    billingAddress: wrapAddress(billingAddress, `${pathPrefix}.billingAddress`),
    shippingAddress: wrapAddress(shippingAddress, `${pathPrefix}.shippingAddress`),
    lines: wrapOrderLines(lines, `${pathPrefix}.lines`),
    pickLines: wrapSalesOrderLineFamily(
      order.pickLines,
      `${pathPrefix}.pickLines`
    ),
    packLines: wrapSalesOrderLineFamily(
      order.packLines,
      `${pathPrefix}.packLines`
    ),
    shipLines: wrapSalesOrderLineFamily(
      order.shipLines,
      `${pathPrefix}.shipLines`
    ),
    orderRemarks: wrapUntrustedField(
      `${pathPrefix}.orderRemarks`,
      order.orderRemarks ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    customFields: Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        wrapUntrustedField(
          `${pathPrefix}.customFields.${key}`,
          value == null ? "" : String(value),
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      ])
    ),
  };
}

function salesOrderMetadata(order: AnyRecord) {
  return {
    salesOrderId: order.salesOrderId,
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    requiredDate: order.requiredDate,
    customerId: order.customerId,
    locationId: order.locationId,
    status: order.status,
    inventoryStatus: order.inventoryStatus,
    currencyCode: order.currencyCode,
    exchangeRate: order.exchangeRate,
    subtotal: order.subtotal,
    taxTotal: order.taxTotal,
    total: order.total,
    amountPaid: order.amountPaid,
    balance: order.balance,
    timestamp: order.timestamp,
    createdDate: order.createdDate,
    modifiedDate: order.lastModifiedDateTime ?? order.modifiedDate,
  };
}

function wrapPurchaseOrderContent(order: AnyRecord, pathPrefix: string) {
  const vendor = asRecord(order.vendor);
  const shippingAddress = asRecord(order.shippingAddress);
  const customFields = asRecord(order.customFields);
  const lines = Array.isArray(order.lines) ? (order.lines as unknown[]) : [];

  return {
    vendor: Object.keys(vendor).length > 0
      ? {
          vendorId: vendor.vendorId,
          ...wrapVendor(vendor, `${pathPrefix}.vendor`),
        }
      : undefined,
    shippingAddress: wrapAddress(shippingAddress, `${pathPrefix}.shippingAddress`),
    lines: wrapOrderLines(lines, `${pathPrefix}.lines`),
    orderRemarks: wrapUntrustedField(
      `${pathPrefix}.orderRemarks`,
      order.orderRemarks ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    customFields: Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        wrapUntrustedField(
          `${pathPrefix}.customFields.${key}`,
          value == null ? "" : String(value),
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      ])
    ),
  };
}

function purchaseOrderMetadata(order: AnyRecord) {
  return {
    purchaseOrderId: order.purchaseOrderId,
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    expectedDate: order.expectedDate,
    vendorId: order.vendorId,
    locationId: order.locationId,
    status: order.status,
    inventoryStatus: order.inventoryStatus,
    currencyCode: order.currencyCode,
    exchangeRate: order.exchangeRate,
    subtotal: order.subtotal,
    taxTotal: order.taxTotal,
    total: order.total,
    timestamp: order.timestamp,
    createdDate: order.createdDate,
    modifiedDate: order.lastModifiedDateTime ?? order.modifiedDate,
  };
}

function wrapCategory(category: AnyRecord, pathPrefix: string) {
  const parentCategory = asRecord(category.parentCategory);

  return {
    name: wrapUntrustedField(
      `${pathPrefix}.name`,
      category.name ?? "",
      { maxChars: TRUNCATION_DEFAULTS.subject }
    ),
    parentCategory: parentCategory.name
      ? {
          categoryId: parentCategory.categoryId,
          name: wrapUntrustedField(
            `${pathPrefix}.parentCategory.name`,
            parentCategory.name,
            { maxChars: TRUNCATION_DEFAULTS.subject }
          ),
        }
      : undefined,
  };
}

function parseJsonArray(value: unknown, flagName: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new Error(`${flagName} must be a valid JSON array`);
  }
}

function parseJsonObject(value: unknown, flagName: string): AnyRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as AnyRecord;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as AnyRecord;
  } catch {
    throw new Error(`${flagName} must be a valid JSON object`);
  }
}

type PurchaseOrderLineWriteProjection = {
  purchaseOrderLineId: string;
  productId: string;
  description?: string;
  quantity: {
    standardQuantity: string | number;
    uomQuantity: string | number;
    serialNumbers?: string[];
  };
  unitPrice: string | number;
  taxCodeId?: string;
  sublocation?: string;
};

const PINNED_PO_LINE_WRITABLE_FIELDS = new Set([
  "purchaseOrderLineId",
  "productId",
  "description",
  "quantity",
  "unitPrice",
  "taxCodeId",
  "sublocation",
]);

const PINNED_PO_RECEIVE_FIELDS = [
  "receivedQuantity",
  "quantityReceived",
  "receiveLines",
  "purchaseOrderReceiveLines",
  "received",
  "isReceived",
] as const;

const PINNED_PO_LINE_READ_ONLY_FIELDS = new Set([
  "timestamp",
  "status",
  "subTotal",
  "product",
  ...PINNED_PO_RECEIVE_FIELDS,
]);

const PINNED_PO_QUANTITY_FIELDS = new Set([
  "standardQuantity",
  "uomQuantity",
  "serialNumbers",
  ...PINNED_PO_RECEIVE_FIELDS,
]);

function meaningfulReadOnlyReceiveState(line: AnyRecord, quantity: AnyRecord) {
  return PINNED_PO_RECEIVE_FIELDS.some((field) => {
    const value = line[field] ?? quantity[field];
    if (value === undefined || value === null || value === false || value === 0) {
      return false;
    }
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") {
      return value.trim() !== "" && !/^0(?:\.0+)?$/u.test(value.trim());
    }
    return true;
  });
}

function purchaseOrderLineWriteProjection(
  rawLine: unknown,
  index: number
): PurchaseOrderLineWriteProjection {
  const line = asRecord(rawLine);
  const quantity = asRecord(line.quantity);
  const purchaseOrderLineId = line.purchaseOrderLineId;
  const productId = line.productId;
  const standardQuantity = quantity.standardQuantity;
  const uomQuantity = quantity.uomQuantity;
  const unitPrice = line.unitPrice;
  const serialNumbers = quantity.serialNumbers;

  const fail = (reason: string): never => {
    throw new Error(
      `ADD_PO_ITEM_APPLY_DISABLED: existing PO line ${index + 1} ${reason}. ` +
        "Use set-purchase-order --values with a separately reviewed exact writable projection, or migrate to a narrow exact-ID append operation when the MCP exposes one."
    );
  };
  const unsupportedLineFields = Object.keys(line).filter(
    (field) =>
      !PINNED_PO_LINE_WRITABLE_FIELDS.has(field) &&
      !PINNED_PO_LINE_READ_ONLY_FIELDS.has(field)
  );
  if (unsupportedLineFields.length > 0) {
    return fail(
      `contains uncharacterized fields (${unsupportedLineFields.sort().join(", ")}) whose exact writable semantics cannot be proven`
    );
  }
  const unsupportedQuantityFields = Object.keys(quantity).filter(
    (field) => !PINNED_PO_QUANTITY_FIELDS.has(field)
  );
  if (unsupportedQuantityFields.length > 0) {
    return fail(
      `contains uncharacterized quantity fields (${unsupportedQuantityFields.sort().join(", ")}) whose exact writable semantics cannot be proven`
    );
  }
  if (typeof purchaseOrderLineId !== "string" || !purchaseOrderLineId) {
    return fail("does not have a purchaseOrderLineId");
  }
  if (typeof productId !== "string" || !productId) {
    return fail("does not have a direct productId");
  }
  if (
    (typeof standardQuantity !== "string" &&
      typeof standardQuantity !== "number") ||
    String(standardQuantity).trim() === "" ||
    (typeof uomQuantity !== "string" && typeof uomQuantity !== "number") ||
    String(uomQuantity).trim() === ""
  ) {
    return fail("does not expose both exact standardQuantity and uomQuantity");
  }
  if (
    (typeof unitPrice !== "string" && typeof unitPrice !== "number") ||
    String(unitPrice).trim() === ""
  ) {
    return fail("does not expose an exact unitPrice");
  }
  if (
    serialNumbers !== undefined &&
    (!Array.isArray(serialNumbers) ||
      serialNumbers.some((serial) => typeof serial !== "string" || !serial))
  ) {
    return fail("has serial data outside the pinned writable string-array shape");
  }
  if (meaningfulReadOnlyReceiveState(line, quantity)) {
    return fail("has receive state that set_purchase_order cannot preserve exactly");
  }

  return {
    purchaseOrderLineId,
    productId,
    ...(typeof line.description === "string"
      ? { description: line.description }
      : {}),
    quantity: {
      standardQuantity,
      uomQuantity,
      ...(Array.isArray(serialNumbers) ? { serialNumbers } : {}),
    },
    unitPrice,
    ...(typeof line.taxCodeId === "string"
      ? { taxCodeId: line.taxCodeId }
      : {}),
    ...(typeof line.sublocation === "string"
      ? { sublocation: line.sublocation }
      : {}),
  };
}

function parseIncludeList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const includes = value
    .split(",")
    .map((include) => include.trim())
    .filter(Boolean);
  return includes.length > 0 ? [...new Set(includes)] : undefined;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function writeRestrictedJson(
  path: string,
  value: unknown,
  options: { overwrite?: boolean } = {}
): string {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporaryPath, 0o600);
    if (options.overwrite === true) {
      renameSync(temporaryPath, outputPath);
    } else {
      linkSync(temporaryPath, outputPath);
      rmSync(temporaryPath, { force: true });
    }
    chmodSync(outputPath, 0o600);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (
      !options.overwrite &&
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      pathEntryExists(outputPath)
    ) {
      throw new Error(
        `Output file already exists: ${outputPath}. Use --overwrite true with --confirm to replace it.`
      );
    }
    throw error;
  }
  return outputPath;
}

type AllVinScan = {
  serials: unknown[];
  totalSerials: number;
  productsFetched: number;
  scanLimit: number;
  scanTruncated: boolean;
  providerHasMore: boolean;
};

async function fetchAllVins(
  client: InFlowMCPClient,
  options: { maxProducts?: number; inStockOnly?: boolean }
): Promise<AllVinScan> {
  const result = await client.listAllSerials(options);
  const resultRecord = asRecord(result);
  const rawSerials = Array.isArray(resultRecord.serials)
    ? (resultRecord.serials as unknown[])
    : [];
  const serials = rawSerials.map((rawSerial, index) => {
    const serial = asRecord(rawSerial);
    return {
      serial: serial.serial,
      productId: serial.productId,
      locationId: serial.locationId,
      quantityOnHand: serial.quantityOnHand,
      inStock: serial.inStock,
      productName: wrapUntrustedField(
        `serials[${index}].productName`,
        serial.productName ?? "",
        { maxChars: TRUNCATION_DEFAULTS.subject }
      ),
      sublocation: wrapUntrustedField(
        `serials[${index}].sublocation`,
        serial.sublocation ?? "",
        { maxChars: TRUNCATION_DEFAULTS.displayName }
      ),
    };
  });
  const productsFetchedValue = Number(
    resultRecord.productsFetched ?? resultRecord.scannedProducts ?? 0
  );
  const productsFetched =
    Number.isFinite(productsFetchedValue) && productsFetchedValue >= 0
      ? productsFetchedValue
      : 0;
  const scanLimit = options.maxProducts ?? 100;
  const scanTruncated =
    resultRecord.truncated === true ||
    resultRecord.hasMore === true ||
    productsFetched >= scanLimit;

  return {
    serials,
    totalSerials: serials.length,
    productsFetched,
    scanLimit,
    scanTruncated,
    providerHasMore: resultRecord.hasMore === true,
  };
}

const genericSafeSetConfirmationHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional()
  .describe("Exact full review hash from a prior preview");

const genericSafeSetPreviewIdentitySchema = z
  .string()
  .min(1)
  .optional();

const idlessCreateConfirmationFields = {
  confirmPreviewToken: genericSafeSetPreviewIdentitySchema.describe(
    "Reviewed preview token required for an id-less create"
  ),
  confirmIdempotencyKey: genericSafeSetPreviewIdentitySchema.describe(
    "Reviewed idempotency key required for an id-less create"
  ),
};

const safeSetSchema = z.object({
  id: z.string().min(1).optional(),
  mode: z.enum(["patch", "replace"]).default("patch"),
  values: z.string().default("{}").describe("JSON object of exact writable values"),
  apply: cliTypes.bool().optional(),
  confirmPreviewHash: genericSafeSetConfirmationHashSchema,
  ...idlessCreateConfirmationFields,
});

const REMOVE_WEBHOOK_STATIC_SUPPORT = false;

function makeSafeSetHandler(tool: string, idField: string, tags: (id?: string) => string[]) {
  return async (args: unknown, client: InFlowMCPClient, globals: GlobalFlags) => {
    const values = args as {
      id?: string;
      mode: "patch" | "replace";
      values: string;
      apply?: boolean;
      confirmPreviewHash?: string;
      confirmPreviewToken?: string;
      confirmIdempotencyKey?: string;
    };
    const request: Record<string, unknown> = { mode: values.mode, values: parseJsonObject(values.values, "--values") };
    if (values.id) request[idField] = values.id;
    return runConfirmedSafeSet({
      command: tool.replaceAll("_", "-"),
      tool,
      request,
      apply: values.apply === true,
      confirmPreviewHash: values.confirmPreviewHash,
      confirmPreviewToken: values.confirmPreviewToken,
      confirmIdempotencyKey: values.confirmIdempotencyKey,
      tags: tags(values.id),
      client,
      globals,
    });
  };
}

function parseProductIds(value: unknown): string[] {
  const ids = Array.isArray(value)
    ? value.map(String)
    : String(value ?? "").split(",");
  const normalized = ids.map((id) => id.trim()).filter(Boolean);
  if (normalized.length < 2 || normalized.length > 25) {
    throw new Error("--productIds requires 2-25 comma-separated product IDs");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("--productIds must not contain duplicates");
  }
  return normalized;
}

function wrapUnknownExternal(value: unknown, pathPrefix: string): unknown {
  if (typeof value === "string") {
    return wrapUntrustedField(pathPrefix, value, {
      maxChars: TRUNCATION_DEFAULTS.body,
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      wrapUnknownExternal(item, `${pathPrefix}[${index}]`)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        wrapUnknownExternal(item, `${pathPrefix}.${key}`),
      ])
    );
  }
  return value;
}

const TRUSTED_EXTERNAL_KEY = /(?:^|_)(?:id|ids|hash|timestamp|date|quantity|count|applied|verified|complete|active|enabled|retryable|price|cost|markup|amount|stock|shortage|shortfall|required|buildable|seconds|hours)$/i;
const TRUSTED_OPERATIONAL_CONTROL_KEYS = new Set([
  "previewToken",
  "idempotencyKey",
  "confirmPreviewToken",
  "confirmIdempotencyKey",
]);

function wrapOperationalResult(value: unknown, pathPrefix: string, key = ""): unknown {
  if (typeof value === "string") {
    return TRUSTED_OPERATIONAL_CONTROL_KEYS.has(key) || TRUSTED_EXTERNAL_KEY.test(key) || /(?:Id|Ids|Hash|Timestamp|Quantity|Count|Price|Cost|Markup|Amount|Stock|Shortage|Shortfall|Required|Buildable|Seconds|Hours)$/.test(key)
      ? value
      : wrapUntrustedField(pathPrefix, value, { maxChars: TRUNCATION_DEFAULTS.body });
  }
  if (Array.isArray(value)) return value.map((item, index) => wrapOperationalResult(item, `${pathPrefix}[${index}]`, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as AnyRecord).map(([childKey, child]) => [childKey, wrapOperationalResult(child, `${pathPrefix}.${childKey}`, childKey)]));
  return value;
}

function buildOperationalSafeOutput(command: string, raw: unknown) {
  const record = asRecord(raw);
  return buildSafeOutput(
    {
      command,
      operationId: record.operationId,
      resourceId: record.resourceId,
      applicationState: record.applicationState,
      applied: record.applied,
      verified: record.verified,
      complete: record.complete,
    },
    { result: wrapOperationalResult(record, "result") },
  );
}

function wrapManufacturingState(rawState: unknown, pathPrefix: string) {
  const state = asRecord(rawState);
  const components = Array.isArray(state.components) ? state.components : [];
  const operations = Array.isArray(state.productOperations)
    ? state.productOperations
    : [];
  const itemBoms = Array.isArray(state.itemBoms) ? state.itemBoms : [];
  const settings = asRecord(state.settings);
  const productVariant = asRecord(state.productVariant);
  return {
    productId: state.productId,
    productSku: wrapUntrustedField(
      `${pathPrefix}.productSku`,
      state.productSku ?? "",
      { maxChars: TRUNCATION_DEFAULTS.displayName }
    ),
    productTimestamp: state.productTimestamp,
    isManufacturable: state.isManufacturable,
    componentCount: state.componentCount,
    settings: {
      autoAssemble: settings.autoAssemble,
      includeQuantityBuildable: settings.includeQuantityBuildable,
    },
    productVariant: state.productVariant
      ? {
          productVariantId: productVariant.productVariantId,
          productGroupId: productVariant.productGroupId,
          productId: productVariant.productId,
          timestamp: productVariant.timestamp,
          variantOption: wrapUnknownExternal(
            productVariant.variantOption,
            `${pathPrefix}.productVariant.variantOption`
          ),
        }
      : undefined,
    productName: wrapUntrustedField(
      `${pathPrefix}.productName`,
      state.productName ?? "",
      { maxChars: TRUNCATION_DEFAULTS.subject }
    ),
    components: components.map((rawComponent, index) => {
      const component = asRecord(rawComponent);
      return {
        itemBomId: component.itemBomId,
        timestamp: component.timestamp,
        childProductId: component.childProductId,
        childProductSku: wrapUntrustedField(
          `${pathPrefix}.components[${index}].childProductSku`,
          component.childProductSku ?? "",
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        ),
        childProductIsActive: component.childProductIsActive,
        quantity: component.quantity,
        uomQuantity: component.uomQuantity,
        uom: component.uom,
        childProductName: wrapUntrustedField(
          `${pathPrefix}.components[${index}].childProductName`,
          component.childProductName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
      };
    }),
    itemBoms: itemBoms.map((rawItemBom) => {
      const itemBom = asRecord(rawItemBom);
      return {
        itemBomId: itemBom.itemBomId,
        productId: itemBom.productId,
        childProductId: itemBom.childProductId,
        quantity: itemBom.quantity,
        timestamp: itemBom.timestamp,
      };
    }),
    productOperations: operations.map((rawOperation, index) => {
      const operation = asRecord(rawOperation);
      return {
        productOperationId: operation.productOperationId,
        timestamp: operation.timestamp,
        operationTypeId: operation.operationTypeId,
        lineNum: operation.lineNum,
        cost: operation.cost,
        estimatedPerHourCost: operation.estimatedPerHourCost,
        estimatedSeconds: operation.estimatedSeconds,
        trackTime: operation.trackTime,
        operationTypeName: wrapUntrustedField(
          `${pathPrefix}.productOperations[${index}].operationTypeName`,
          operation.operationTypeName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
        instructions: wrapUntrustedField(
          `${pathPrefix}.productOperations[${index}].instructions`,
          operation.instructions ?? "",
          { maxChars: TRUNCATION_DEFAULTS.body }
        ),
      };
    }),
    warnings: (Array.isArray(state.warnings) ? state.warnings : []).map(
      (warning, index) =>
        wrapUntrustedField(`${pathPrefix}.warnings[${index}]`, warning ?? "", {
          maxChars: TRUNCATION_DEFAULTS.body,
        })
    ),
  };
}

function buildManufacturingSafeOutput(raw: unknown, command: string) {
  const record = asRecord(raw);
  const state = record.before || record.desired || record.actual
    ? undefined
    : record;
  const confirmationRerun =
    record.applicationState === "preview" &&
    typeof record.confirmationHash === "string" &&
    SHA256_HEX.test(record.confirmationHash)
      ? {
          apply: true,
          confirm: true,
          confirmPreviewHash: record.confirmationHash,
        }
      : undefined;
  return buildSafeOutput(
    {
      command,
      productId: record.productId ?? record.resourceId,
      productTimestamp: record.productTimestamp,
      isManufacturable: record.isManufacturable,
      componentCount: record.componentCount,
      settings: record.settings,
      dryRun: record.dryRun,
      noOp: record.noOp,
      applied: record.applied,
      applicationState: record.applicationState,
      operationId: record.operationId,
      previewToken: record.previewToken,
      idempotencyKey: record.idempotencyKey,
      currentSemanticHash: record.currentSemanticHash,
      currentWriteShapeHash: record.currentWriteShapeHash,
      desiredHash: record.desiredHash,
      confirmationScope: record.confirmationScope,
      confirmationHash: record.confirmationHash,
      confirmationRerun,
      confirmationValidated: record.confirmationValidated,
      entityTimestamp: record.entityTimestamp,
      cacheInvalidationRequired: record.cacheInvalidationRequired,
      verified: record.verified,
      applyEnabled: record.applyEnabled,
      currentConfigHash: record.currentConfigHash,
      desiredConfigHash: record.desiredConfigHash,
      actualConfigHash: record.actualConfigHash,
      expectedProductTimestamp: record.expectedProductTimestamp,
    },
    state
      ? wrapManufacturingState(state, "manufacturing")
      : {
          verificationError: record.verificationError
            ? wrapUnknownExternal(
                record.verificationError,
                "verificationError"
              )
            : undefined,
          error: record.error ? wrapUnknownExternal(record.error, "error") : undefined,
          diff: record.diff ? wrapOperationalResult(record.diff, "diff") : undefined,
          verificationDiff: record.verificationDiff
            ? wrapOperationalResult(record.verificationDiff, "verificationDiff")
            : undefined,
          before: record.before
            ? wrapManufacturingState(record.before, "before")
            : undefined,
          desired: record.desired
            ? wrapManufacturingState(record.desired, "desired")
            : undefined,
          actual: record.actual
            ? wrapManufacturingState(record.actual, "actual")
            : undefined,
        }
  );
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

const GENERIC_SAFE_SET_ENTITIES: Record<
  string,
  { idField: string; resourceType: string }
> = {
  set_product: { idField: "productId", resourceType: "product" },
  set_sales_order: { idField: "salesOrderId", resourceType: "sales-order" },
  set_purchase_order: {
    idField: "purchaseOrderId",
    resourceType: "purchase-order",
  },
  set_purchase_order_receipts: {
    idField: "purchaseOrderId",
    resourceType: "purchase-order-receipts",
  },
  set_customer: { idField: "customerId", resourceType: "customer" },
  set_vendor: { idField: "vendorId", resourceType: "vendor" },
  set_stock_adjustment: {
    idField: "stockAdjustmentId",
    resourceType: "stock-adjustment",
  },
  set_stock_transfer: {
    idField: "stockTransferId",
    resourceType: "stock-transfer",
  },
  set_stock_count: { idField: "stockCountId", resourceType: "stock-count" },
  set_manufacturing_order: {
    idField: "manufacturingOrderId",
    resourceType: "manufacturing-order",
  },
  set_taxing_scheme: {
    idField: "taxingSchemeId",
    resourceType: "taxing-scheme",
  },
  set_webhook: { idField: "webhookId", resourceType: "webhook" },
  remove_webhook: { idField: "webhookId", resourceType: "webhook" },
};

const GENERIC_SAFE_SET_VOLATILE_REQUEST_FIELDS = new Set([
  "dryRun",
  "previewToken",
  "idempotencyKey",
  "expectedSemanticHash",
  "expectedWriteShapeHash",
  "expectedEntityTimestamp",
  "expectedDesiredHash",
  "confirmation",
  "operationId",
]);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Generic safe-set review payload contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new Error(
    `Generic safe-set review payload contains unsupported ${typeof value}`
  );
}

function normalizedGenericSafeSetPayload(
  request: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(
      ([key, value]) =>
        !GENERIC_SAFE_SET_VOLATILE_REQUEST_FIELDS.has(key) &&
        value !== undefined
    )
  );
}

type GenericSafeSetReviewProof =
  | {
      applyEnabled: true;
      confirmationHash: string;
      confirmationScope: Record<string, unknown>;
    }
  | {
      applyEnabled: false;
      reason: string;
    };

function genericSafeSetReviewProof(
  tool: string,
  request: Record<string, unknown>,
  preview: MutationResult,
  tags: string[]
): GenericSafeSetReviewProof {
  const entity = GENERIC_SAFE_SET_ENTITIES[tool];
  if (!entity) {
    return {
      applyEnabled: false,
      reason: `no pinned confirmation scope is registered for ${tool}`,
    };
  }

  const entityIdValue = request[entity.idField];
  const entityId =
    typeof entityIdValue === "string" && entityIdValue.length > 0
      ? entityIdValue
      : null;
  const previewResourceId =
    typeof preview.resourceId === "string" && preview.resourceId.length > 0
      ? preview.resourceId
      : null;
  if (
    entityId !== null &&
    previewResourceId !== null &&
    previewResourceId !== entityId
  ) {
    return {
      applyEnabled: false,
      reason: `preview resourceId does not match ${entity.idField}`,
    };
  }
  const scopedEntityId = entityId ?? previewResourceId;
  if (scopedEntityId === null) {
    return {
      applyEnabled: false,
      reason: `preview did not prove an exact ${entity.idField} scope`,
    };
  }

  const isCreate = entityId === null;
  if (
    isCreate
    && (
      typeof preview.previewToken !== "string"
      || preview.previewToken.length === 0
      || typeof preview.idempotencyKey !== "string"
      || preview.idempotencyKey.length === 0
    )
  ) {
    return {
      applyEnabled: false,
      reason: "id-less create preview did not return a reusable preview token and idempotency key",
    };
  }
  const sourceRevisionIsComplete = isCreate
    ? preview.currentSemanticHash == null
      && preview.currentWriteShapeHash == null
      && preview.entityTimestamp == null
    : SHA256_HEX.test(String(preview.currentSemanticHash ?? ""))
      && SHA256_HEX.test(String(preview.currentWriteShapeHash ?? ""))
      && typeof preview.entityTimestamp === "string"
      && preview.entityTimestamp.length > 0;
  if (!sourceRevisionIsComplete || !SHA256_HEX.test(String(preview.desiredHash ?? ""))) {
    return {
      applyEnabled: false,
      reason:
        "preview did not prove current semantic/write-shape hashes, entity timestamp, and desired hash",
    };
  }

  if (preview.applyEnabled === false) {
    return {
      applyEnabled: false,
      reason: "MCP preview reports that apply is disabled for this operation",
    };
  }

  const mode =
    typeof request.mode === "string"
      ? request.mode
      : typeof request.action === "string"
        ? request.action
        : tool === "remove_webhook"
          ? "remove"
          : "unspecified";
  const serverScope =
    preview.confirmationScope && typeof preview.confirmationScope === "object"
      ? preview.confirmationScope
      : null;
  if (
    serverScope &&
    ((typeof serverScope.operation === "string" &&
      serverScope.operation !== tool) ||
      (serverScope.resourceId !== undefined &&
        serverScope.resourceId !== null &&
        serverScope.resourceId !== scopedEntityId) ||
      (typeof serverScope.mode === "string" && serverScope.mode !== mode))
  ) {
    return {
      applyEnabled: false,
      reason: "MCP confirmation scope conflicts with the requested operation",
    };
  }

  const confirmationScope = {
    schemaVersion: "generic-safe-set-review/v1",
    operation: tool,
    entity: {
      resourceType: entity.resourceType,
      idField: entity.idField,
      resourceId: scopedEntityId,
    },
    scope: {
      mode,
      invalidationTags: [...new Set(tags)].sort(),
      serverScope,
    },
    normalizedPayload: normalizedGenericSafeSetPayload(request),
    sourceRevision: {
      currentSemanticHash: preview.currentSemanticHash ?? null,
      currentWriteShapeHash: preview.currentWriteShapeHash ?? null,
      entityTimestamp: preview.entityTimestamp ?? null,
      desiredHash: preview.desiredHash,
    },
  };
  const confirmationHash = createHash("sha256")
    .update(canonicalJson(confirmationScope))
    .digest("hex");
  return { applyEnabled: true, confirmationHash, confirmationScope };
}

async function runConfirmedSafeSet(options: {
  command: string;
  tool: string;
  request: Record<string, unknown>;
  apply: boolean;
  confirmPreviewHash?: string;
  confirmPreviewToken?: string;
  confirmIdempotencyKey?: string;
  tags: string[];
  client: InFlowMCPClient;
  globals: GlobalFlags;
}) {
  const entity = GENERIC_SAFE_SET_ENTITIES[options.tool];
  const isIdlessCreate = entity !== undefined && options.request[entity.idField] === undefined;
  if (
    options.apply
    && isIdlessCreate
    && (!options.confirmPreviewToken || !options.confirmIdempotencyKey)
  ) {
    throw new Error(
      "USER_CONFIRMATION_REQUIRED: id-less creates require --confirm-preview-token and " +
        "--confirm-idempotency-key from the reviewed preview"
    );
  }
  const previewRequest = {
    ...options.request,
    ...(options.confirmPreviewToken ? { previewToken: options.confirmPreviewToken } : {}),
    ...(options.confirmIdempotencyKey ? { idempotencyKey: options.confirmIdempotencyKey } : {}),
  };
  const preview = await options.client.safeSet(
    options.tool,
    previewRequest,
    false,
    options.tags
  );
  const proof = genericSafeSetReviewProof(
    options.tool,
    options.request,
    preview,
    options.tags
  );
  const previewForOutput =
    proof.applyEnabled === true
      ? {
          ...preview,
          applyEnabled: true,
          confirmationScope: proof.confirmationScope,
          confirmationHash: proof.confirmationHash,
          confirmationRerun: {
            apply: true,
            confirm: true,
            confirmPreviewHash: proof.confirmationHash,
            ...(preview.previewToken
              ? { confirmPreviewToken: preview.previewToken }
              : {}),
            ...(preview.idempotencyKey
              ? { confirmIdempotencyKey: preview.idempotencyKey }
              : {}),
          },
        }
      : {
          ...preview,
          applyEnabled: false,
          confirmationUnavailableReason: proof.reason,
          migrationGuidance:
            "Use preview-only mode until this operation returns complete source-revision proof.",
        };

  if (!options.apply) {
    return buildOperationalSafeOutput(options.command, previewForOutput);
  }
  if (options.globals.confirm !== true) {
    throw new Error(
      "USER_CONFIRMATION_REQUIRED: pass --confirm after reviewing the prior preview"
    );
  }
  if (
    typeof options.confirmPreviewHash !== "string" ||
    !SHA256_HEX.test(options.confirmPreviewHash)
  ) {
    throw new Error(
      "USER_CONFIRMATION_REQUIRED: pass --confirm-preview-hash with the full lowercase 64-character hash from the reviewed preview"
    );
  }
  if (!proof.applyEnabled) {
    throw new Error(
      `GENERIC_SAFE_SET_APPLY_DISABLED: ${proof.reason}. Preview remains available; migrate to an operation with exact confirmation scope and source-revision proof.`
    );
  }
  if (options.confirmPreviewHash !== proof.confirmationHash) {
    throw new Error(
      "USER_CONFIRMATION_SCOPE_MISMATCH: the supplied hash does not match the fresh preview; state or payload changed, so review and confirm the new hash"
    );
  }

  const applied = await options.client.safeSet(
    options.tool,
    options.request,
    true,
    options.tags,
    preview
  );
  return buildOperationalSafeOutput(options.command, applied);
}

function confirmationFromFreshPreview(
  preview: unknown,
  suppliedHash: unknown,
  globals: GlobalFlags
): ExplicitMutationConfirmation {
  const record = asRecord(preview);
  if (globals.confirm !== true) {
    throw new Error(
      "USER_CONFIRMATION_REQUIRED: pass --confirm after reviewing the fresh preview"
    );
  }
  if (typeof suppliedHash !== "string" || !SHA256_HEX.test(suppliedHash)) {
    throw new Error(
      "USER_CONFIRMATION_REQUIRED: pass --confirm-preview-hash with the full lowercase 64-character hash from the reviewed preview"
    );
  }
  if (
    typeof record.confirmationHash !== "string" ||
    !SHA256_HEX.test(record.confirmationHash) ||
    !record.confirmationScope ||
    typeof record.confirmationScope !== "object"
  ) {
    throw new Error(
      "INVALID_PREVIEW_CONFIRMATION: MCP preview did not return a valid confirmation scope and hash"
    );
  }
  if (suppliedHash !== record.confirmationHash) {
    throw new Error(
      "USER_CONFIRMATION_SCOPE_MISMATCH: the supplied hash does not match the fresh preview; review and confirm the new hash"
    );
  }
  return {
    scope: record.confirmationScope as ExplicitMutationConfirmation["scope"],
    confirmationHash: suppliedHash,
  };
}

function wrapProductGroup(rawGroup: unknown, pathPrefix: string) {
  const group = asRecord(rawGroup);
  const options = Array.isArray(group.options) ? group.options : [];
  const variants = Array.isArray(group.productVariants)
    ? group.productVariants
    : [];
  return {
    productGroupId: group.productGroupId,
    isActive: group.isActive,
    timestamp: group.timestamp,
    name: wrapUntrustedField(`${pathPrefix}.name`, group.name ?? "", {
      maxChars: TRUNCATION_DEFAULTS.subject,
    }),
    description: wrapUntrustedField(
      `${pathPrefix}.description`,
      group.description ?? "",
      { maxChars: TRUNCATION_DEFAULTS.body }
    ),
    options: options.map((rawOption, optionIndex) => {
      const option = asRecord(rawOption);
      const values = Array.isArray(option.optionValues)
        ? option.optionValues
        : [];
      return {
        productGroupOptionId: option.productGroupOptionId,
        lineNum: option.lineNum,
        name: wrapUntrustedField(
          `${pathPrefix}.options[${optionIndex}].name`,
          option.name ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
        optionValues: values.map((rawValue, valueIndex) => {
          const value = asRecord(rawValue);
          return {
            productGroupOptionValueId: value.productGroupOptionValueId,
            lineNum: value.lineNum,
            name: wrapUntrustedField(
              `${pathPrefix}.options[${optionIndex}].optionValues[${valueIndex}].name`,
              value.name ?? "",
              { maxChars: TRUNCATION_DEFAULTS.subject }
            ),
          };
        }),
      };
    }),
    productVariants: variants.map((rawVariant, variantIndex) => {
      const variant = asRecord(rawVariant);
      return {
        productVariantId: variant.productVariantId,
        productId: variant.productId,
        productSku: variant.productSku,
        productIsActive: variant.productIsActive,
        variantOption: wrapUnknownExternal(
          variant.variantOption,
          `${pathPrefix}.productVariants[${variantIndex}].variantOption`
        ),
        productName: wrapUntrustedField(
          `${pathPrefix}.productVariants[${variantIndex}].productName`,
          variant.productName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        ),
      };
    }),
  };
}

export function buildStockNoPhotoSafeOutput(report: StockNoPhotoReport) {
  return buildSafeOutput(
    {
      command: "list-stock-no-photo",
      generatedAt: report.generatedAt,
      complete: report.complete,
      stableSnapshotAttempts: report.stableSnapshotAttempts,
      completedStockCountsScanned: report.completedStockCountsScanned,
      countSheetsScanned: report.countSheetsScanned,
      countLinesScanned: report.countLinesScanned,
      uniqueCountedProducts: report.uniqueCountedProducts,
      productsWithoutPhoto: report.productsWithoutPhoto.length,
      definition: "product appeared on at least one completed, non-cancelled physical count sheet within a completed, non-cancelled stock count and currently has neither gallery images nor a default image",
    },
    {
      products: report.productsWithoutPhoto.map((product, index) => ({
        productId: product.productId,
        isActive: product.isActive,
        stockCountOccurrences: product.stockCountOccurrences,
        firstCountDate: product.firstCountDate,
        lastCountDate: product.lastCountDate,
        sku: wrapUntrustedField(`products[${index}].sku`, product.sku, { maxChars: 1000 }),
        firstCountNumber: wrapUntrustedField(
          `products[${index}].firstCountNumber`,
          product.firstCountNumber,
          { maxChars: 1000 },
        ),
        lastCountNumber: wrapUntrustedField(
          `products[${index}].lastCountNumber`,
          product.lastCountNumber,
          { maxChars: 1000 },
        ),
        name: wrapUntrustedField(
          `products[${index}].name`,
          product.name,
          { maxChars: 1000 },
        ),
      })),
    },
  );
}

export const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools",
    { sideEffect: "read" }
  ),

  "list-products": createCommand(
    z.object({
      limit: cliTypes
        .int(1, 250)
        .optional()
        .describe("Max records to return (above 100 is fetched as 100-record provider pages)"),
      skip: cliTypes.int(0).optional().describe("Records to skip (pagination)"),
      filter: z.string().optional().describe("OData filter"),
      categoryId: z.string().optional().describe("Category ID to filter by"),
      category: z.string().optional().describe("Category name to filter by"),
      include: z
        .string()
        .optional()
        .describe(
          "Related data to include (comma-separated). Use reorderSettings.location for per-location reorder thresholds; without it, reorderSource falls back to the legacy flat fields"
        ),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, filter, categoryId, category, include } = args as {
        limit?: number; skip?: number; filter?: string;
        categoryId?: string; category?: string; include?: string;
      };
      const raw = await client.listProducts({
        limit, skip, filter, categoryId, categoryName: category,
        include: parseIncludeList(include),
        includeCount: true,
      });

      const rawProducts = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedProducts = (Array.isArray(rawProducts) ? rawProducts : [rawProducts]).map((rawProduct, index) => {
        const product = asRecord(rawProduct);
        return {
          productId: product.productId,
          sku: product.sku,
          barcode: product.barcode,
          categoryId: product.categoryId,
          cost: product.cost,
          defaultPrice: product.defaultPrice,
          isActive: product.isActive,
          isSerialized: product.isSerialized,
          trackSerials: product.trackSerials,
          ...readWrappedReorderThresholds(product, `products[${index}]`),
          createdDate: product.createdDttm,
          modifiedDate: product.lastModifiedDateTime,
          timestamp: product.timestamp,
          ...wrapProduct(product, `products[${index}]`),
          name: wrapUntrustedField(`products[${index}].name`, product.name, { maxChars: 1000 }),
        };
      });

      return buildSafeOutput(
        {
          command: "list-products",
          count: wrappedProducts.length,
          returnedCount: raw.pagination.returnedCount,
          totalCount: raw.pagination.totalCount,
          totalCountKnown: raw.pagination.totalCountKnown,
          complete: raw.pagination.complete,
          hasMore: raw.pagination.hasMore,
          nextSkip: raw.pagination.nextSkip,
          startSkip: raw.pagination.startSkip,
          requestedLimit: raw.pagination.requestedLimit,
          paginationMode: raw.pagination.paginationMode,
        },
        { products: wrappedProducts }
      );
    },
    "List products with optional category filtering",
    { sideEffect: "read" }
  ),

  "list-recent-products": createCommand(
    z.object({
      since: z
        .string()
        .min(1)
        .describe("Inclusive ISO 8601 creation-time lower bound with an explicit UTC offset"),
      before: z
        .string()
        .min(1)
        .describe("Exclusive ISO 8601 creation-time upper bound with an explicit UTC offset"),
      activeOnly: cliTypes
        .bool()
        .default(true)
        .describe("Include only products whose inFlow isActive flag is true"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { since, before, activeOnly } = args as {
        since: string;
        before: string;
        activeOnly: boolean;
      };
      const raw = await client.listRecentProducts({ since, before, activeOnly });
      const products = raw.data.map((rawProduct, index) => {
        const product = asRecord(rawProduct);
        const productBarcodes = Array.isArray(product.productBarcodes)
          ? product.productBarcodes.map((rawBarcode) => {
              const productBarcode = asRecord(rawBarcode);
              return {
                productBarcodeId: productBarcode.productBarcodeId,
                barcode: productBarcode.barcode,
                lineNum: productBarcode.lineNum,
                uomId: productBarcode.uomId,
              };
            })
          : undefined;
        return {
          productId: product.productId,
          sku: product.sku,
          barcode: product.barcode,
          productBarcodes,
          categoryId: product.categoryId,
          cost: product.cost,
          defaultPrice: product.defaultPrice,
          isActive: product.isActive,
          isSerialized: product.isSerialized,
          trackSerials: product.trackSerials,
          createdDate: product.createdDate,
          modifiedDate: product.modifiedDate,
          timestamp: product.timestamp,
          ...wrapProduct(product, `products[${index}]`),
          name: wrapUntrustedField(`products[${index}].name`, product.name, { maxChars: 1000 }),
        };
      });
      const activeProductNames = raw.activeProductNames.map((product, index) => ({
        productId: product.productId,
        isActive: product.isActive,
        name: wrapUntrustedField(`activeProductNames[${index}].name`, product.name, { maxChars: 1000 }),
      }));

      return buildSafeOutput(
        {
          command: "list-recent-products",
          since: raw.since,
          before: raw.before,
          activeOnly: raw.activeOnly,
          count: products.length,
          complete: raw.complete,
          cacheBypassed: raw.cacheBypassed,
          providerPageSize: raw.providerPageSize,
          requiredConsecutiveStableScans: raw.requiredConsecutiveStableScans,
          scanAttempts: raw.scanAttempts,
          pageCounts: raw.pageCounts,
          recordsFetchedPerScan: raw.recordsFetchedPerScan,
          uniqueProductsPerScan: raw.uniqueProductsPerScan,
          duplicateRecordsPerScan: raw.duplicateRecordsPerScan,
          finalUniqueProductsScanned: raw.finalUniqueProductsScanned,
          inactiveProductsExcluded: raw.inactiveProductsExcluded,
          outOfWindowProductsExcluded: raw.outOfWindowProductsExcluded,
          invalidIsActiveCount: raw.invalidIsActiveCount,
          invalidCreatedDateCount: raw.invalidCreatedDateCount,
          nameCatalogueComplete: raw.nameCatalogueComplete,
          invalidNameCount: raw.invalidNameCount,
          nameCatalogueCount: activeProductNames.length,
          nameCatalogueOrdering: "productId-ascending",
          ordering: "createdDate-ascending-then-productId",
        },
        { products, activeProductNames }
      );
    },
    "List a stable, exhaustive snapshot of recently created inFlow products",
    { sideEffect: "read" }
  ),

  "list-product-names": createCommand(
    z.object({
      activeOnly: cliTypes
        .bool()
        .default(true)
        .describe("Include only products whose inFlow isActive flag is true"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { activeOnly } = args as { activeOnly: boolean };
      const raw = await client.listProductNames({ activeOnly });
      const products = raw.data.map((product, index) => ({
        productId: product.productId,
        isActive: product.isActive,
        name: wrapUntrustedField(
          `products[${index}].name`,
          product.name,
          { maxChars: 1000 }
        ),
      }));
      return buildSafeOutput(
        {
          command: "list-product-names",
          activeOnly: raw.activeOnly,
          count: products.length,
          complete: raw.complete,
          cacheBypassed: raw.cacheBypassed,
          providerPageSize: raw.providerPageSize,
          requiredConsecutiveStableScans: raw.requiredConsecutiveStableScans,
          scanAttempts: raw.scanAttempts,
          pageCounts: raw.pageCounts,
          recordsFetchedPerScan: raw.recordsFetchedPerScan,
          uniqueProductsPerScan: raw.uniqueProductsPerScan,
          duplicateRecordsPerScan: raw.duplicateRecordsPerScan,
          finalUniqueProductsScanned: raw.finalUniqueProductsScanned,
          inactiveProductsExcluded: raw.inactiveProductsExcluded,
          invalidIsActiveCount: raw.invalidIsActiveCount,
          invalidNameCount: raw.invalidNameCount,
          ordering: "productId-ascending",
        },
        { products }
      );
    },
    "List a stable, exhaustive product ID/name catalogue for exact-name checks",
    { sideEffect: "read" }
  ),

  "get-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID"),
      include: z
        .string()
        .optional()
        .describe(
          "Related data to include (comma-separated; use productBarcodes for all barcodes)"
        ),
    }),
    async (args, client: InFlowMCPClient, globals: GlobalFlags) => {
      const { id, include } = args as {
        id: string;
        include?: string;
      };
      const includes = parseIncludeList(include);
      if (globals.noCache) client.disableCache();
      const product = await client.getProduct(id, { include: includes });

      const record = asRecord(product);
      const productBarcodes = Array.isArray(record.productBarcodes)
        ? record.productBarcodes.map((rawBarcode) => {
            const productBarcode = asRecord(rawBarcode);
            return {
              productBarcodeId: productBarcode.productBarcodeId,
              barcode: productBarcode.barcode,
              lineNum: productBarcode.lineNum,
              uomId: productBarcode.uomId,
            };
          })
        : undefined;
      if (typeof record.name === "string" && record.name.length > 1000) {
        throw new Error(
          `get-product: product ${String(record.productId ?? id)} has a name longer than 1000 characters; ` +
            "refusing to truncate exact label state"
        );
      }
      return buildSafeOutput(
        {
          command: "get-product",
          productId: record.productId,
          sku: record.sku,
          barcode: record.barcode,
          categoryId: record.categoryId,
          cost: record.cost,
          defaultPrice: record.defaultPrice,
          isActive: record.isActive,
          isSerialized: record.isSerialized,
          trackSerials: record.trackSerials,
          ...readWrappedReorderThresholds(record, "product"),
          createdDate: record.createdDttm,
          modifiedDate: record.lastModifiedDateTime,
          timestamp: record.timestamp,
          included: includes,
          cacheBypassed: globals.noCache,
          productBarcodes,
        },
        {
          ...wrapProduct(record, "product"),
          name: wrapUntrustedField("product.name", record.name, { maxChars: 1000 }),
        }
      );
    },
    "Get product details by ID; use --include productBarcodes for all barcodes, or --include reorderSettings.location for per-location reorder thresholds",
    { sideEffect: "read" }
  ),

  "search-products": createCommand(
    z.object({ query: z.string().min(1).describe("Search term") }),
    async (args, client: InFlowMCPClient, globals: GlobalFlags) => {
      const { query } = args as { query: string };
      if (globals.noCache) client.disableCache();
      const raw = await client.searchProducts(query);

      const rawProducts = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedProducts = (Array.isArray(rawProducts) ? rawProducts : [rawProducts]).map((rawProduct, index) => {
        const product = asRecord(rawProduct);
        return {
          productId: product.productId,
          sku: product.sku,
          barcode: product.barcode,
          categoryId: product.categoryId,
          cost: product.cost,
          defaultPrice: product.defaultPrice,
          isActive: product.isActive,
          isSerialized: product.isSerialized,
          trackSerials: product.trackSerials,
          createdDate: product.createdDttm,
          modifiedDate: product.lastModifiedDateTime,
          ...wrapProduct(product, `products[${index}]`),
        };
      });

      return buildSafeOutput(
        {
          command: "search-products",
          query,
          cacheBypassed: globals.noCache,
          count: wrappedProducts.length,
        },
        { products: wrappedProducts }
      );
    },
    "Search products by name/SKU",
    { sideEffect: "read" }
  ),

  "get-bom": createCommand(
    z.object({ id: z.string().min(1).describe("Product ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      const bom = await client.getBillOfMaterials(id);
      return buildManufacturingSafeOutput(bom, "get-bom");
    },
    "Get enriched BOM, operation templates, settings, and concurrency metadata",
    { sideEffect: "read" }
  ),

  "get-boms": createCommand(
    z.object({
      productIds: z.string().min(1).describe("2-25 comma-separated product IDs"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { productIds: rawProductIds } = args as {
        productIds: string;
      };
      const productIds = parseProductIds(rawProductIds);
      const result = await client.getBillsOfMaterials(productIds);
      return buildSafeOutput(
        {
          command: "get-boms",
          status: result.status,
          complete: result.complete,
          requestedProductCount: result.requestedProductCount,
          succeededProductCount: result.succeededProductCount,
          failedProductCount: result.failedProductCount,
          concurrency: result.concurrency,
          requestIntervalMs: result.requestIntervalMs,
          maxAttemptsPerProduct: result.maxAttemptsPerProduct,
        },
        {
          results: result.results.map((item, index) =>
            item.status === "ok"
              ? {
                  productId: item.productId,
                  status: item.status,
                  bom: wrapManufacturingState(
                    asRecord(item.bom),
                    `results[${index}].bom`
                  ),
                }
              : {
                  productId: item.productId,
                  status: item.status,
                  error: wrapUntrustedField(
                    `results[${index}].error`,
                    item.error,
                    { maxChars: TRUNCATION_DEFAULTS.body }
                  ),
                }
          ),
        }
      );
    },
    "Get 2-25 BOMs serially with provider-safe pacing and per-product status",
    { sideEffect: "read" }
  ),

  "compare-boms": createCommand(
    z.object({
      productIds: z.string().min(1).describe("2-25 comma-separated product IDs"),
    }),
    async (args, client: InFlowMCPClient) => {
      const productIds = parseProductIds((args as { productIds: string }).productIds);
      const raw = asRecord(await client.compareProductBoms(productIds));
      const products = Array.isArray(raw.products) ? raw.products : [];
      const matrix = Array.isArray(raw.componentMatrix) ? raw.componentMatrix : [];
      return buildSafeOutput(
        {
          command: "compare-boms",
          complete: raw.complete,
          equivalent: raw.equivalent,
          productCount: products.length,
        },
        {
          products: products.map((rawProduct, index) => {
            const product = asRecord(rawProduct);
            return {
              productId: product.productId,
              productSku: wrapUntrustedField(
                `products[${index}].productSku`,
                product.productSku ?? "",
                { maxChars: TRUNCATION_DEFAULTS.displayName }
              ),
              configHash: product.configHash,
              settings: product.settings,
              productName: wrapUntrustedField(
                `products[${index}].productName`,
                product.productName ?? "",
                { maxChars: TRUNCATION_DEFAULTS.subject }
              ),
              productOperations: wrapManufacturingState(
                { productOperations: product.productOperations },
                `products[${index}]`
              ).productOperations,
              warnings: wrapManufacturingState(
                { warnings: product.warnings },
                `products[${index}]`
              ).warnings,
            };
          }),
          componentMatrix: matrix.map((rawRow, index) => {
            const row = asRecord(rawRow);
            return {
              childProductId: row.childProductId,
              childProductSku: wrapUntrustedField(
                `componentMatrix[${index}].childProductSku`,
                row.childProductSku ?? "",
                { maxChars: TRUNCATION_DEFAULTS.displayName }
              ),
              products: row.products,
              childProductName: wrapUntrustedField(
                `componentMatrix[${index}].childProductName`,
                row.childProductName ?? "",
                { maxChars: TRUNCATION_DEFAULTS.subject }
              ),
            };
          }),
          failures: (Array.isArray(raw.failures) ? raw.failures : []).map((rawFailure, index) => {
            const failure = asRecord(rawFailure);
            return {
              productId: failure.productId,
              message: wrapUntrustedField(
                `failures[${index}].message`,
                failure.message ?? "",
                { maxChars: TRUNCATION_DEFAULTS.body }
              ),
            };
          }),
        }
      );
    },
    "Compare BOMs, operation templates, and manufacturing settings",
    { sideEffect: "read" }
  ),

  "list-product-groups": createCommand(
    z.object({
      skip: cliTypes.int(0).optional(),
      limit: cliTypes.int(1, 100).optional(),
      sort: z.string().optional(),
      sortDesc: cliTypes.bool().optional(),
      includeCount: cliTypes.bool().optional(),
    }),
    async (args, client: InFlowMCPClient) => {
      const { skip, limit, sort, sortDesc, includeCount } = args as {
        skip?: number; limit?: number; sort?: string;
        sortDesc?: boolean; includeCount?: boolean;
      };
      const raw = asRecord(
        await client.listProductGroups({
          skip,
          count: limit,
          sort,
          sortDesc,
          includeCount,
        })
      );
      const groups = Array.isArray(raw.data) ? raw.data : [];
      return buildSafeOutput(
        {
          command: "list-product-groups",
          count: groups.length,
          totalCount: raw.totalCount,
        },
        {
          productGroups: groups.map((group, index) =>
            wrapProductGroup(group, `productGroups[${index}]`)
          ),
        }
      );
    },
    "List product groups, options, and attached variants",
    { sideEffect: "read" }
  ),

  "get-product-group": createCommand(
    z.object({ id: z.string().min(1).describe("Product group ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      const group = await client.getProductGroup(id);
      return buildSafeOutput(
        { command: "get-product-group", productGroupId: id },
        { productGroup: wrapProductGroup(group, "productGroup") }
      );
    },
    "Get one product group with options and variants",
    { sideEffect: "read" }
  ),

  "get-group-quantities": createCommand(
    z.object({
      productGroupId: z.string().min(1),
      locationId: z.string().min(1),
    }),
    async (args, client: InFlowMCPClient) => {
      const { productGroupId, locationId } = args as {
        productGroupId: string; locationId: string;
      };
      const raw = asRecord(
        await client.getProductGroupVariantQuantities(productGroupId, locationId)
      );
      const rows = Array.isArray(raw.data) ? raw.data : [];
      return buildSafeOutput(
        {
          command: "get-group-quantities",
          productGroupId,
          locationId,
          count: rows.length,
        },
        {
          quantities: rows.map((rawRow) => {
            const row = asRecord(rawRow);
            return {
              productId: row.productId,
              productVariantId: row.productVariantId,
              locationId: row.locationId,
              quantityOnHand: row.quantityOnHand,
              quantityAvailable: row.quantityAvailable,
              quantityBuildable: row.quantityBuildable,
            };
          }),
        }
      );
    },
    "Get variant quantities for a product group at one location",
    { sideEffect: "read" }
  ),

  "set-bom": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID"),
      mode: z.enum(["patch", "replace"]).optional(),
      components: z.string().optional().describe("JSON component array"),
      removeItemBomIds: z.string().optional().describe("JSON row-ID array"),
      operations: z.string().optional().describe("JSON product-operation array"),
      removeOperationIds: z.string().optional().describe("JSON operation-ID array"),
      autoAssemble: cliTypes.bool().optional(),
      includeQuantityBuildable: cliTypes.bool().optional(),
      allowInactiveComponents: cliTypes.bool().optional(),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe("Exact full confirmation hash from the reviewed preview"),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const values = args as Record<string, unknown>;
      const baseRequest = {
        productId: String(values.id),
        mode: (values.mode as "patch" | "replace" | undefined) ?? "patch",
        components: parseJsonArray(values.components, "--components") as never,
        removeItemBomIds: parseJsonArray(
          values.removeItemBomIds,
          "--removeItemBomIds"
        ) as string[] | undefined,
        productOperations: parseJsonArray(values.operations, "--operations") as never,
        removeProductOperationIds: parseJsonArray(
          values.removeOperationIds,
          "--removeOperationIds"
        ) as string[] | undefined,
        autoAssemble: values.autoAssemble as boolean | undefined,
        includeQuantityBuildable:
          values.includeQuantityBuildable as boolean | undefined,
        allowInactiveComponents:
          values.allowInactiveComponents as boolean | undefined,
      };
      const preview = await client.setProductManufacturingConfig({
        ...baseRequest,
        dryRun: true,
      });
      if (values.apply !== true) {
        return buildManufacturingSafeOutput(preview, "set-bom");
      }
      const previewRecord = asRecord(preview);
      const confirmation = confirmationFromFreshPreview(
        preview,
        values.confirmPreviewHash,
        globals
      );
      const applied = await client.setProductManufacturingConfig({
        ...baseRequest,
        operationId: String(previewRecord.operationId ?? ""),
        dryRun: false,
        previewToken: String(previewRecord.previewToken ?? ""),
        idempotencyKey: previewRecord.idempotencyKey as string | undefined,
        expectedSemanticHash: String(previewRecord.currentSemanticHash ?? previewRecord.currentConfigHash ?? ""),
        expectedWriteShapeHash: String(previewRecord.currentWriteShapeHash ?? ""),
        expectedEntityTimestamp: String(previewRecord.entityTimestamp ?? previewRecord.expectedProductTimestamp ?? ""),
        expectedDesiredHash: String(previewRecord.desiredHash ?? previewRecord.desiredConfigHash ?? ""),
        expectedConfigHash: String(previewRecord.currentConfigHash ?? ""),
        expectedProductTimestamp: String(
          previewRecord.expectedProductTimestamp ?? ""
        ),
        confirmation,
      });
      return buildManufacturingSafeOutput(applied, "set-bom");
    },
    "Preview or apply a BOM/config change with exact preview confirmation",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "mcp-status": createCommand(
    z.object({ probeApi: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => buildOperationalSafeOutput("mcp-status", await client.getMcpStatus((args as { probeApi?: boolean }).probeApi === true)),
    "Inspect inFlow MCP capabilities and safety gates",
    { sideEffect: "read" },
  ),

  "mutation-status": createCommand(
    z.object({ operationId: z.string().min(1), reconcile: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { operationId: string; reconcile?: boolean };
      return buildOperationalSafeOutput("mutation-status", await client.getMutationStatus(values.operationId, values.reconcile === true));
    },
    "Read or reconcile a durable mutation journal entry",
    { sideEffect: "read" },
  ),

  "list-operation-types": createCommand(
    z.object({ skip: cliTypes.int(0).optional(), limit: cliTypes.int(1, 100).optional(), isActive: cliTypes.bool().optional(), includeCount: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { skip?: number; limit?: number; isActive?: boolean; includeCount?: boolean };
      return buildOperationalSafeOutput("list-operation-types", await client.listOperationTypes({ skip: values.skip, count: values.limit, isActive: values.isActive, includeCount: values.includeCount }));
    },
    "List manufacturing operation types",
    { sideEffect: "read" },
  ),

  "get-operation-type": createCommand(
    z.object({ id: z.string().min(1) }),
    async (args, client: InFlowMCPClient) => buildOperationalSafeOutput("get-operation-type", await client.getOperationType((args as { id: string }).id)),
    "Get one manufacturing operation type",
    { sideEffect: "read" },
  ),

  "get-product-prices": createCommand(
    z.object({ id: z.string().min(1) }),
    async (args, client: InFlowMCPClient) => buildOperationalSafeOutput("get-product-prices", await client.getProductPrices((args as { id: string }).id)),
    "Get exact product price rows and pricing-scheme IDs",
    { sideEffect: "read" },
  ),

  "set-product-prices": createCommand(
    z.object({ id: z.string().min(1), mode: z.enum(["patch", "replace"]).default("patch"), prices: z.string().optional(), removeProductPriceIds: z.string().optional(), apply: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { id: string; mode: "patch" | "replace"; prices?: string; removeProductPriceIds?: string; apply?: boolean };
      const result = await client.setProductPrices({ productId: values.id, mode: values.mode, prices: parseJsonArray(values.prices, "--prices"), removeProductPriceIds: parseJsonArray(values.removeProductPriceIds, "--removeProductPriceIds") }, values.apply === true);
      return buildOperationalSafeOutput("set-product-prices", result);
    },
    "Preview or apply exact-ID product prices",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "copy-manufacturing-config": createCommand(
    z.object({
      sourceProductId: z.string().min(1),
      targetProductId: z.string().min(1),
      sections: z.string().optional(),
      mode: z.enum(["patch", "replace"]).default("replace"),
      allowInactiveComponents: cliTypes.bool().optional(),
      apply: cliTypes.bool().optional(),
      confirmPreviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const values = args as { sourceProductId: string; targetProductId: string; sections?: string; mode: "patch" | "replace"; allowInactiveComponents?: boolean; apply?: boolean; confirmPreviewHash?: string };
      const sections = values.sections?.split(",").map((value) => value.trim()).filter(Boolean);
      const baseRequest = {
        sourceProductId: values.sourceProductId,
        targetProductId: values.targetProductId,
        sections,
        mode: values.mode,
        allowInactiveComponents: values.allowInactiveComponents,
      };
      const preview = await client.copyProductManufacturingConfig({
        ...baseRequest,
        dryRun: true,
      });
      if (values.apply !== true) {
        return buildManufacturingSafeOutput(
          preview,
          "copy-manufacturing-config"
        );
      }
      const previewRecord = asRecord(preview);
      const sourceHashes = asRecord(previewRecord.sourceHashes);
      const confirmation = confirmationFromFreshPreview(
        preview,
        values.confirmPreviewHash,
        globals
      );
      const applied = await client.copyProductManufacturingConfig({
        ...baseRequest,
        operationId: previewRecord.operationId,
        dryRun: false,
        previewToken: previewRecord.previewToken,
        idempotencyKey: previewRecord.idempotencyKey,
        expectedSemanticHash: previewRecord.currentSemanticHash,
        expectedWriteShapeHash: previewRecord.currentWriteShapeHash,
        expectedEntityTimestamp: previewRecord.entityTimestamp,
        expectedDesiredHash: previewRecord.desiredHash,
        expectedSourceConfigHash: sourceHashes.sourceSemanticHash,
        expectedSourceWriteShapeHash: sourceHashes.sourceWriteShapeHash,
        confirmation,
      });
      return buildManufacturingSafeOutput(applied, "copy-manufacturing-config");
    },
    "Preview or copy manufacturing configuration with exact preview confirmation",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "audit-product-group": createCommand(
    z.object({ id: z.string().min(1), baselineProductId: z.string().optional(), locationId: z.string().optional(), includeInactive: cliTypes.bool().optional(), maxVariants: cliTypes.int(1, 500).optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { id: string; baselineProductId?: string; locationId?: string; includeInactive?: boolean; maxVariants?: number };
      return buildOperationalSafeOutput("audit-product-group", await client.auditProductGroupManufacturing({ productGroupId: values.id, baselineProductId: values.baselineProductId, locationId: values.locationId, includeInactive: values.includeInactive, maxVariants: values.maxVariants }));
    },
    "Audit a product group's option matrix and manufacturing consistency",
    { sideEffect: "read" },
  ),

  "calculate-bom-requirements": createCommand(
    z.object({ id: z.string().min(1), buildQuantity: z.string().min(1), locationId: z.string().min(1), mode: z.enum(["direct", "leaf", "net"]).default("net"), stockBasis: z.enum(["available", "onHand"]).default("available"), maxDepth: cliTypes.int(1, 50).optional(), maxProducts: cliTypes.int(1, 500).optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { id: string; buildQuantity: string; locationId: string; mode: string; stockBasis: string; maxDepth?: number; maxProducts?: number };
      return buildOperationalSafeOutput("calculate-bom-requirements", await client.calculateBomRequirements({ productId: values.id, buildQuantity: values.buildQuantity, locationId: values.locationId, mode: values.mode, stockBasis: values.stockBasis, maxDepth: values.maxDepth, maxProducts: values.maxProducts }));
    },
    "Calculate exact direct, leaf, or net material requirements",
    { sideEffect: "read" },
  ),

  "get-mo-trace": createCommand(
    z.object({ id: z.string().min(1) }),
    async (args, client: InFlowMCPClient) => buildOperationalSafeOutput("get-mo-trace", await client.getManufacturingOrderTrace((args as { id: string }).id)),
    "Trace manufacturing-order lines, picks, matchings, and serial number anomalies",
    { sideEffect: "read" },
  ),

  "reconcile-mo-serials": createCommand(
    z.object({ id: z.string().min(1), mode: z.enum(["patch", "replace"]).default("patch"), outputLines: z.string().optional(), inputPicks: z.string().optional(), apply: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { id: string; mode: "patch" | "replace"; outputLines?: string; inputPicks?: string; apply?: boolean };
      return buildOperationalSafeOutput("reconcile-mo-serials", await client.reconcileManufacturingOrderSerials({ manufacturingOrderId: values.id, mode: values.mode, outputLines: parseJsonArray(values.outputLines, "--outputLines"), inputPicks: parseJsonArray(values.inputPicks, "--inputPicks") }, values.apply === true));
    },
    "Preview or apply exact-ID manufacturing-order serial number reconciliation",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "set-product-group-config": createCommand(
    z.object({ id: z.string().min(1), mode: z.enum(["patch", "replace"]).default("patch"), options: z.string().optional(), variants: z.string().optional(), removeOptionIds: z.string().optional(), removeOptionValueIds: z.string().optional(), removeVariantIds: z.string().optional(), apply: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as Record<string, unknown>;
      return buildOperationalSafeOutput("set-product-group-config", await client.setProductGroupConfig({ productGroupId: String(values.id), mode: values.mode, options: parseJsonArray(values.options, "--options"), variants: parseJsonArray(values.variants, "--variants"), removeOptionIds: parseJsonArray(values.removeOptionIds, "--removeOptionIds"), removeOptionValueIds: parseJsonArray(values.removeOptionValueIds, "--removeOptionValueIds"), removeVariantIds: parseJsonArray(values.removeVariantIds, "--removeVariantIds") }, values.apply === true));
    },
    "Preview or apply exact-ID product-group configuration",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "create-product-group-variants": createCommand(
    z.object({ id: z.string().min(1), variants: z.string().min(1), apply: cliTypes.bool().optional() }),
    async (args, client: InFlowMCPClient) => {
      const values = args as { id: string; variants: string; apply?: boolean };
      return buildOperationalSafeOutput("create-product-group-variants", await client.createProductGroupVariants({ productGroupId: values.id, variants: parseJsonArray(values.variants, "--variants") }, values.apply === true));
    },
    "Preview or apply a create-and-attach variant saga",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "set-product": createCommand(safeSetSchema, makeSafeSetHandler("set_product", "productId", (id) => [`product:${id ?? "new"}`]), "Preview or apply set_product", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-sales-order": createCommand(safeSetSchema, makeSafeSetHandler("set_sales_order", "salesOrderId", (id) => [`sales-order:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_sales_order", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-purchase-order": createCommand(safeSetSchema, makeSafeSetHandler("set_purchase_order", "purchaseOrderId", (id) => [`purchase-order:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_purchase_order", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-customer": createCommand(safeSetSchema, makeSafeSetHandler("set_customer", "customerId", (id) => [`customer:${id ?? "new"}`]), "Preview or apply set_customer", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-vendor": createCommand(safeSetSchema, makeSafeSetHandler("set_vendor", "vendorId", (id) => [`vendor:${id ?? "new"}`]), "Preview or apply set_vendor", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-stock-adjustment": createCommand(safeSetSchema, makeSafeSetHandler("set_stock_adjustment", "stockAdjustmentId", (id) => [`stock-adjustment:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_stock_adjustment", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-stock-transfer": createCommand(safeSetSchema, makeSafeSetHandler("set_stock_transfer", "stockTransferId", (id) => [`stock-transfer:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_stock_transfer", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-stock-count": createCommand(safeSetSchema, makeSafeSetHandler("set_stock_count", "stockCountId", (id) => [`stock-count:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_stock_count", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-manufacturing-order": createCommand(safeSetSchema, makeSafeSetHandler("set_manufacturing_order", "manufacturingOrderId", (id) => [`mo:${id ?? "new"}`, "inventory:stock"]), "Preview or apply set_manufacturing_order", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-taxing-scheme": createCommand(safeSetSchema, makeSafeSetHandler("set_taxing_scheme", "taxingSchemeId", (id) => [`taxing-scheme:${id ?? "new"}`]), "Preview or apply set_taxing_scheme", { sideEffect: "write", dryRunSupported: true, idempotent: true }),
  "set-webhook": createCommand(safeSetSchema, makeSafeSetHandler("set_webhook", "webhookId", (id) => [`webhook:${id ?? "new"}`]), "Preview or apply set_webhook", { sideEffect: "write", dryRunSupported: true, idempotent: true }),

  "set-po-receipts": createCommand(
    z.object({
      id: z.string().min(1),
      action: z.enum(["receive", "unreceive"]),
      receiveLines: z.string().min(1),
      apply: cliTypes.bool().optional(),
      confirmPreviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const values = args as {
        id: string;
        action: string;
        receiveLines: string;
        apply?: boolean;
        confirmPreviewHash?: string;
      };
      return runConfirmedSafeSet({
        command: "set-po-receipts",
        tool: "set_purchase_order_receipts",
        request: {
          purchaseOrderId: values.id,
          action: values.action,
          receiveLines: parseJsonArray(values.receiveLines, "--receiveLines"),
        },
        apply: values.apply === true,
        confirmPreviewHash: values.confirmPreviewHash,
        tags: [`purchase-order:${values.id}`, "inventory:stock"],
        client,
        globals,
      });
    },
    "Preview or apply purchase-order receipt changes",
    { sideEffect: "write", dryRunSupported: true, idempotent: true },
  ),

  "remove-webhook": createCommand(
    z.object({
      id: z.string().min(1),
      apply: cliTypes.bool().optional(),
      confirmPreviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const values = args as {
        id: string;
        apply?: boolean;
        confirmPreviewHash?: string;
      };
      if (!REMOVE_WEBHOOK_STATIC_SUPPORT) {
        throw new Error(
          "OPERATION_UNSUPPORTED: remove_webhook is statically disabled until an approved release canary proves conclusive delete verification"
        );
      }
      return runConfirmedSafeSet({
        command: "remove-webhook",
        tool: "remove_webhook",
        request: { webhookId: values.id },
        apply: values.apply === true,
        confirmPreviewHash: values.confirmPreviewHash,
        tags: [`webhook:${values.id}`],
        client,
        globals,
      });
    },
    "Webhook removal (statically disabled pending approved release canary)",
    { sideEffect: "destructive", dryRunSupported: true, idempotent: true },
  ),

  "list-categories": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => {
      const raw = await client.listCategories();

      const rawCategories = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedCategories = (Array.isArray(rawCategories) ? rawCategories : [rawCategories]).map(
        (rawCategory, index) => {
          const category = asRecord(rawCategory);
          return {
            categoryId: category.categoryId,
            parentCategoryId: category.parentCategoryId,
            ...wrapCategory(category, `categories[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-categories",
          count: wrappedCategories.length,
          totalCount: raw?.totalCount,
        },
        { categories: wrappedCategories }
      );
    },
    "List all product categories",
    { sideEffect: "read" }
  ),

  "get-stock-levels": createCommand(
    z.object({ productId: z.string().optional().describe("Product ID to filter by") }),
    async (args, client: InFlowMCPClient) => {
      const { productId } = args as { productId?: string };
      const summary = await client.getStockLevels(productId);

      const summaryRecord = asRecord(summary);
      const locationSummaries = Array.isArray(summaryRecord.locationSummaries)
        ? (summaryRecord.locationSummaries as unknown[])
        : [];

      const wrappedLocationSummaries = locationSummaries.map((rawLocSummary, locIndex) => {
        const locSummary = asRecord(rawLocSummary);
        const sublocationSummaries = Array.isArray(locSummary.sublocationSummaries)
          ? (locSummary.sublocationSummaries as unknown[])
          : [];

        return {
          locationId: locSummary.locationId,
          quantityOnHand: locSummary.quantityOnHand,
          quantityAvailable: locSummary.quantityAvailable,
          locationName: wrapUntrustedField(
            `locationSummaries[${locIndex}].locationName`,
            locSummary.locationName ?? "",
            { maxChars: TRUNCATION_DEFAULTS.displayName }
          ),
          sublocationSummaries: sublocationSummaries.map((rawSubloc, subIndex) => {
            const subloc = asRecord(rawSubloc);
            return {
              quantityOnHand: subloc.quantityOnHand,
              sublocation: wrapUntrustedField(
                `locationSummaries[${locIndex}].sublocationSummaries[${subIndex}].sublocation`,
                subloc.sublocation ?? "",
                { maxChars: TRUNCATION_DEFAULTS.displayName }
              ),
            };
          }),
        };
      });

      return buildSafeOutput(
        {
          command: "get-stock-levels",
          productId: summaryRecord.productId ?? productId,
          quantityOnHand: summaryRecord.quantityOnHand,
          quantityAvailable: summaryRecord.quantityAvailable,
          quantityOnOrder: summaryRecord.quantityOnOrder,
          quantityAllocated: summaryRecord.quantityAllocated,
        },
        { locationSummaries: wrappedLocationSummaries }
      );
    },
    "Get current stock quantities",
    { sideEffect: "read" }
  ),

  "get-stock-by-location": createCommand(
    z.object({ locationId: z.string().optional().describe("Location ID to filter by") }),
    async (args, client: InFlowMCPClient) => {
      const { locationId } = args as { locationId?: string };
      return client.getStockByLocation(locationId);
    },
    "Get stock breakdown by location",
    { sideEffect: "read" }
  ),

  "list-stock-adjustments": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.listStockAdjustments({ limit });
    },
    "List stock adjustment history",
    { sideEffect: "read" }
  ),

  "get-stock-adjustment": createCommand(
    z.object({ id: z.string().min(1).describe("Adjustment ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockAdjustment(id);
    },
    "Get stock adjustment details",
    { sideEffect: "read" }
  ),

  "create-stock-adjustment": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID"),
      locationId: z.string().min(1).describe("Location ID"),
      quantity: cliTypes.int().describe("Quantity adjustment"),
      reasonId: z.string().optional().describe("Adjustment reason ID"),
      remarks: z.string().optional().describe("Notes/remarks"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        productId, locationId, quantity, reasonId, remarks, apply,
        confirmPreviewHash, confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        productId: string; locationId: string; quantity: number;
        reasonId?: string; remarks?: string; apply?: boolean; confirmPreviewHash?: string;
        confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      return runConfirmedSafeSet({
        command: "create-stock-adjustment",
        tool: "set_stock_adjustment",
        request: {
          mode: "replace",
          values: { locationId, adjustmentReasonId: reasonId, remarks, items: [{ productId, quantity }] },
        },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["inventory:stock"],
        client,
        globals,
      });
    },
    "Create a new stock adjustment",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "list-adjustment-reasons": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.listAdjustmentReasons(),
    "List available adjustment reasons",
    { sideEffect: "read" }
  ),

  "list-stock-transfers": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records (above 100 is fetched as 100-record provider pages)"),
      status: z.string().optional().describe("Filter by status"),
      fromLocationId: z.string().optional().describe("Source location ID"),
      toLocationId: z.string().optional().describe("Destination location ID"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, status, fromLocationId, toLocationId } = args as {
        limit?: number; status?: string;
        fromLocationId?: string; toLocationId?: string;
      };
      return client.listStockTransfers({ limit, status, fromLocationId, toLocationId });
    },
    "List stock transfers between locations",
    { sideEffect: "read" }
  ),

  "get-stock-transfer": createCommand(
    z.object({ id: z.string().min(1).describe("Transfer ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockTransfer(id);
    },
    "Get stock transfer details",
    { sideEffect: "read" }
  ),

  "create-stock-transfer": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID"),
      fromLocationId: z.string().min(1).describe("Source location ID"),
      toLocationId: z.string().min(1).describe("Destination location ID"),
      quantity: cliTypes.int(1).describe("Quantity to transfer"),
      remarks: z.string().optional().describe("Notes/remarks"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        productId, fromLocationId, toLocationId, quantity, remarks, apply,
        confirmPreviewHash, confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        productId: string; fromLocationId: string;
        toLocationId: string; quantity: number; remarks?: string; apply?: boolean; confirmPreviewHash?: string;
        confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      return runConfirmedSafeSet({
        command: "create-stock-transfer",
        tool: "set_stock_transfer",
        request: {
          mode: "replace",
          values: { fromLocationId, toLocationId, remarks, items: [{ productId, quantity }] },
        },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["inventory:stock"],
        client,
        globals,
      });
    },
    "Create a new stock transfer",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "list-stock-counts": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records (above 100 is fetched as 100-record provider pages)"),
      status: z.string().optional().describe("Filter by status"),
      locationId: z.string().optional().describe("Location ID"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, status, locationId } = args as {
        limit?: number; status?: string; locationId?: string;
      };
      return client.listStockCounts({ limit, status, locationId });
    },
    "List inventory count records",
    { sideEffect: "read" }
  ),

  "get-stock-count": createCommand(
    z.object({ id: z.string().min(1).describe("Stock count ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockCount(id);
    },
    "Get stock count details",
    { sideEffect: "read" }
  ),

  "list-stock-no-photo": createCommand(
    z.object({}),
    async () => {
      const report = await fetchStockNoPhotoReport();
      return buildStockNoPhotoSafeOutput(report);
    },
    "List products that appeared on a completed stock-count sheet but currently have no inFlow photo",
    { sideEffect: "read" }
  ),

  "create-stock-count": createCommand(
    z.object({
      locationId: z.string().min(1).describe("Location ID"),
      remarks: z.string().optional().describe("Notes/remarks"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        locationId, remarks, apply, confirmPreviewHash,
        confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        locationId: string; remarks?: string; apply?: boolean; confirmPreviewHash?: string;
        confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      return runConfirmedSafeSet({
        command: "create-stock-count",
        tool: "set_stock_count",
        request: { mode: "replace", values: { locationId, remarks } },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["inventory:stock"],
        client,
        globals,
      });
    },
    "Create a new stock count",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "list-sales-orders": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records (above 100 is fetched as 100-record provider pages)"),
      skip: cliTypes.int(0).optional().describe("Records to skip"),
      status: z.string().optional().describe("Filter by status"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, status, include } = args as {
        limit?: number; skip?: number; status?: string; include?: string;
      };
      const raw = await client.listSalesOrders({
        limit, skip, status,
        include: include?.split(","),
      });

      const rawOrders = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedOrders = (Array.isArray(rawOrders) ? rawOrders : [rawOrders]).map(
        (rawOrder, index) => {
          const order = asRecord(rawOrder);
          return {
            ...salesOrderMetadata(order),
            ...wrapSalesOrderContent(order, `orders[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-sales-orders",
          count: wrappedOrders.length,
          totalCount: raw?.totalCount,
        },
        { orders: wrappedOrders }
      );
    },
    "List sales orders",
    { sideEffect: "read" }
  ),

  "get-sales-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Sales order ID"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, include } = args as { id: string; include?: string };
      const order = await client.getSalesOrder(id, { include: include?.split(",") });

      const orderRecord = asRecord(order);
      return buildSafeOutput(
        {
          command: "get-sales-order",
          ...salesOrderMetadata(orderRecord),
        },
        wrapSalesOrderContent(orderRecord, "order")
      );
    },
    "Get sales order details",
    { sideEffect: "read" }
  ),

  "search-sales-orders": createCommand(
    z.object({ query: z.string().min(1).describe("Search term") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      const raw = await client.searchSalesOrders(query);

      const rawOrders = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedOrders = (Array.isArray(rawOrders) ? rawOrders : [rawOrders]).map(
        (rawOrder, index) => {
          const order = asRecord(rawOrder);
          return {
            ...salesOrderMetadata(order),
            ...wrapSalesOrderContent(order, `orders[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "search-sales-orders",
          query,
          count: wrappedOrders.length,
        },
        { orders: wrappedOrders }
      );
    },
    "Search sales orders",
    { sideEffect: "read" }
  ),

  "list-purchase-orders": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records (above 100 is fetched as 100-record provider pages)"),
      skip: cliTypes.int(0).optional().describe("Records to skip"),
      status: z.string().optional().describe("Filter by status"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, status, include } = args as {
        limit?: number; skip?: number; status?: string; include?: string;
      };
      const raw = await client.listPurchaseOrders({
        limit, skip, status,
        include: include?.split(","),
      });

      const rawOrders = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedOrders = (Array.isArray(rawOrders) ? rawOrders : [rawOrders]).map(
        (rawOrder, index) => {
          const order = asRecord(rawOrder);
          return {
            ...purchaseOrderMetadata(order),
            ...wrapPurchaseOrderContent(order, `orders[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-purchase-orders",
          count: wrappedOrders.length,
          totalCount: raw?.totalCount,
        },
        { orders: wrappedOrders }
      );
    },
    "List purchase orders",
    { sideEffect: "read" }
  ),

  "get-purchase-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Purchase order ID"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, include } = args as { id: string; include?: string };
      const order = await client.getPurchaseOrder(id, { include: include?.split(",") });

      const orderRecord = asRecord(order);
      return buildSafeOutput(
        {
          command: "get-purchase-order",
          ...purchaseOrderMetadata(orderRecord),
        },
        wrapPurchaseOrderContent(orderRecord, "order")
      );
    },
    "Get purchase order details",
    { sideEffect: "read" }
  ),

  "create-product": createCommand(
    z.object({
      name: z.string().min(1).describe("Product name (required)"),
      sku: z.string().optional().describe("Product SKU"),
      description: z.string().optional().describe("Product description"),
      categoryId: z.string().optional().describe("Category ID"),
      cost: z.coerce.number().optional().describe("Unit cost"),
      price: z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).optional().describe("Exact selling-price decimal"),
      pricingSchemeId: z.string().optional().describe("Exact pricing scheme ID required with --price"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
      barcode: z.string().optional().describe("Product barcode"),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        name, sku, description, categoryId, cost, price, barcode, apply,
        confirmPreviewHash, confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        name: string; sku?: string; description?: string; categoryId?: string;
        cost?: number; price?: string; barcode?: string; apply?: boolean;
        confirmPreviewHash?: string; confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      if (price !== undefined) throw new Error("Create the product first, then use set-product-prices with an exact pricingSchemeId");
      return runConfirmedSafeSet({
        command: "create-product",
        tool: "set_product",
        request: { mode: "replace", values: { name, sku, description, categoryId, cost, barcode } },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["products:list"],
        client,
        globals,
      });
    },
    "Create a new product in inFlow",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "update-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID (required)"),
      name: z.string().optional().describe("Product name"),
      sku: z.string().optional().describe("Product SKU"),
      description: z.string().optional().describe("Product description"),
      cost: z.coerce.number().optional().describe("Unit cost"),
      price: z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).optional().describe("Exact selling-price decimal"),
      pricingSchemeId: z.string().optional().describe("Exact pricing scheme ID required with --price"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const { id, name, sku, description, cost, price, pricingSchemeId, apply, confirmPreviewHash } = args as {
        id: string; name?: string; sku?: string; description?: string;
        cost?: number; price?: string; pricingSchemeId?: string; apply?: boolean; confirmPreviewHash?: string;
      };
      if (price !== undefined) {
        if (!pricingSchemeId) throw new Error("--pricingSchemeId is required with --price; price names are never write selectors");
        if (name !== undefined || sku !== undefined || description !== undefined || cost !== undefined) throw new Error("Price and product-field changes must be previewed as separate operations");
        return buildOperationalSafeOutput("update-product", await client.setProductPrices({ productId: id, mode: "patch", prices: [{ pricingSchemeId, unitPrice: price }] }, apply === true));
      }
      return runConfirmedSafeSet({
        command: "update-product",
        tool: "set_product",
        request: { productId: id, mode: "patch", values: { name, sku, description, cost } },
        apply: apply === true,
        confirmPreviewHash,
        tags: [`product:${id}`],
        client,
        globals,
      });
    },
    "Update an existing product",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "create-vendor": createCommand(
    z.object({
      name: z.string().min(1).describe("Vendor name (required)"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      website: z.string().optional().describe("Website URL"),
      street1: z.string().optional().describe("Address street line 1"),
      city: z.string().optional().describe("City"),
      postalCode: z.string().optional().describe("Postal code"),
      country: z.string().optional().describe("Country"),
      currency: z.string().optional().describe("Currency code (GBP, USD)"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        name, email, phone, website, street1, city, postalCode, country, currency, apply,
        confirmPreviewHash, confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        name: string; email?: string; phone?: string; website?: string;
        street1?: string; city?: string; postalCode?: string; country?: string;
        currency?: string; apply?: boolean; confirmPreviewHash?: string;
        confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      const address = (street1 || city || country) ? { street1, city, postalCode, country } : undefined;
      return runConfirmedSafeSet({
        command: "create-vendor",
        tool: "set_vendor",
        request: { mode: "replace", values: { name, email, phone, website, address, currencyCode: currency } },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["vendors:list"],
        client,
        globals,
      });
    },
    "Create a new vendor in inFlow",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "update-vendor": createCommand(
    z.object({
      id: z.string().min(1).describe("Vendor ID (required)"),
      name: z.string().optional().describe("Vendor name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      website: z.string().optional().describe("Website URL"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const { id, name, email, phone, website, apply, confirmPreviewHash } = args as {
        id: string; name?: string; email?: string; phone?: string; website?: string; apply?: boolean; confirmPreviewHash?: string;
      };
      return runConfirmedSafeSet({
        command: "update-vendor",
        tool: "set_vendor",
        request: { vendorId: id, mode: "patch", values: { name, email, phone, website } },
        apply: apply === true,
        confirmPreviewHash,
        tags: [`vendor:${id}`],
        client,
        globals,
      });
    },
    "Update an existing vendor",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "create-purchase-order": createCommand(
    z.object({
      vendorId: z.string().min(1).describe("Vendor ID (required)"),
      orderNumber: z.string().optional().describe("PO number (auto-generated if omitted)"),
      orderDate: z.string().optional().describe("Order date (ISO format)"),
      expectedDate: z.string().optional().describe("Expected delivery date"),
      locationId: z.string().optional().describe("Destination warehouse ID"),
      items: z.string().describe('JSON array: [{"productId":"...", "quantity":5, "unitCost":72}]'),
      currency: z.string().optional().describe("Currency code (GBP, USD)"),
      remarks: z.string().optional().describe("Notes/remarks"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
      ...idlessCreateConfirmationFields,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const {
        vendorId, orderNumber, orderDate, expectedDate, locationId, items, currency, remarks, apply,
        confirmPreviewHash, confirmPreviewToken, confirmIdempotencyKey,
      } = args as {
        vendorId: string; orderNumber?: string; orderDate?: string; expectedDate?: string;
        locationId?: string; items: string; currency?: string; remarks?: string;
        apply?: boolean; confirmPreviewHash?: string;
        confirmPreviewToken?: string; confirmIdempotencyKey?: string;
      };
      let parsedItems: Array<{ productId?: string; quantity: number; unitCost?: number; description?: string }>;
      try {
        parsedItems = JSON.parse(items);
      } catch {
        throw new Error('Invalid items JSON. Format: [{"productId":"...", "quantity":5}]');
      }
      const lines = parsedItems.map((item) => ({
        productId: item.productId,
        description: item.description,
        quantity: { standardQuantity: item.quantity, uomQuantity: item.quantity },
        unitPrice: item.unitCost,
      }));
      return runConfirmedSafeSet({
        command: "create-purchase-order",
        tool: "set_purchase_order",
        request: {
          mode: "replace",
          values: { vendorId, orderNumber, orderDate, expectedDate, locationId, lines, currencyCode: currency, orderRemarks: remarks },
        },
        apply: apply === true,
        confirmPreviewHash,
        confirmPreviewToken,
        confirmIdempotencyKey,
        tags: ["purchase-orders:list", "inventory:stock"],
        client,
        globals,
      });
    },
    "Create a new purchase order",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "add-po-item": createCommand(
    z.object({
      purchaseOrderId: z.string().min(1).describe("Purchase order ID"),
      productId: z.string().min(1).describe("Product ID to add"),
      quantity: cliTypes.int(1).describe("Quantity to order"),
      unitCost: z.coerce.number().optional().describe("Unit cost"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    async (args, client: InFlowMCPClient) => {
      const {
        purchaseOrderId,
        productId,
        quantity,
        unitCost,
        apply,
        confirmPreviewHash,
      } = args as {
        purchaseOrderId: string;
        productId: string;
        quantity: number;
        unitCost?: number;
        apply?: boolean;
        confirmPreviewHash?: string;
      };
      if (apply === true) {
        void confirmPreviewHash;
        throw new Error(
          "ADD_PO_ITEM_APPLY_DISABLED: the provider contract does not prove a complete writable projection for replaying existing purchase-order lines. Preview remains available; migrate to a narrow exact-ID append operation when the MCP exposes one."
        );
      }
      client.disableCache();
      let currentPO: unknown;
      try {
        currentPO = await client.getPurchaseOrder(purchaseOrderId, {
          include: ["lines", "receiveLines"],
        });
      } finally {
        client.enableCache();
      }
      const currentRecord = asRecord(currentPO);
      if (!Array.isArray(currentRecord.lines)) {
        throw new Error(
          "ADD_PO_ITEM_APPLY_DISABLED: the fresh purchase order did not return a complete lines array. Use set-purchase-order --values with a separately reviewed exact writable projection."
        );
      }
      if (!Array.isArray(currentRecord.receiveLines)) {
        throw new Error(
          "ADD_PO_ITEM_APPLY_DISABLED: the fresh purchase order did not prove a complete receiveLines array. Use set-purchase-order --values with a separately reviewed exact writable projection, or migrate to a narrow exact-ID append operation."
        );
      }
      if (currentRecord.receiveLines.length > 0) {
        throw new Error(
          "ADD_PO_ITEM_APPLY_DISABLED: the purchase order has receipt state that a whole-line-array replay cannot preserve exactly. Use a narrow exact-ID append operation when the MCP exposes one."
        );
      }
      const existingLines = currentRecord.lines.map(
        purchaseOrderLineWriteProjection
      );
      const request = {
        purchaseOrderId,
        mode: "patch",
        values: {
          lines: [
            ...existingLines,
            {
              productId,
              quantity: {
                standardQuantity: quantity,
                uomQuantity: quantity,
              },
              ...(unitCost !== undefined ? { unitPrice: unitCost } : {}),
            },
          ],
        },
      };
      const preview = await client.safeSet(
        "set_purchase_order",
        request,
        false,
        [`purchase-order:${purchaseOrderId}`, "inventory:stock"],
      );
      return buildOperationalSafeOutput("add-po-item", {
        ...preview,
        applyEnabled: false,
        confirmationUnavailableReason:
          "the provider contract does not prove a complete writable projection for replaying existing purchase-order lines",
        migrationGuidance:
          "Migrate to a narrow exact-ID append operation when the MCP exposes one; do not replay the complete line array.",
      });
    },
    "Append a PO line only when every existing line fits the pinned writable projection",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "update-purchase-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Purchase order ID"),
      remarks: z.string().optional().describe("Order remarks/notes"),
      orderDate: z.string().optional().describe("Order date (ISO format)"),
      expectedDate: z.string().optional().describe("Expected delivery date"),
      carrier: z.string().optional().describe("Unsupported compatibility option; fails closed when provided"),
      currency: z.string().optional().describe("Currency code (GBP, USD)"),
      apply: cliTypes.bool().optional().describe("Apply the fresh preview"),
      confirmPreviewHash: genericSafeSetConfirmationHashSchema,
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const { id, remarks, orderDate, expectedDate, carrier, currency, apply, confirmPreviewHash } = args as {
        id: string; remarks?: string; orderDate?: string; expectedDate?: string; carrier?: string; currency?: string; apply?: boolean; confirmPreviewHash?: string;
      };
      if (carrier !== undefined) {
        throw new Error("--carrier is not supported by the inFlow MCP purchase-order update surface");
      }

      return runConfirmedSafeSet({
        command: "update-purchase-order",
        tool: "set_purchase_order",
        request: {
          purchaseOrderId: id,
          mode: "patch",
          values: {
            ...(remarks !== undefined ? { orderRemarks: remarks } : {}),
            ...(orderDate !== undefined ? { orderDate } : {}),
            ...(expectedDate !== undefined ? { expectedDate } : {}),
            ...(currency !== undefined ? { currencyCode: currency } : {}),
          },
        },
        apply: apply === true,
        confirmPreviewHash,
        tags: [`purchase-order:${id}`],
        client,
        globals,
      });
    },
    "Update supported purchase-order headers without replacing line items",
    { sideEffect: "write", dryRunSupported: true, idempotent: true }
  ),

  "receive-po-items": createCommand(
    z.object({
      purchaseOrderId: z.string().min(1).describe("Purchase order ID"),
      receiveAll: cliTypes.bool().optional().describe("Fully receive all lines"),
      items: z.string().optional().describe(
        'Deprecated command only. Use set-po-receipts --action receive with [{"productId":"...","quantity":{...}}]'
      ),
      allowOverReceive: cliTypes.bool().optional().describe("Allow qty > ordered"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { purchaseOrderId, receiveAll, items, allowOverReceive } = args as {
        purchaseOrderId: string; receiveAll?: boolean; items?: string;
        allowOverReceive?: boolean;
      };
      if (!receiveAll && !items)
        throw new Error('Provide --receiveAll=true or --items=[...]');
      if (receiveAll && items)
        throw new Error('Cannot use both --receiveAll and --items');
      void client; void purchaseOrderId; void receiveAll; void items; void allowOverReceive;
      throw new Error("receive-po-items is deprecated and disabled; use set-po-receipts --action receive with exact productId+quantity rows so preview/apply safety is preserved");
    },
    "Receive items on a purchase order (partial or full)",
    { sideEffect: "write" }
  ),

  "unreceive-po-items": createCommand(
    z.object({
      purchaseOrderId: z.string().min(1).describe("Purchase order ID"),
      receiveLineIds: z.string().optional().describe('JSON array of receive line IDs to remove'),
      items: z.string().optional().describe(
        'JSON array: [{"productId":"...","quantity":6}] — removes newest receive lines first'
      ),
      unreceiveAll: cliTypes.bool().optional().describe("Remove ALL receive lines"),
      dryRun: cliTypes.bool().optional().describe("Preview only — don't make changes"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { purchaseOrderId, receiveLineIds, items, unreceiveAll, dryRun } = args as {
        purchaseOrderId: string; receiveLineIds?: string; items?: string;
        unreceiveAll?: boolean; dryRun?: boolean;
      };
      const modes = [receiveLineIds, items, unreceiveAll].filter(Boolean).length;
      if (modes === 0) throw new Error('Provide --receiveLineIds, --items, or --unreceiveAll');
      if (modes > 1) throw new Error('Use only one of --receiveLineIds, --items, or --unreceiveAll');

      void client; void purchaseOrderId; void receiveLineIds; void items; void unreceiveAll; void dryRun;
      throw new Error("unreceive-po-items is deprecated and disabled; use set-po-receipts --action unreceive with exact receive-line rows");
    },
    "Remove received items from a purchase order (reverse stock)",
    { sideEffect: "write" }
  ),

  "list-locations": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => {
      const raw = await client.listLocations();

      const rawLocations = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedLocations = (Array.isArray(rawLocations) ? rawLocations : [rawLocations]).map(
        (rawLocation, index) => {
          const location = asRecord(rawLocation);
          const sublocations = Array.isArray(location.sublocations)
            ? (location.sublocations as unknown[])
            : [];

          return {
            locationId: location.locationId ?? location.id,
            isActive: location.isActive,
            isDefault: location.isDefault,
            ...wrapLocation(location, `locations[${index}]`),
            sublocations: sublocations.map((subloc, subIndex) =>
              wrapUntrustedField(
                `locations[${index}].sublocations[${subIndex}]`,
                subloc == null ? "" : String(subloc),
                { maxChars: TRUNCATION_DEFAULTS.displayName }
              )
            ),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-locations",
          count: wrappedLocations.length,
          totalCount: raw?.totalCount,
        },
        { locations: wrappedLocations }
      );
    },
    "List warehouse locations",
    { sideEffect: "read" }
  ),

  "get-location": createCommand(
    z.object({ id: z.string().min(1).describe("Location ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      const location = await client.getLocation(id);

      const locationRecord = asRecord(location);
      const sublocations = Array.isArray(locationRecord.sublocations)
        ? (locationRecord.sublocations as unknown[])
        : [];

      return buildSafeOutput(
        {
          command: "get-location",
          locationId: locationRecord.locationId ?? locationRecord.id ?? id,
          isActive: locationRecord.isActive,
          isDefault: locationRecord.isDefault,
        },
        {
          ...wrapLocation(locationRecord, "location"),
          sublocations: sublocations.map((subloc, subIndex) =>
            wrapUntrustedField(
              `sublocations[${subIndex}]`,
              subloc == null ? "" : String(subloc),
              { maxChars: TRUNCATION_DEFAULTS.displayName }
            )
          ),
        }
      );
    },
    "Get location details",
    { sideEffect: "read" }
  ),

  "get-order-serials": createCommand(
    z.object({ id: z.string().min(1).describe("Sales order ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getSalesOrderSerials(id);
    },
    "Get serial numbers from a sales order",
    { sideEffect: "read" }
  ),

  "get-po-serials": createCommand(
    z.object({ id: z.string().min(1).describe("Purchase order ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getPurchaseOrderSerials(id);
    },
    "Get serial numbers from a purchase order",
    { sideEffect: "read" }
  ),

  "search-serial": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search for") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSerial(query);
    },
    "Find which order a serial number is on",
    { sideEffect: "read" }
  ),

  "list-serials": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
      productId: z.string().optional().describe("Filter by product ID"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, productId } = args as { limit?: number; productId?: string };
      return client.listSerials({ limit, productId });
    },
    "List all serial numbers from fulfilled orders",
    { sideEffect: "read" }
  ),

  "build-serial-index": createCommand(
    z.object({ limit: cliTypes.int(1).optional().describe("Max orders to scan") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      console.error("Building serial index (this may take a while)...");
      const serialIndex = await client.buildSerialIndex({ limit });
      return {
        success: true,
        totalSerials: Object.keys(serialIndex).length,
        message: "serial index built and cached for 1 hour",
      };
    },
    "Rebuild the serial cache (slow)",
    { sideEffect: "write" }
  ),

  "get-product-serials": createCommand(
    z.object({ id: z.string().min(1).describe("Product ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      const result = await client.getProductSerials(id);

      const resultRecord = asRecord(result);
      const serials = Array.isArray(resultRecord.serials)
        ? (resultRecord.serials as unknown[])
        : [];
      const wrappedSerials = serials.map((rawSerial, index) => {
        const serial = asRecord(rawSerial);
        return {
          serial: serial.serial,
          productId: serial.productId,
          locationId: serial.locationId,
          quantityOnHand: serial.quantityOnHand,
          inStock: serial.inStock,
          sublocation: wrapUntrustedField(
            `serials[${index}].sublocation`,
            serial.sublocation ?? "",
            { maxChars: TRUNCATION_DEFAULTS.displayName }
          ),
        };
      });

      return buildSafeOutput(
        {
          command: "get-product-serials",
          productId: resultRecord.productId ?? id,
          totalSerials: wrappedSerials.length,
        },
        { serials: wrappedSerials }
      );
    },
    "Get serial numbers for a specific product (FAST)",
    { sideEffect: "read" }
  ),

  "list-all-serials": createCommand(
    z.object({
      maxProducts: cliTypes.int(1, 500).optional().describe("Max products to scan (default: 100; provider max: 500)"),
      inStockOnly: cliTypes.bool().optional().describe("Only show in-stock serials"),
      chunk: cliTypes.int(1).default(1).describe("1-based output chunk to return"),
      chunkSize: cliTypes.int(1, 1000).default(100).describe("Maximum serials returned on stdout"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { maxProducts, inStockOnly, chunk, chunkSize } = args as {
        maxProducts?: number;
        inStockOnly?: boolean;
        chunk: number;
        chunkSize: number;
      };
      const scan = await fetchAllVins(client, { maxProducts, inStockOnly });
      const chunkCount = Math.max(
        1,
        Math.ceil(scan.serials.length / chunkSize)
      );
      if (scan.serials.length > 0 && chunk > chunkCount) {
        throw new Error(
          `--chunk ${chunk} is beyond the available ${chunkCount} chunk(s)`
        );
      }
      const chunkStart = (chunk - 1) * chunkSize;
      const chunkSerials = scan.serials.slice(
        chunkStart,
        chunkStart + chunkSize
      );
      const outputTruncated = chunkSerials.length < scan.serials.length;

      return buildSafeOutput(
        {
          command: "list-all-serials",
          totalSerials: scan.totalSerials,
          productsFetched: scan.productsFetched,
          scanLimit: scan.scanLimit,
          scanTruncated: scan.scanTruncated,
          providerHasMore: scan.providerHasMore,
          chunk,
          chunkSize,
          chunkCount,
          returnedSerials: chunkSerials.length,
          outputTruncated,
          truncated: scan.scanTruncated || outputTruncated,
          hasMore: scan.scanTruncated || chunk < chunkCount,
          nextChunk: chunk < chunkCount ? chunk + 1 : undefined,
        },
        { serials: chunkSerials }
      );
    },
    "List serialized-product serial numbers with bounded read-only stdout",
    { sideEffect: "read" }
  ),

  "export-all-vins": createCommand(
    z.object({
      maxProducts: cliTypes.int(1, 500).optional().describe("Max products to scan (default: 100; provider max: 500)"),
      inStockOnly: cliTypes.bool().optional().describe("Only export in-stock serials"),
      outputFile: z.string().min(1).describe("Path for the complete SafeOutput JSON"),
      overwrite: cliTypes.bool().default(false).describe("Replace an existing target; requires --confirm"),
    }),
    async (args, client: InFlowMCPClient, globals) => {
      const { maxProducts, inStockOnly, outputFile, overwrite } = args as {
        maxProducts?: number;
        inStockOnly?: boolean;
        outputFile: string;
        overwrite: boolean;
      };
      const outputPath = resolve(outputFile);
      if (overwrite && globals.confirm !== true) {
        throw new Error(
          "--overwrite true requires --confirm before any export or MCP call"
        );
      }
      const targetExists = pathEntryExists(outputPath);
      if (targetExists && !overwrite) {
        throw new Error(
          `Output file already exists: ${outputPath}. Use --overwrite true with --confirm to replace it.`
        );
      }

      const scan = await fetchAllVins(client, { maxProducts, inStockOnly });
      const completeOutput = buildSafeOutput(
        {
          command: "export-all-vins",
          totalSerials: scan.totalSerials,
          returnedSerials: scan.totalSerials,
          productsFetched: scan.productsFetched,
          scanLimit: scan.scanLimit,
          scanTruncated: scan.scanTruncated,
          providerHasMore: scan.providerHasMore,
          truncated: scan.scanTruncated,
          hasMore: scan.scanTruncated,
          outputFile: outputPath,
        },
        { serials: scan.serials }
      );
      writeRestrictedJson(outputPath, completeOutput, { overwrite });

      return buildSafeOutput(
        {
          command: "export-all-vins",
          outputFile: outputPath,
          exportedSerials: scan.totalSerials,
          productsFetched: scan.productsFetched,
          scanLimit: scan.scanLimit,
          scanTruncated: scan.scanTruncated,
          overwritten: targetExists,
        },
        {}
      );
    },
    "Export serialized-product serial numbers to a restricted JSON file",
    {
      sideEffect: "write",
      requiresConfirmation: false,
    }
  ),

  "search-serial-fast": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search for") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      const result = await client.searchSerialByProduct(query);

      const resultRecord = asRecord(result);
      const metadata: AnyRecord = {
        command: "search-serial-fast",
        query,
        found: resultRecord.found,
      };
      const content: AnyRecord = {};

      if (resultRecord.found) {
        metadata.vin = resultRecord.vin;
        metadata.productId = resultRecord.productId;
        metadata.locationId = resultRecord.locationId;
        metadata.quantityOnHand = resultRecord.quantityOnHand;
        metadata.inStock = resultRecord.inStock;
        content.productName = wrapUntrustedField(
          "productName",
          resultRecord.productName ?? "",
          { maxChars: TRUNCATION_DEFAULTS.subject }
        );
        content.sublocation = wrapUntrustedField(
          "sublocation",
          resultRecord.sublocation ?? "",
          { maxChars: TRUNCATION_DEFAULTS.displayName }
        );
      } else {
        metadata.vin = resultRecord.vin;
        content.message = wrapUntrustedField(
          "message",
          resultRecord.message ?? "",
          { maxChars: TRUNCATION_DEFAULTS.body }
        );
      }

      return buildSafeOutput(metadata, content);
    },
    "Find serial number by product lookup (no order info)",
    { sideEffect: "read" }
  ),

  "list-serial-numbers": createCommand(
    z.object({ productId: z.string().optional(), limit: cliTypes.int(1).optional() }),
    async (args, client: InFlowMCPClient) => {
      const { productId, limit } = args as { productId?: string; limit?: number };
      return client.listSerials({ productId, limit });
    },
    "Alias for list-serials",
    { sideEffect: "read" }
  ),

  "search-serial-numbers": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSerial(query);
    },
    "Alias for search-serial",
    { sideEffect: "read" }
  ),

  "get-serial-number": createCommand(
    z.object({ id: z.string().min(1).describe("serial number") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.searchSerial(id);
    },
    "Alias for search-serial",
    { sideEffect: "read" }
  ),

  "list-customers": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      const raw = await client.listCustomers({ limit });

      const rawCustomers = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedCustomers = (Array.isArray(rawCustomers) ? rawCustomers : [rawCustomers]).map(
        (rawCustomer, index) => {
          const customer = asRecord(rawCustomer);
          return {
            customerId: customer.customerId,
            currencyCode: customer.currencyCode,
            pricingSchemeId: customer.pricingSchemeId,
            paymentTermsId: customer.paymentTermsId,
            taxingSchemeId: customer.taxingSchemeId,
            isActive: customer.isActive,
            createdDate: customer.createdDate,
            modifiedDate: customer.lastModifiedDateTime ?? customer.modifiedDate,
            timestamp: customer.timestamp,
            ...wrapCustomer(customer, `customers[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-customers",
          count: wrappedCustomers.length,
          totalCount: raw?.totalCount,
        },
        { customers: wrappedCustomers }
      );
    },
    "List customer records",
    { sideEffect: "read" }
  ),

  "list-vendors": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      const raw = await client.listVendors({ limit });

      const rawVendors = (raw?.data ?? raw ?? []) as unknown[];
      const wrappedVendors = (Array.isArray(rawVendors) ? rawVendors : [rawVendors]).map(
        (rawVendor, index) => {
          const vendor = asRecord(rawVendor);
          return {
            vendorId: vendor.vendorId,
            currencyCode: vendor.currencyCode,
            paymentTermsId: vendor.paymentTermsId,
            isActive: vendor.isActive,
            createdDate: vendor.createdDate,
            modifiedDate: vendor.modifiedDate,
            timestamp: vendor.timestamp,
            ...wrapVendor(vendor, `vendors[${index}]`),
          };
        }
      );

      return buildSafeOutput(
        {
          command: "list-vendors",
          count: wrappedVendors.length,
          totalCount: raw?.totalCount,
        },
        { vendors: wrappedVendors }
      );
    },
    "List vendor records",
    { sideEffect: "read" }
  ),

  "get-company-info": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.getCompanyInfo(),
    "Get company configuration",
    { sideEffect: "read" }
  ),

  "list-currencies": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.callTool("list_currencies", { count: limit });
    },
    "List all available currencies",
    { sideEffect: "read" }
  ),

  ...cacheCommands<InFlowMCPClient>(),
};

let isCliEntry = false;
try {
  isCliEntry =
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isCliEntry = false;
}

if (isCliEntry) {
  runCli(commands, InFlowMCPClient, {
    programName: "inflow-cli",
    description: "inFlow inventory management via MCP",
  });
}

export const __wrapInternals = {
  asRecord,
  wrapProduct,
  wrapCustomer,
  wrapVendor,
  wrapAddress,
  wrapLocation,
  wrapCategory,
  wrapSalesOrderContent,
  wrapSalesOrderLineFamily,
  wrapPurchaseOrderContent,
  wrapOrderLines,
};

