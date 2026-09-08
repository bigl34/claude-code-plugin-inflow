import { loadServiceConfig, z } from "@local/cli-utils";

const INFLOW_BASE_URL = "https://cloudapi.inflowinventory.com";
const INFLOW_API_VERSION = "2026-07-10";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const DEFAULT_MINIMUM_REQUEST_INTERVAL_MS = 2_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

type JsonRecord = Record<string, unknown>;

interface JsonApiResource {
  id: string;
  type: string;
  attributes: JsonRecord;
  relationships: JsonRecord;
}

interface RestCredentials {
  apiKey: string;
  companyId: string;
}

interface RestResponse {
  body: unknown;
  listCount: number | null;
}

interface StockCountHeader {
  stockCountId: string;
  stockCountNumber: string;
  timestamp: string;
  completedDate: string;
}

interface StockCountEvidence {
  productIds: Set<string>;
  sheetCount: number;
  lineCount: number;
}

interface ProductSnapshot {
  productId: string;
  timestamp: string;
  sku: string;
  name: string;
  isActive: boolean;
  imageIds: string[];
  defaultImageId: string | null;
}

interface ProductMembership {
  productId: string;
  countNumbers: Set<string>;
  firstCountDate: string;
  firstCountNumber: string;
  lastCountDate: string;
  lastCountNumber: string;
}

export interface CountedProductCatalogueProduct {
  productId: string;
  sku: string;
  name: string;
  isActive: boolean;
  hasCompletedStockCount: boolean;
  stockCountOccurrences: number;
  firstCountDate: string | null;
  firstCountNumber: string | null;
  lastCountDate: string | null;
  lastCountNumber: string | null;
}

export interface CountedProductCatalogueReport {
  generatedAt: string;
  complete: true;
  stableSnapshotAttempts: number;
  completedStockCountsScanned: number;
  countSheetsScanned: number;
  countLinesScanned: number;
  uniqueCountedProducts: number;
  catalogueProducts: number;
  products: CountedProductCatalogueProduct[];
}

export interface StockNoPhotoProduct {
  productId: string;
  sku: string;
  name: string;
  isActive: boolean;
  stockCountOccurrences: number;
  firstCountDate: string;
  firstCountNumber: string;
  lastCountDate: string;
  lastCountNumber: string;
}

export interface StockNoPhotoReport {
  generatedAt: string;
  complete: true;
  stableSnapshotAttempts: number;
  completedStockCountsScanned: number;
  countSheetsScanned: number;
  countLinesScanned: number;
  uniqueCountedProducts: number;
  productsWithoutPhoto: StockNoPhotoProduct[];
}

export interface StockNoPhotoOptions {
  apiKey: string;
  companyId: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  minimumRequestIntervalMs?: number;
  maxRetries?: number;
}

const InFlowRestConfigSchema = z.object({
  mcpServer: z.object({
    env: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
});

class SnapshotChangedError extends Error {}

interface StableCountedProductSnapshot {
  generatedAt: string;
  stableSnapshotAttempts: number;
  completedStockCountsScanned: number;
  countSheetsScanned: number;
  countLinesScanned: number;
  products: ProductSnapshot[];
  memberships: Map<string, ProductMembership>;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function requiredNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function parseNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function resourceFrom(value: unknown, label: string): JsonApiResource {
  const resource = asRecord(value);
  const nestedAttributes = asRecord(resource.attributes);
  const attributes = Object.keys(nestedAttributes).length > 0 ? nestedAttributes : resource;
  const inferredId = resource.id
    ?? attributes.productId
    ?? attributes.stockCountId
    ?? attributes.countSheetId
    ?? attributes.countSheetLineId
    ?? attributes.imageId
    ?? resource.productId
    ?? resource.stockCountId
    ?? resource.countSheetId
    ?? resource.countSheetLineId
    ?? resource.imageId;
  const inferredType = resource.type
    ?? ((resource.stockCountId ?? attributes.stockCountId) ? "stockCounts" : undefined)
    ?? ((resource.countSheetId ?? attributes.countSheetId) ? "countSheets" : undefined)
    ?? ((resource.countSheetLineId ?? attributes.countSheetLineId) ? "countSheetLines" : undefined)
    ?? ((resource.productId ?? attributes.productId) ? "products" : undefined)
    ?? ((resource.imageId ?? attributes.imageId) ? "images" : undefined);
  return {
    id: requiredString(
      inferredId,
      `${label}.id (keys: ${Object.keys(resource).sort().join(",") || "none"})`,
    ),
    type: requiredString(inferredType, `${label}.type`),
    attributes,
    relationships: Object.keys(asRecord(resource.relationships)).length > 0
      ? asRecord(resource.relationships)
      : resource,
  };
}

function relationshipData(resource: JsonApiResource, name: string): unknown {
  const rawRelationship = resource.relationships[name];
  const relationship = asRecord(rawRelationship);
  if ("data" in relationship) return relationship.data;
  if (Array.isArray(rawRelationship) || rawRelationship === null) return rawRelationship;
  if (Object.keys(relationship).length > 0) return rawRelationship;
  if (!(name in resource.relationships)) {
    throw new Error(`${resource.type} ${resource.id} is missing hydrated relationship ${name}`);
  }
  return rawRelationship;
}

function relationshipArray(resource: JsonApiResource, name: string): JsonApiResource[] {
  const data = relationshipData(resource, name);
  if (!Array.isArray(data)) {
    throw new Error(`${resource.type} ${resource.id} relationship ${name} is not an array`);
  }
  return data.map((entry, index) => resourceFrom(entry, `${resource.type}.${name}[${index}]`));
}

function relationshipOneOrNull(resource: JsonApiResource, name: string): JsonApiResource | null {
  const data = relationshipData(resource, name);
  if (data === null) return null;
  return resourceFrom(data, `${resource.type}.${name}`);
}

function envelopeData(body: unknown, label: string): unknown[] {
  if (Array.isArray(body)) return body;
  const envelope = asRecord(body);
  if (!Array.isArray(envelope.data)) {
    throw new Error(
      `${label} returned a malformed collection envelope ` +
      `(top-level keys: ${Object.keys(envelope).sort().join(",") || "none"})`,
    );
  }
  return envelope.data;
}

function envelopeListCount(body: unknown): number | null {
  const meta = asRecord(asRecord(body).meta);
  return parseNonNegativeInteger(meta.listCount ?? meta.totalCount);
}

function includedMap(body: unknown): Map<string, JsonApiResource> {
  const envelope = asRecord(body);
  if (!Array.isArray(envelope.included)) return new Map();
  const result = new Map<string, JsonApiResource>();
  envelope.included.forEach((entry, index) => {
    const resource = resourceFrom(entry, `included[${index}]`);
    const key = `${resource.type}:${resource.id}`;
    if (result.has(key)) throw new Error(`stock-count detail repeated included resource ${key}`);
    result.set(key, resource);
  });
  return result;
}

function fingerprintHeaders(headers: StockCountHeader[]): string {
  return JSON.stringify(headers.map((header) => [
    header.stockCountId,
    header.timestamp,
    header.completedDate,
  ]));
}

function fingerprintProducts(products: ProductSnapshot[]): string {
  return JSON.stringify(products.map((product) => [
    product.productId,
    product.timestamp,
    product.sku,
    product.name,
    product.isActive,
    product.imageIds,
    product.defaultImageId,
  ]));
}

function retryAfterMilliseconds(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class StockNoPhotoRestClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minimumRequestIntervalMs: number;
  private readonly maxRetries: number;
  private lastRequestStartedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: StockNoPhotoOptions) {
    this.baseUrl = (options.baseUrl ?? INFLOW_BASE_URL).replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? INFLOW_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.minimumRequestIntervalMs = options.minimumRequestIntervalMs
      ?? DEFAULT_MINIMUM_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? 3;
  }

  private async waitForRequestSlot(): Promise<void> {
    const remaining = this.minimumRequestIntervalMs - (this.now() - this.lastRequestStartedAt);
    if (remaining > 0) await this.sleep(remaining);
    this.lastRequestStartedAt = this.now();
  }

  private async get(path: string): Promise<RestResponse> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.waitForRequestSlot();
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/${encodeURIComponent(this.options.companyId)}${path}`,
          {
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              Accept: `application/json;version=${this.apiVersion}`,
            },
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.sleep(Math.min(8_000, 1_000 * (2 ** attempt)));
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await response.text().catch(() => "");
        const retryAfter = retryAfterMilliseconds(
          response.headers.get("Retry-After"),
          this.now(),
        );
        const fallbackBackoff = response.status === 429
          ? DEFAULT_RATE_LIMIT_BACKOFF_MS
          : Math.min(8_000, 1_000 * (2 ** attempt));
        await this.sleep(Math.max(retryAfter, fallbackBackoff));
        continue;
      }
      if (!response.ok) {
        await response.text().catch(() => "");
        throw new Error(`inFlow API ${response.status} while reading ${path.split("?")[0]}`);
      }

      const body = await response.json() as unknown;
      const headerCount = parseNonNegativeInteger(response.headers.get("X-listCount"));
      return {
        body,
        listCount: headerCount ?? envelopeListCount(body),
      };
    }
    throw new Error("inFlow API retry loop exhausted");
  }

  private async listAll(path: string, label: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.get(
        `${path}${separator}includeCount=true&count=${PAGE_SIZE}&skip=${rows.length}`,
      );
      if (response.listCount === null) {
        throw new Error(`${label} omitted X-listCount/listCount completeness evidence`);
      }
      if (expectedTotal !== null && response.listCount !== expectedTotal) {
        throw new SnapshotChangedError(`${label} count changed during pagination`);
      }
      expectedTotal = response.listCount;
      const pageRows = envelopeData(response.body, label);
      if (pageRows.length > PAGE_SIZE) throw new Error(`${label} exceeded its requested page size`);

      for (const rawRow of pageRows) {
        const resource = resourceFrom(rawRow, `${label} row`);
        const key = `${resource.type}:${resource.id}`;
        if (seen.has(key)) throw new SnapshotChangedError(`${label} repeated ${key} during pagination`);
        seen.add(key);
        rows.push(rawRow);
      }

      if (rows.length === expectedTotal) return rows;
      if (rows.length > expectedTotal) throw new SnapshotChangedError(`${label} exceeded listCount`);
      if (pageRows.length === 0 || pageRows.length < PAGE_SIZE) {
        throw new SnapshotChangedError(`${label} ended before listCount was reached`);
      }
    }
    throw new Error(`${label} exceeded ${MAX_PAGES} pages`);
  }

  async listCompletedStockCounts(): Promise<StockCountHeader[]> {
    const rows = await this.listAll("/stock-counts", "inFlow stock counts");
    return rows.map((row, index): StockCountHeader | null => {
      const resource = resourceFrom(row, `stockCounts[${index}]`);
      const isCompleted = resource.attributes.isCompleted;
      const isCancelled = resource.attributes.isCancelled;
      if (typeof isCompleted !== "boolean" || typeof isCancelled !== "boolean") {
        throw new Error(`stock count ${resource.id} omitted completion state`);
      }
      if (!isCompleted || isCancelled) return null;
      return {
        stockCountId: resource.id,
        stockCountNumber: requiredString(
          resource.attributes.stockCountNumber,
          `stock count ${resource.id}.stockCountNumber`,
        ),
        timestamp: requiredString(
          resource.attributes.timestamp,
          `stock count ${resource.id}.timestamp`,
        ),
        completedDate: requiredString(
          resource.attributes.completedDate,
          `stock count ${resource.id}.completedDate`,
        ),
      };
    }).filter((row): row is StockCountHeader => row !== null)
      .sort((left, right) => left.stockCountId.localeCompare(right.stockCountId));
  }

  async getStockCountEvidence(header: StockCountHeader): Promise<StockCountEvidence> {
    const include = encodeURIComponent("sheets.lines");
    const response = await this.get(
      `/stock-counts/${encodeURIComponent(header.stockCountId)}?include=${include}`,
    );
    const envelope = asRecord(response.body);
    const root = resourceFrom(envelope.data ?? response.body, "stock-count detail");
    if (root.id !== header.stockCountId) throw new Error("stock-count detail identity changed");
    if (root.attributes.timestamp !== header.timestamp) {
      throw new SnapshotChangedError(`stock count ${header.stockCountNumber} changed during the report`);
    }

    const included = includedMap(response.body);
    const sheetRefs = relationshipArray(root, "sheets");
    const productIds = new Set<string>();
    let lineCount = 0;

    for (const sheetRef of sheetRefs) {
      const sheet = included.get(`${sheetRef.type}:${sheetRef.id}`) ?? sheetRef;
      const lineRefs = relationshipArray(sheet, "lines");
      lineCount += lineRefs.length;
      const isCompleted = sheet.attributes.isCompleted;
      const isCancelled = sheet.attributes.isCancelled;
      if (typeof isCompleted !== "boolean" || typeof isCancelled !== "boolean") {
        throw new Error(`count sheet ${sheet.id} omitted completion state`);
      }
      if (!isCompleted || isCancelled) continue;
      for (const lineRef of lineRefs) {
        const line = included.get(`${lineRef.type}:${lineRef.id}`) ?? lineRef;
        const productId = typeof line.attributes.productId === "string"
          ? line.attributes.productId
          : relationshipOneOrNull(line, "product")?.id;
        if (!productId) {
          throw new Error(`stock count ${header.stockCountNumber} has a line without a product`);
        }
        productIds.add(productId);
      }
    }

    return { productIds, sheetCount: sheetRefs.length, lineCount };
  }

  async listProductSnapshot(): Promise<ProductSnapshot[]> {
    const include = encodeURIComponent("defaultImage,images");
    const rows = await this.listAll(`/products?include=${include}`, "inFlow products");
    return rows.map((row, index): ProductSnapshot => {
      const product = resourceFrom(row, `products[${index}]`);
      const imageRefs = relationshipArray(product, "images");
      const defaultImage = relationshipOneOrNull(product, "defaultImage");
      const hydratedDefaultImageId = defaultImage?.id ?? null;
      if ("defaultImageId" in product.attributes) {
        const scalarDefaultImageId = requiredNullableString(
          product.attributes.defaultImageId,
          `product ${product.id}.defaultImageId`,
        );
        if (hydratedDefaultImageId !== scalarDefaultImageId) {
          throw new Error(`product ${product.id} has contradictory default-image state`);
        }
      }
      if (typeof product.attributes.isActive !== "boolean") {
        throw new Error(`product ${product.id}.isActive is missing or invalid`);
      }
      return {
        productId: product.id,
        timestamp: requiredString(product.attributes.timestamp, `product ${product.id}.timestamp`),
        sku: typeof product.attributes.sku === "string" ? product.attributes.sku : "",
        name: requiredString(product.attributes.name, `product ${product.id}.name`),
        isActive: product.attributes.isActive,
        imageIds: imageRefs.map((image) => image.id),
        defaultImageId: hydratedDefaultImageId,
      };
    }).sort((left, right) => left.productId.localeCompare(right.productId));
  }
}

function addMembership(
  memberships: Map<string, ProductMembership>,
  header: StockCountHeader,
  productId: string,
): void {
  const existing = memberships.get(productId);
  if (!existing) {
    memberships.set(productId, {
      productId,
      countNumbers: new Set([header.stockCountNumber]),
      firstCountDate: header.completedDate,
      firstCountNumber: header.stockCountNumber,
      lastCountDate: header.completedDate,
      lastCountNumber: header.stockCountNumber,
    });
    return;
  }
  existing.countNumbers.add(header.stockCountNumber);
  if (header.completedDate < existing.firstCountDate) {
    existing.firstCountDate = header.completedDate;
    existing.firstCountNumber = header.stockCountNumber;
  }
  if (header.completedDate > existing.lastCountDate) {
    existing.lastCountDate = header.completedDate;
    existing.lastCountNumber = header.stockCountNumber;
  }
}

async function buildStableCountedProductSnapshot(
  options: StockNoPhotoOptions,
): Promise<StableCountedProductSnapshot> {
  const client = new StockNoPhotoRestClient(options);

  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const before = await client.listCompletedStockCounts();
      const memberships = new Map<string, ProductMembership>();
      let countSheetsScanned = 0;
      let countLinesScanned = 0;

      for (const header of before) {
        const evidence = await client.getStockCountEvidence(header);
        countSheetsScanned += evidence.sheetCount;
        countLinesScanned += evidence.lineCount;
        for (const productId of evidence.productIds) {
          addMembership(memberships, header, productId);
        }
      }

      const firstProducts = await client.listProductSnapshot();
      const secondProducts = await client.listProductSnapshot();
      if (fingerprintProducts(firstProducts) !== fingerprintProducts(secondProducts)) {
        throw new SnapshotChangedError("inFlow product/image state changed during the report");
      }

      const after = await client.listCompletedStockCounts();
      if (fingerprintHeaders(before) !== fingerprintHeaders(after)) {
        throw new SnapshotChangedError("inFlow completed stock counts changed during the report");
      }

      const productIds = new Set(secondProducts.map((product) => product.productId));
      for (const membership of memberships.values()) {
        if (!productIds.has(membership.productId)) {
          throw new Error(`counted product ${membership.productId} is absent from the complete product catalogue`);
        }
      }

      return {
        generatedAt: new Date().toISOString(),
        stableSnapshotAttempts: attempt,
        completedStockCountsScanned: before.length,
        countSheetsScanned,
        countLinesScanned,
        products: secondProducts,
        memberships,
      };
    } catch (error) {
      if (!(error instanceof SnapshotChangedError) || attempt >= MAX_SNAPSHOT_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error("inFlow stock-count report could not obtain a stable snapshot");
}

export async function buildCountedProductCatalogueReport(
  options: StockNoPhotoOptions,
): Promise<CountedProductCatalogueReport> {
  const snapshot = await buildStableCountedProductSnapshot(options);
  const products = snapshot.products.map((product): CountedProductCatalogueProduct => {
    const membership = snapshot.memberships.get(product.productId);
    return {
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      isActive: product.isActive,
      hasCompletedStockCount: membership !== undefined,
      stockCountOccurrences: membership?.countNumbers.size ?? 0,
      firstCountDate: membership?.firstCountDate ?? null,
      firstCountNumber: membership?.firstCountNumber ?? null,
      lastCountDate: membership?.lastCountDate ?? null,
      lastCountNumber: membership?.lastCountNumber ?? null,
    };
  });

  return {
    generatedAt: snapshot.generatedAt,
    complete: true,
    stableSnapshotAttempts: snapshot.stableSnapshotAttempts,
    completedStockCountsScanned: snapshot.completedStockCountsScanned,
    countSheetsScanned: snapshot.countSheetsScanned,
    countLinesScanned: snapshot.countLinesScanned,
    uniqueCountedProducts: snapshot.memberships.size,
    catalogueProducts: products.length,
    products,
  };
}

export async function buildStockNoPhotoReport(
  options: StockNoPhotoOptions,
): Promise<StockNoPhotoReport> {
  const snapshot = await buildStableCountedProductSnapshot(options);
  const productsWithoutPhoto: StockNoPhotoProduct[] = [];
  for (const product of snapshot.products) {
    const membership = snapshot.memberships.get(product.productId);
    if (!membership || product.imageIds.length > 0 || product.defaultImageId !== null) continue;
    productsWithoutPhoto.push({
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      isActive: product.isActive,
      stockCountOccurrences: membership.countNumbers.size,
      firstCountDate: membership.firstCountDate,
      firstCountNumber: membership.firstCountNumber,
      lastCountDate: membership.lastCountDate,
      lastCountNumber: membership.lastCountNumber,
    });
  }

  productsWithoutPhoto.sort((left, right) =>
    left.sku.localeCompare(right.sku) || left.name.localeCompare(right.name)
  );

  return {
    generatedAt: snapshot.generatedAt,
    complete: true,
    stableSnapshotAttempts: snapshot.stableSnapshotAttempts,
    completedStockCountsScanned: snapshot.completedStockCountsScanned,
    countSheetsScanned: snapshot.countSheetsScanned,
    countLinesScanned: snapshot.countLinesScanned,
    uniqueCountedProducts: snapshot.memberships.size,
    productsWithoutPhoto,
  };
}

function loadCredentials(): RestCredentials {
  const config = loadServiceConfig("inflow-inventory-manager", {
    schema: InFlowRestConfigSchema,
  });
  const env = {
    ...(config.mcpServer.env ?? {}),
    ...process.env,
  };
  const apiKey = env.INFLOW_API_KEY;
  const companyId = env.INFLOW_COMPANY_ID;
  if (!apiKey || !companyId) {
    throw new Error("inFlow REST credentials missing: INFLOW_API_KEY and INFLOW_COMPANY_ID are required");
  }
  return { apiKey, companyId };
}

export async function fetchStockNoPhotoReport(): Promise<StockNoPhotoReport> {
  return buildStockNoPhotoReport(loadCredentials());
}

export async function fetchCountedProductCatalogueReport(): Promise<CountedProductCatalogueReport> {
  return buildCountedProductCatalogueReport(loadCredentials());
}
