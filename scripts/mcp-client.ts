
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadServiceConfig, z } from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { DirtyTagQuarantine } from "./mutation-cache.js";

const InFlowConfigSchema = z.object({
  mcpServer: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
});

type MCPConfig = z.infer<typeof InFlowConfigSchema>;

const LEGACY_WRITE_REPLACEMENTS: Record<string, string> = {
  upsert_product: "set_product",
  upsert_sales_order: "set_sales_order",
  upsert_purchase_order: "set_purchase_order",
  receive_purchase_order: "set_purchase_order_receipts",
  unreceive_purchase_order: "set_purchase_order_receipts",
  upsert_customer: "set_customer",
  upsert_vendor: "set_vendor",
  upsert_stock_adjustment: "set_stock_adjustment",
  upsert_stock_transfer: "set_stock_transfer",
  upsert_stock_count: "set_stock_count",
  upsert_manufacturing_order: "set_manufacturing_order",
  upsert_taxing_scheme: "set_taxing_scheme",
  upsert_webhook: "set_webhook",
  delete_webhook: "remove_webhook",
};

export interface ManufacturingComponentInput {
  itemBomId?: string;
  childProductId: string;
  quantity: string | number;
  uomQuantity?: string | number;
  uom?: string | null;
}

export interface ManufacturingOperationInput {
  productOperationId?: string;
  operationTypeId: string;
  lineNum?: number;
  cost?: string | number | null;
  estimatedPerHourCost?: string | number | null;
  estimatedSeconds?: string | number | null;
  instructions?: string;
  trackTime?: boolean;
}

export interface ExplicitMutationConfirmationScope {
  schemaVersion: "explicit-confirmation-scope/v1";
  tenantFingerprint: string;
  baseHost: string;
  apiVersion: string;
  serverBuildIdentity: string;
  operation: string;
  resourceType: string;
  resourceId: string | null;
  mode: string;
  adapterVersion: string;
  serializerVersion: string;
  contractVersion: string;
  currentSemanticHash: string | null;
  currentWriteShapeHash: string | null;
  entityTimestamp: string | null;
  sourceHashes: Array<{ name: string; hash: string }>;
  desiredHash: string;
}

export interface ExplicitMutationConfirmation {
  scope: ExplicitMutationConfirmationScope;
  confirmationHash: string;
}

export interface ManufacturingConfigRequest {
  productId: string;
  mode?: "patch" | "replace";
  components?: ManufacturingComponentInput[];
  removeItemBomIds?: string[];
  productOperations?: ManufacturingOperationInput[];
  removeProductOperationIds?: string[];
  autoAssemble?: boolean;
  includeQuantityBuildable?: boolean;
  allowInactiveComponents?: boolean;
  expectedConfigHash?: string;
  expectedProductTimestamp?: string;
  dryRun?: boolean;
  previewToken?: string;
  idempotencyKey?: string;
  expectedSemanticHash?: string;
  expectedWriteShapeHash?: string;
  expectedEntityTimestamp?: string;
  expectedDesiredHash?: string;
  confirmation?: ExplicitMutationConfirmation;
  operationId?: string;
}

export interface MutationResult {
  operationId: string;
  idempotencyKey?: string;
  previewToken?: string;
  applicationState: string;
  cacheInvalidationRequired?: boolean;
  applied?: boolean | "unknown";
  appliedMayBeTrue?: boolean;
  verified?: boolean;
  currentSemanticHash?: string;
  currentWriteShapeHash?: string;
  entityTimestamp?: string;
  desiredHash?: string;
  confirmationScope?: ExplicitMutationConfirmationScope;
  confirmationHash?: string;
  confirmationValidated?: boolean;
  invalidationTags?: string[];
  [key: string]: unknown;
}

interface ManufacturingConfigMutationEnvelope {
  cacheInvalidationRequired?: boolean;
  appliedMayBeTrue?: boolean;
  applied?: boolean | "unknown";
  applicationState?: string;
  operationId?: string;
  actual?: { productVariant?: { productGroupId?: unknown } };
  before?: { productVariant?: { productGroupId?: unknown } };
  [key: string]: unknown;
}

function compactDefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactDefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, compactDefined(child)]),
    );
  }
  return value;
}

export interface MinimalMcpClient {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: unknown;
    isError?: boolean;
  }>;
  listTools(): Promise<{ tools: unknown[] }>;
  close(): Promise<void>;
}

export interface RecentProductsResult {
  data: Array<Record<string, unknown>>;
  activeProductNames: Array<{ productId: string; name: string; isActive: true }>;
  since: string;
  before: string;
  activeOnly: boolean;
  complete: true;
  cacheBypassed: true;
  providerPageSize: number;
  requiredConsecutiveStableScans: number;
  scanAttempts: number;
  pageCounts: number[];
  recordsFetchedPerScan: number[];
  uniqueProductsPerScan: number[];
  duplicateRecordsPerScan: number[];
  finalUniqueProductsScanned: number;
  inactiveProductsExcluded: number;
  outOfWindowProductsExcluded: number;
  invalidIsActiveCount: 0;
  invalidCreatedDateCount: 0;
  nameCatalogueComplete: true;
  invalidNameCount: 0;
}

export interface ProductNameCatalogueResult {
  data: Array<{ productId: string; name: string; isActive: boolean }>;
  activeOnly: boolean;
  complete: true;
  cacheBypassed: true;
  providerPageSize: number;
  requiredConsecutiveStableScans: number;
  scanAttempts: number;
  pageCounts: number[];
  recordsFetchedPerScan: number[];
  uniqueProductsPerScan: number[];
  duplicateRecordsPerScan: number[];
  finalUniqueProductsScanned: number;
  inactiveProductsExcluded: number;
  invalidIsActiveCount: 0;
  invalidNameCount: 0;
}

export interface ProductListPagination {
  returnedCount: number;
  totalCount: number | null;
  totalCountKnown: boolean;
  complete: boolean;
  hasMore: boolean | null;
  nextSkip: number | null;
  startSkip: number;
  requestedLimit: number | null;
  paginationMode: "offset";
}

export interface ProductListResult {
  data: any[];
  totalCount?: number;
  pagination: ProductListPagination;
  [key: string]: unknown;
}

export type BulkBomReadItem =
  | { productId: string; status: "ok"; bom: unknown }
  | { productId: string; status: "error"; error: string };

export interface BulkBomReadResult {
  status: "complete" | "partial" | "failed";
  complete: boolean;
  requestedProductCount: number;
  succeededProductCount: number;
  failedProductCount: number;
  concurrency: number;
  requestIntervalMs: number;
  maxAttemptsPerProduct: number;
  results: BulkBomReadItem[];
}

interface CompleteProductScan {
  products: Array<Record<string, unknown>>;
  pageCount: number;
  recordsFetched: number;
  duplicateRecords: number;
  fingerprint: string;
}

const PRODUCT_PROVIDER_PAGE_SIZE = 100;
const RECENT_PRODUCT_STABLE_SCANS_REQUIRED = 2;
const RECENT_PRODUCT_MAX_SCAN_ATTEMPTS = 3;
const RECENT_PRODUCT_MAX_PAGES_PER_SCAN = 10_000;
const BULK_BOM_REQUEST_INTERVAL_MS = 5_000;
const BULK_BOM_MAX_ATTEMPTS_PER_PRODUCT = 3;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isEmptyBomRead(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;

  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const content = item as { type?: unknown; text?: unknown };
    return content.type === "text" &&
      typeof content.text === "string" &&
      content.text.trim() === "";
  });
}

function parseIsoInstant(value: string, fieldName: string): number {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  const parsed = Date.parse(value);
  if (!parts || !Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO 8601 date-time with an explicit UTC offset`);
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = parts;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(`${fieldName} must be a valid ISO 8601 date-time with an explicit UTC offset`);
  }
  return parsed;
}

const cache = new PluginCache({
  namespace: "inflow-inventory-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class InFlowMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private explicitlyCacheDisabled: boolean = false;
  private injectedClient: MinimalMcpClient | null;
  private readonly quarantine: DirtyTagQuarantine;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  private get cacheDisabled(): boolean {
    return this.explicitlyCacheDisabled || this.quarantine.hasDirtyState();
  }

  private set cacheDisabled(value: boolean) {
    this.explicitlyCacheDisabled = value;
  }

  constructor(opts?: {
    client?: MinimalMcpClient;
    config?: MCPConfig;
    quarantinePath?: string;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.injectedClient = opts?.client ?? null;
    this.quarantine = new DirtyTagQuarantine(opts?.quarantinePath);
    this.now = opts?.now ?? Date.now;
    this.sleep = opts?.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));

    if (opts?.config) {
      this.config = opts.config;
    } else if (opts?.client) {
      this.config = { mcpServer: { command: "", args: [] } };
    } else {
      this.config = loadServiceConfig("inflow-inventory-manager", {
        schema: InFlowConfigSchema,
      });
    }
  }


  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  private cacheBypass(tags: string[]): boolean {
    return this.cacheDisabled || this.quarantine.hasAny(tags);
  }

  private invalidateTags(tags: string[]): void {
    for (const tag of tags) cache.invalidate(tag);
    if (tags.some((tag) => tag.startsWith("product:") || tag.startsWith("prices:"))) {
      cache.invalidatePattern(/^products(?:\?|_|$)/);
      cache.invalidatePattern(/^product(?:\?|:|_|$)/);
    }
    if (tags.some((tag) => tag.startsWith("bom:") || tag.startsWith("product:"))) {
      cache.invalidatePattern(/^bom(?::|-compare:)/);
      cache.invalidatePattern(/^product_bom/);
    }
    if (tags.some((tag) => tag.startsWith("product-group:") || tag.startsWith("group-qty:"))) {
      cache.invalidatePattern(/^product-group/);
      cache.invalidatePattern(/^group-qty:/);
      cache.invalidatePattern(/^group-audit:/);
    }
    if (tags.some((tag) => tag.startsWith("inventory") || tag.startsWith("mo:"))) {
      cache.invalidatePattern(/^stock/);
      cache.invalidatePattern(/^mo-trace:/);
      cache.invalidatePattern(/^bom-requirements:/);
    }
    if (tags.some((tag) => tag.startsWith("vendor:"))) {
      cache.invalidatePattern(/^vendors(?:\?|_|$)/);
    }
    if (tags.some((tag) => tag.startsWith("purchase-order:"))) {
      cache.invalidatePattern(/^purchase_orders(?:\?|_|$)/);
      cache.invalidatePattern(/^purchase_order(?:\?|:|_|$)/);
    }
  }

  private handleMutationResult(result: MutationResult, fallbackTags: string[]): MutationResult {
    const tags = result.invalidationTags?.length ? result.invalidationTags : fallbackTags;
    const invalidate = result.cacheInvalidationRequired ?? result.appliedMayBeTrue ?? result.applied === true;
    if (invalidate) this.invalidateTags(tags);
    if (["applied_unverified", "unknown_after_write", "partial_applied"].includes(result.applicationState)) {
      this.quarantine.record(result.operationId, tags, result.applicationState);
    } else if (["applied_verified", "no_op"].includes(result.applicationState)) {
      this.quarantine.clear(result.operationId);
    }
    return result;
  }

  private isCertainlyPreDispatchError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:^|\b)(?:MUTATION_CONFLICT|MUTATION_PRECONDITION_REQUIRED|PREVIEW_TOKEN_SCOPE_MISMATCH|PREVIEW_TOKEN_REQUIRED|INVALID_PREVIEW_TOKEN|EXPIRED_PREVIEW_TOKEN|IDEMPOTENCY_KEY_CONFLICT|USER_CONFIRMATION_(?:REQUIRED|SCOPE_MISMATCH)|UNSUPPORTED_API_VERSION|UNSUPPORTED_WRITE_SEMANTICS|OPERATION_UNSUPPORTED|ATTESTATION_(?:MISSING|INVALID|EXPIRED|READ_FAILED)|BUILD_IDENTITY_MISSING|ENVIRONMENT_GATE_DISABLED|UNSAFE_ATTESTATION_(?:FILE|DIRECTORY)|[A-Z0-9_]*WRITES_DISABLED)(?::|\b)/.test(message);
  }

  private handleApplyException(error: unknown, operationId: string | undefined, tags: string[]): never {
    if (!this.isCertainlyPreDispatchError(error)) {
      this.invalidateTags(tags);
      this.quarantine.record(operationId || `lost-${Date.now()}`, tags, "unknown_after_write");
    }
    throw error;
  }

  async previewThenApply(
    tool: string,
    request: Record<string, unknown>,
    apply: boolean,
    conservativeTags: string[],
  ): Promise<MutationResult> {
    const preview = await this.callTool(tool, { ...request, dryRun: true }) as MutationResult;
    if (!apply) return preview;
    return this.applyFromPreview(tool, request, preview, conservativeTags);
  }

  private async applyFromPreview(
    tool: string,
    request: Record<string, unknown>,
    preview: MutationResult,
    conservativeTags: string[],
  ): Promise<MutationResult> {
    const serverConfirmation =
      preview.confirmationScope &&
      typeof preview.confirmationHash === "string" &&
      /^[a-f0-9]{64}$/.test(preview.confirmationHash)
        ? {
            confirmation: {
              scope: preview.confirmationScope,
              confirmationHash: preview.confirmationHash,
            },
          }
        : {};
    const applyRequest = {
      ...request,
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
      ...serverConfirmation,
    };
    try {
      return this.handleMutationResult(await this.callTool(tool, applyRequest) as MutationResult, conservativeTags);
    } catch (error) {
      return this.handleApplyException(error, preview.operationId, conservativeTags);
    }
  }


  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.establishConnection();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async establishConnection(): Promise<void> {
    if (this.connected) return;

    if (this.injectedClient) {
      this.client = this.injectedClient as unknown as Client;
      this.connected = true;
      return;
    }

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    if (!env.INFLOW_API_KEY) {
      throw new Error(
        "INFLOW_API_KEY environment variable is not set. " +
        "Please export it in your shell or add it to ~/.bashrc"
      );
    }
    if (!env.INFLOW_COMPANY_ID) {
      throw new Error(
        "INFLOW_COMPANY_ID environment variable is not set. " +
        "Please export it in your shell or add it to ~/.bashrc"
      );
    }

    this.transport = new StdioClientTransport({
      command: this.config.mcpServer.command,
      args: this.config.mcpServer.args,
      env: env as Record<string, string>,
    });

    this.client = new Client(
      { name: "inflow-cli", version: "1.14.1" },
      { capabilities: {} }
    );

    try {
      await this.client.connect(this.transport);
      this.connected = true;
    } catch (error) {
      this.client = null;
      this.transport = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  private async callListToolPaged(
    name: string,
    baseArgs: Record<string, unknown>,
    requestedLimit: number | undefined,
    startSkip: number
  ): Promise<unknown> {
    const PROVIDER_MAX_PAGE_SIZE = 100;

    const needsPaging = requestedLimit !== undefined && requestedLimit > PROVIDER_MAX_PAGE_SIZE;
    if (!needsPaging) {
      const singlePageArgs = { ...baseArgs };
      if (requestedLimit !== undefined) singlePageArgs.count = requestedLimit;
      if (startSkip > 0) singlePageArgs.skip = startSkip;
      return this.callTool(name, singlePageArgs);
    }

    let firstPageEnvelope: unknown = null;
    const collected: unknown[] = [];
    let skip = startSkip;
    const seenPageFingerprints = new Set<string>();
    const seenPageStartFingerprints = new Set<string>();

    while (collected.length < requestedLimit) {
      const remaining = requestedLimit - collected.length;
      const pageSize = Math.min(remaining, PROVIDER_MAX_PAGE_SIZE);

      let page: unknown;
      try {
        page = await this.callTool(name, { ...baseArgs, count: pageSize, skip });
      } catch (error) {
        if (collected.length === 0) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${name}: paging failed after ${collected.length} of ${requestedLimit} requested records ` +
            `(page starting at skip=${skip}): ${reason}`
        );
      }

      if (firstPageEnvelope === null) firstPageEnvelope = page;

      const pageItems = this.itemsFromListResponse(page);
      if (pageItems.length === 0) break;

      const pageFingerprint = stableJson(pageItems);
      const pageStartFingerprint = stableJson(pageItems[0]);
      if (
        seenPageFingerprints.has(pageFingerprint) ||
        seenPageStartFingerprints.has(pageStartFingerprint)
      ) {
        throw new Error(
          `${name}: provider returned an identical page at skip=${skip}, so paging cannot advance. ` +
            `Collected ${collected.length} records before stopping.`
        );
      }
      seenPageFingerprints.add(pageFingerprint);
      seenPageStartFingerprints.add(pageStartFingerprint);

      collected.push(...pageItems);

      if (pageItems.length < pageSize) break;
      skip += pageItems.length;
    }

    const trimmed = collected.slice(0, requestedLimit);
    return this.withListItems(firstPageEnvelope, trimmed);
  }

  private itemsFromListResponse(response: unknown): unknown[] {
    const maybeEnvelope = response as { data?: unknown } | null | undefined;
    const payload = maybeEnvelope?.data ?? response ?? [];
    return Array.isArray(payload) ? payload : [payload];
  }

  private withListItems(templateResponse: unknown, items: unknown[]): unknown {
    const isEnvelope =
      templateResponse !== null &&
      typeof templateResponse === "object" &&
      !Array.isArray(templateResponse) &&
      "data" in templateResponse;

    if (!isEnvelope) return items;
    return { ...(templateResponse as Record<string, unknown>), data: items };
  }

  private withProductListPagination(
    response: unknown,
    requestedLimit: number | undefined,
    startSkip: number
  ): ProductListResult {
    const data = this.itemsFromListResponse(response);
    const envelope =
      response !== null && typeof response === "object" && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : {};
    const rawTotalCount = envelope.totalCount;
    const { totalCount: _unvalidatedTotalCount, ...safeEnvelope } = envelope;
    const numericTotalCount =
      typeof rawTotalCount === "number" &&
      Number.isSafeInteger(rawTotalCount) &&
      rawTotalCount >= 0
        ? rawTotalCount
        : null;
    const endSkip = startSkip + data.length;
    const totalCount =
      numericTotalCount !== null &&
      (data.length === 0 || numericTotalCount >= endSkip)
        ? numericTotalCount
        : null;
    const totalCountKnown = totalCount !== null;
    const hasMore = totalCountKnown ? endSkip < totalCount : null;

    return {
      ...safeEnvelope,
      data,
      ...(totalCountKnown ? { totalCount } : {}),
      pagination: {
        returnedCount: data.length,
        totalCount,
        totalCountKnown,
        complete: totalCountKnown && startSkip === 0 && data.length >= totalCount,
        hasMore,
        nextSkip: hasMore === false || data.length === 0 ? null : endSkip,
        startSkip,
        requestedLimit: requestedLimit ?? null,
        paginationMode: "offset",
      },
    };
  }

  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    await this.connect();

    const result = await this.client!.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;

    if (result.isError) {
      const errorContent = content.find((c) => c.type === "text");
      throw new Error(errorContent?.text || "Tool call failed");
    }

    const textContent = content.find((c) => c.type === "text");
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }

    return content;
  }

  async callLegacyWriteTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    console.error(JSON.stringify({
      level: "warn",
      severity: "high",
      event: "inflow_legacy_write_tool",
      tool: name,
      safeWriteBypass: true,
      masterGateApplies: false,
      migrationRequired: true,
      replacement: LEGACY_WRITE_REPLACEMENTS[name] ?? "no_safe_replacement_registered",
      message: "LEGACY WRITE BYPASS: this immediate write is not controlled by INFLOW_ENABLE_SAFE_WRITES; migrate to the preview-first replacement before the 2.0 removal window.",
    }));
    return this.callTool(name, args);
  }


  async listProducts(options?: {
    limit?: number;
    skip?: number;
    filter?: string;
    categoryId?: string;
    categoryName?: string;
    include?: string[];
    includeCount?: boolean;
  }): Promise<ProductListResult> {
    const cacheKey = createCacheKey("products", {
      limit: options?.limit,
      skip: options?.skip,
      filter: options?.filter,
      categoryId: options?.categoryId,
      categoryName: options?.categoryName,
      include: options?.include?.length
        ? [...options.include].sort().join(",")
        : undefined,
      includeCount: options?.includeCount,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.filter) args.smart = options.filter;
        if (options?.categoryId) args.categoryId = options.categoryId;
        if (options?.categoryName) args.categoryName = options.categoryName;
        if (options?.include?.length) args.include = options.include;
        if (options?.includeCount !== undefined) args.includeCount = options.includeCount;
        const startSkip = options?.skip ?? 0;
        const response = await this.callListToolPaged(
          "list_products",
          args,
          options?.limit,
          startSkip
        );
        return this.withProductListPagination(response, options?.limit, startSkip);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async listRecentProducts(options: {
    since: string;
    before: string;
    activeOnly?: boolean;
  }): Promise<RecentProductsResult> {
    const sinceMs = parseIsoInstant(options.since, "since");
    const beforeMs = parseIsoInstant(options.before, "before");
    if (sinceMs >= beforeMs) {
      throw new Error("since must be earlier than before");
    }

    const activeOnly = options.activeOnly ?? true;
    const { stableScan, scans } = await this.stableCompleteProductScans();

    const invalidActiveStates = stableScan.products.filter(
      (product) => typeof product.isActive !== "boolean"
    );
    if (invalidActiveStates.length > 0) {
      const productIds = invalidActiveStates
        .slice(0, 5)
        .map((product) => String(product.productId));
      throw new Error(
        `list_products: exhaustive active-product filtering is incomplete because ` +
          `${invalidActiveStates.length} product(s) have a missing or invalid isActive flag ` +
          `(product IDs: ${productIds.join(", ")})`
      );
    }
    const eligibleProducts = activeOnly
      ? stableScan.products.filter((product) => product.isActive === true)
      : stableScan.products;
    const activeProducts = stableScan.products.filter((product) => product.isActive === true);
    const invalidNames = activeProducts.filter(
      (product) =>
        typeof product.name !== "string" ||
        product.name.trim() === "" ||
        product.name.includes("\0") ||
        product.name.length > 1000
    );
    if (invalidNames.length > 0) {
      const productIds = invalidNames.slice(0, 5).map((product) => String(product.productId));
      throw new Error(
        `list_products: exhaustive active-name catalogue is incomplete because ` +
          `${invalidNames.length} active product(s) have a missing or invalid name ` +
          `(product IDs: ${productIds.join(", ")})`
      );
    }
    const activeProductNames = activeProducts
      .map((product) => ({
        productId: product.productId as string,
        name: product.name as string,
        isActive: true as const,
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId));
    const productsWithCreatedDates: Array<{
      product: Record<string, unknown>;
      createdMs: number;
    }> = [];
    const invalidCreatedDates: Array<Record<string, unknown>> = [];
    for (const product of eligibleProducts) {
      if (typeof product.createdDttm !== "string") {
        invalidCreatedDates.push(product);
        continue;
      }
      try {
        productsWithCreatedDates.push({
          product,
          createdMs: parseIsoInstant(product.createdDttm, "createdDttm"),
        });
      } catch {
        invalidCreatedDates.push(product);
      }
    }
    if (invalidCreatedDates.length > 0) {
      const productIds = invalidCreatedDates
        .slice(0, 5)
        .map((product) => String(product.productId));
      throw new Error(
        `list_products: exhaustive recent-product filtering is incomplete because ` +
          `${invalidCreatedDates.length} eligible product(s) have a missing or invalid createdDttm ` +
          `(product IDs: ${productIds.join(", ")})`
      );
    }

    const matchingProducts = productsWithCreatedDates
      .filter(({ createdMs }) => createdMs >= sinceMs && createdMs < beforeMs)
      .sort((left, right) => {
        const createdDifference = left.createdMs - right.createdMs;
        if (createdDifference !== 0) return createdDifference;
        return String(left.product.productId).localeCompare(String(right.product.productId));
      })
      .map(({ product, createdMs }) => ({
        ...product,
        createdDate: new Date(createdMs).toISOString(),
        modifiedDate: product.lastModifiedDateTime,
      }));

    return {
      data: matchingProducts,
      activeProductNames,
      since: new Date(sinceMs).toISOString(),
      before: new Date(beforeMs).toISOString(),
      activeOnly,
      complete: true,
      cacheBypassed: true,
      providerPageSize: PRODUCT_PROVIDER_PAGE_SIZE,
      requiredConsecutiveStableScans: RECENT_PRODUCT_STABLE_SCANS_REQUIRED,
      scanAttempts: scans.length,
      pageCounts: scans.map((scan) => scan.pageCount),
      recordsFetchedPerScan: scans.map((scan) => scan.recordsFetched),
      uniqueProductsPerScan: scans.map((scan) => scan.products.length),
      duplicateRecordsPerScan: scans.map((scan) => scan.duplicateRecords),
      finalUniqueProductsScanned: stableScan.products.length,
      inactiveProductsExcluded: activeOnly
        ? stableScan.products.length - eligibleProducts.length
        : 0,
      outOfWindowProductsExcluded: eligibleProducts.length - matchingProducts.length,
      invalidIsActiveCount: 0,
      invalidCreatedDateCount: 0,
      nameCatalogueComplete: true,
      invalidNameCount: 0,
    };
  }

  async listProductNames(options?: {
    activeOnly?: boolean;
  }): Promise<ProductNameCatalogueResult> {
    const activeOnly = options?.activeOnly ?? true;
    const { stableScan, scans } = await this.stableCompleteProductScans();

    const invalidActiveStates = stableScan.products.filter(
      (product) => typeof product.isActive !== "boolean"
    );
    if (invalidActiveStates.length > 0) {
      const productIds = invalidActiveStates
        .slice(0, 5)
        .map((product) => String(product.productId));
      throw new Error(
        `list_products: exhaustive product-name catalogue is incomplete because ` +
          `${invalidActiveStates.length} product(s) have a missing or invalid isActive flag ` +
          `(product IDs: ${productIds.join(", ")})`
      );
    }

    const eligibleProducts = activeOnly
      ? stableScan.products.filter((product) => product.isActive === true)
      : stableScan.products;
    const invalidNames = eligibleProducts.filter(
      (product) =>
        typeof product.name !== "string" ||
        product.name.trim() === "" ||
        product.name.includes("\0") ||
        product.name.length > 1000
    );
    if (invalidNames.length > 0) {
      const productIds = invalidNames
        .slice(0, 5)
        .map((product) => String(product.productId));
      throw new Error(
        `list_products: exhaustive product-name catalogue is incomplete because ` +
          `${invalidNames.length} eligible product(s) have a missing or invalid name ` +
          `(product IDs: ${productIds.join(", ")})`
      );
    }

    const data = eligibleProducts
      .map((product) => ({
        productId: product.productId as string,
        name: product.name as string,
        isActive: product.isActive as boolean,
      }))
      .sort((left, right) => left.productId.localeCompare(right.productId));

    return {
      data,
      activeOnly,
      complete: true,
      cacheBypassed: true,
      providerPageSize: PRODUCT_PROVIDER_PAGE_SIZE,
      requiredConsecutiveStableScans: RECENT_PRODUCT_STABLE_SCANS_REQUIRED,
      scanAttempts: scans.length,
      pageCounts: scans.map((scan) => scan.pageCount),
      recordsFetchedPerScan: scans.map((scan) => scan.recordsFetched),
      uniqueProductsPerScan: scans.map((scan) => scan.products.length),
      duplicateRecordsPerScan: scans.map((scan) => scan.duplicateRecords),
      finalUniqueProductsScanned: stableScan.products.length,
      inactiveProductsExcluded: activeOnly
        ? stableScan.products.length - eligibleProducts.length
        : 0,
      invalidIsActiveCount: 0,
      invalidNameCount: 0,
    };
  }

  private async stableCompleteProductScans(): Promise<{
    stableScan: CompleteProductScan;
    scans: CompleteProductScan[];
  }> {
    const scans: CompleteProductScan[] = [];
    for (let attempt = 1; attempt <= RECENT_PRODUCT_MAX_SCAN_ATTEMPTS; attempt += 1) {
      const scan = await this.scanAllProducts(attempt);
      scans.push(scan);
      const previous = scans.at(-2);
      if (previous?.fingerprint === scan.fingerprint) {
        return { stableScan: scan, scans };
      }
    }
    throw new Error(
      `list_products: catalogue did not produce ${RECENT_PRODUCT_STABLE_SCANS_REQUIRED} ` +
        `consecutive matching exhaustive scans within ${RECENT_PRODUCT_MAX_SCAN_ATTEMPTS} attempts`
    );
  }

  private async scanAllProducts(attempt: number): Promise<CompleteProductScan> {
    const productsById = new Map<string, Record<string, unknown>>();
    let pageCount = 0;
    let recordsFetched = 0;
    let duplicateRecords = 0;
    let skip = 0;

    while (pageCount < RECENT_PRODUCT_MAX_PAGES_PER_SCAN) {
      let rawPage: unknown;
      try {
        rawPage = await this.callTool("list_products", {
          count: PRODUCT_PROVIDER_PAGE_SIZE,
          skip,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `list_products: exhaustive scan ${attempt} failed on page ${pageCount + 1} ` +
            `(skip=${skip}): ${reason}`
        );
      }

      const pageItems = this.strictListItems(rawPage, attempt, pageCount + 1, skip);
      pageCount += 1;
      if (pageItems.length === 0) break;
      if (pageItems.length > PRODUCT_PROVIDER_PAGE_SIZE) {
        throw new Error(
          `list_products: exhaustive scan ${attempt} returned ${pageItems.length} records ` +
            `on page ${pageCount}; provider page maximum is ${PRODUCT_PROVIDER_PAGE_SIZE}`
        );
      }

      const uniqueCountBeforePage = productsById.size;
      recordsFetched += pageItems.length;
      for (const rawProduct of pageItems) {
        if (!rawProduct || typeof rawProduct !== "object" || Array.isArray(rawProduct)) {
          throw new Error(
            `list_products: exhaustive scan ${attempt} page ${pageCount} contains a non-object product`
          );
        }
        const product = rawProduct as Record<string, unknown>;
        if (
          typeof product.productId !== "string" ||
          product.productId.trim() === "" ||
          product.productId !== product.productId.trim()
        ) {
          throw new Error(
            `list_products: exhaustive scan ${attempt} page ${pageCount} contains a product without a valid productId`
          );
        }

        const existing = productsById.get(product.productId);
        if (existing) {
          duplicateRecords += 1;
          if (stableJson(product) !== stableJson(existing)) {
            throw new Error(
              `list_products: exhaustive scan ${attempt} observed conflicting records for ` +
                `productId ${product.productId} on page ${pageCount}`
            );
          }
        } else {
          productsById.set(product.productId, product);
        }
      }

      if (productsById.size === uniqueCountBeforePage) {
        throw new Error(
          `list_products: exhaustive scan ${attempt} made no product-ID progress on page ${pageCount} ` +
            `(skip=${skip}); refusing an incomplete result`
        );
      }

      if (pageItems.length < PRODUCT_PROVIDER_PAGE_SIZE) break;
      skip += pageItems.length;
    }

    if (pageCount >= RECENT_PRODUCT_MAX_PAGES_PER_SCAN) {
      throw new Error(
        `list_products: exhaustive scan ${attempt} exceeded the safety limit of ` +
          `${RECENT_PRODUCT_MAX_PAGES_PER_SCAN} pages without reaching the end`
      );
    }

    const products = [...productsById.values()].sort((left, right) =>
      String(left.productId).localeCompare(String(right.productId))
    );
    const fingerprint = stableJson({
      products,
      pageCount,
      recordsFetched,
      duplicateRecords,
    });
    return { products, pageCount, recordsFetched, duplicateRecords, fingerprint };
  }

  private strictListItems(
    response: unknown,
    attempt: number,
    page: number,
    skip: number
  ): unknown[] {
    const payload =
      response && typeof response === "object" && !Array.isArray(response) && "data" in response
        ? (response as { data: unknown }).data
        : response;
    if (!Array.isArray(payload)) {
      throw new Error(
        `list_products: exhaustive scan ${attempt} received a malformed page ${page} ` +
          `(skip=${skip}); expected an array or { data: [] } envelope`
      );
    }
    return payload;
  }

  async getProduct(productId: string, options?: { include?: string[] }): Promise<any> {
    const cacheKey = createCacheKey("product", {
      id: productId,
      include: options?.include?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { productId };
        if (options?.include) args.include = options.include;
        return this.callTool("get_product", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async searchProducts(query: string): Promise<any> {
    const cacheKey = createCacheKey("products_search", { query });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_products", { smart: query }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async getBillOfMaterials(
    productId: string,
    options?: { bypassCache?: boolean }
  ): Promise<any> {
    const cacheKey = `bom:${productId}`;

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_bill_of_materials", { productId }),
      {
        ttl: TTL.FIFTEEN_MINUTES,
        bypassCache:
          options?.bypassCache === true ||
          this.cacheBypass([`bom:${productId}`, `product:${productId}`]),
      }
    );
  }

  async getBillsOfMaterials(
    productIds: string[]
  ): Promise<BulkBomReadResult> {
    if (productIds.length < 2 || productIds.length > 25) {
      throw new Error("getBillsOfMaterials requires 2-25 product IDs");
    }
    if (productIds.some((productId) => productId.trim() === "")) {
      throw new Error("getBillsOfMaterials requires non-empty product IDs");
    }
    if (new Set(productIds).size !== productIds.length) {
      throw new Error("getBillsOfMaterials requires unique product IDs");
    }

    await this.connect();

    const results = new Array<BulkBomReadItem>(productIds.length);
    let nextRequestNotBefore = this.now();

    for (let index = 0; index < productIds.length; index += 1) {
      const productId = productIds[index];
      let lastError: unknown;

      for (let attempt = 1; attempt <= BULK_BOM_MAX_ATTEMPTS_PER_PRODUCT; attempt += 1) {
        const waitMs = Math.max(0, nextRequestNotBefore - this.now());
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }

        const requestStartedAt = this.now();
        nextRequestNotBefore = requestStartedAt + BULK_BOM_REQUEST_INTERVAL_MS;

        try {
          const bom = await this.getBillOfMaterials(productId, {
            bypassCache: true,
          });
          if (isEmptyBomRead(bom)) {
            cache.invalidate(`bom:${productId}`);
            throw new Error(`Empty BOM response for product ${productId}`);
          }
          results[index] = { productId, status: "ok", bom };
          break;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const retryable = /(?:\b429\b|rate[ -]?limit|empty BOM response)/iu.test(message);
          if (retryable) {
            const backoffMs = BULK_BOM_REQUEST_INTERVAL_MS * (2 ** (attempt - 1));
            nextRequestNotBefore = Math.max(
              nextRequestNotBefore,
              this.now() + backoffMs
            );
            if (attempt < BULK_BOM_MAX_ATTEMPTS_PER_PRODUCT) {
              continue;
            }
          }

          results[index] = { productId, status: "error", error: message };
          break;
        }
      }

      if (!results[index]) {
        results[index] = {
          productId,
          status: "error",
          error: lastError instanceof Error ? lastError.message : String(lastError),
        };
      }
    }

    const succeededProductCount = results.filter(
      (result) => result.status === "ok"
    ).length;
    const failedProductCount = results.length - succeededProductCount;
    const status = failedProductCount === 0
      ? "complete"
      : succeededProductCount === 0
        ? "failed"
        : "partial";

    return {
      status,
      complete: status === "complete",
      requestedProductCount: productIds.length,
      succeededProductCount,
      failedProductCount,
      concurrency: 1,
      requestIntervalMs: BULK_BOM_REQUEST_INTERVAL_MS,
      maxAttemptsPerProduct: BULK_BOM_MAX_ATTEMPTS_PER_PRODUCT,
      results,
    };
  }

  async compareProductBoms(productIds: string[]): Promise<unknown> {
    const ids = [...productIds].sort();
    const cacheKey = `bom-compare:${ids.join(",")}`;
    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("compare_product_boms", { productIds: ids }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheBypass(ids.map((id) => `bom:${id}`)) }
    );
  }

  async listProductGroups(options?: {
    skip?: number;
    count?: number;
    sort?: string;
    sortDesc?: boolean;
    includeCount?: boolean;
  }): Promise<unknown> {
    const cacheKey = createCacheKey("product-groups", options ?? {});
    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_product_groups", options ?? {}),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getProductGroup(productGroupId: string): Promise<unknown> {
    const cacheKey = `product-group:${productGroupId}`;
    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_product_group", { productGroupId }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheBypass([`product-group:${productGroupId}`]) }
    );
  }

  async getProductGroupVariantQuantities(
    productGroupId: string,
    locationId: string
  ): Promise<unknown> {
    const cacheKey = `group-qty:${productGroupId}:${locationId}`;
    return cache.getOrFetch(
      cacheKey,
      () =>
        this.callTool("get_product_group_variant_quantities", {
          productGroupId,
          locationId,
        }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheBypass([`group-qty:${productGroupId}`]) }
    );
  }

  async setProductManufacturingConfig(
    request: ManufacturingConfigRequest
  ): Promise<unknown> {
    const fallbackTags = [`product:${request.productId}`, `bom:${request.productId}`];
    const { operationId, ...toolRequest } = request;
    let result: ManufacturingConfigMutationEnvelope;
    try {
      result = await this.callTool("set_product_manufacturing_config", toolRequest);
    } catch (error) {
      if (request.dryRun === false) this.handleApplyException(error, operationId, fallbackTags);
      throw error;
    }
    if (result?.cacheInvalidationRequired === true || result?.appliedMayBeTrue === true || result?.applied === true) {
      const escapedId = request.productId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      cache.invalidate(`bom:${request.productId}`);
      cache.invalidatePattern(
        `^bom-compare:(?:[^,]+,)*${escapedId}(?:,|$)`
      );
      cache.invalidatePattern(
        `^product\\?id=${escapedId}(?:&|$)`
      );
      cache.invalidate(
        createCacheKey("product_bom", { productId: request.productId })
      );
      cache.invalidatePattern(/^products(?:\?|_|$)/);
      cache.invalidate(createCacheKey("stock", { productId: request.productId }));

      const groupId =
        result?.actual?.productVariant?.productGroupId ??
        result?.before?.productVariant?.productGroupId;
      if (typeof groupId === "string" && groupId.length > 0) {
        cache.invalidatePattern(`^group-qty:${groupId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
      }
    }
    if (result?.applicationState && result?.operationId) {
      this.handleMutationResult(result as MutationResult, fallbackTags);
    }
    return result;
  }

  async getMcpStatus(probeApi = false): Promise<unknown> {
    return this.callTool("get_mcp_status", { probeApi });
  }

  async getMutationStatus(operationId: string, reconcile = false): Promise<unknown> {
    const result = await this.callTool("get_mutation_status", { operationId, reconcile });
    const state = result?.mutation?.applicationState ?? result?.applicationState ?? result?.record?.state;
    if (["applied_verified", "no_op", "not_applied", "conflict"].includes(state)) {
      this.quarantine.clear(operationId);
    }
    return result;
  }

  async listOperationTypes(options: Record<string, unknown> = {}): Promise<unknown> {
    const key = createCacheKey("operation-types", { request: JSON.stringify(options) });
    return cache.getOrFetch(key, () => this.callTool("list_operation_types", options), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass(["operation-types"]),
    });
  }

  async getOperationType(operationTypeId: string): Promise<unknown> {
    const key = `operation-type:${operationTypeId}`;
    return cache.getOrFetch(key, () => this.callTool("get_operation_type", { operationTypeId }), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass([key]),
    });
  }

  async getProductPrices(productId: string): Promise<unknown> {
    const key = `prices:${productId}`;
    return cache.getOrFetch(key, () => this.callTool("get_product_prices", { productId }), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass([key, `product:${productId}`]),
    });
  }

  async setProductPrices(request: Record<string, unknown>, apply = false): Promise<MutationResult> {
    const productId = String(request.productId);
    return this.previewThenApply("set_product_prices", request, apply, [`product:${productId}`, `prices:${productId}`]);
  }

  async copyProductManufacturingConfig(request: Record<string, unknown>): Promise<MutationResult> {
    const targetId = String(request.targetProductId);
    const operationId = typeof request.operationId === "string"
      ? request.operationId
      : undefined;
    const { operationId: _operationId, ...toolRequest } = request;
    try {
      const result = await this.callTool(
        "copy_product_manufacturing_config",
        toolRequest,
      ) as MutationResult;
      return this.handleMutationResult(result, [
        `product:${targetId}`,
        `bom:${targetId}`,
      ]);
    } catch (error) {
      if (request.dryRun === false) {
        return this.handleApplyException(error, operationId, [
          `product:${targetId}`,
          `bom:${targetId}`,
        ]);
      }
      throw error;
    }
  }

  async auditProductGroupManufacturing(request: Record<string, unknown>): Promise<unknown> {
    const groupId = String(request.productGroupId);
    const key = createCacheKey(`group-audit:${groupId}`, { request: JSON.stringify(request) });
    return cache.getOrFetch(key, () => this.callTool("audit_product_group_manufacturing", request), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass([`product-group:${groupId}`, `group-qty:${groupId}`]),
    });
  }

  async calculateBomRequirements(request: Record<string, unknown>): Promise<unknown> {
    const productId = String(request.productId);
    const key = createCacheKey(`bom-requirements:${productId}`, { request: JSON.stringify(request) });
    return cache.getOrFetch(key, () => this.callTool("calculate_bom_requirements", request), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass([`bom:${productId}`, "inventory:stock"]),
    });
  }

  async getManufacturingOrderTrace(manufacturingOrderId: string): Promise<unknown> {
    const key = `mo-trace:${manufacturingOrderId}`;
    return cache.getOrFetch(key, () => this.callTool("get_manufacturing_order_trace", { manufacturingOrderId }), {
      ttl: TTL.FIFTEEN_MINUTES,
      bypassCache: this.cacheBypass([`mo:${manufacturingOrderId}`, "inventory:serials"]),
    });
  }

  async reconcileManufacturingOrderSerials(request: Record<string, unknown>, apply = false): Promise<MutationResult> {
    const id = String(request.manufacturingOrderId);
    return this.previewThenApply("reconcile_manufacturing_order_serials", request, apply, [`mo:${id}`, "inventory:serials"]);
  }

  async setProductGroupConfig(request: Record<string, unknown>, apply = false): Promise<MutationResult> {
    const id = String(request.productGroupId);
    return this.previewThenApply("set_product_group_config", request, apply, [`product-group:${id}`, `group-qty:${id}`]);
  }

  async createProductGroupVariants(request: Record<string, unknown>, apply = false): Promise<MutationResult> {
    const id = String(request.productGroupId);
    return this.previewThenApply("create_product_group_variants", request, apply, [`product-group:${id}`, `group-qty:${id}`, "products:list"]);
  }

  async safeSet(
    tool: string,
    request: Record<string, unknown>,
    apply = false,
    tags: string[] = [],
    reviewedPreview?: MutationResult,
  ): Promise<MutationResult> {
    if (!apply) return this.previewThenApply(tool, request, false, tags);
    if (!reviewedPreview) {
      await this.previewThenApply(tool, request, false, tags);
      throw new Error(
        "USER_CONFIRMATION_REQUIRED: generic safe-set apply requires a freshly regenerated and externally reviewed preview",
      );
    }
    return this.applyFromPreview(tool, request, reviewedPreview, tags);
  }


  async listCategories(): Promise<any> {
    return cache.getOrFetch(
      "categories",
      () => this.callTool("list_categories", { count: 100 }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async getProductWithBom(productId: string): Promise<any> {
    const cacheKey = createCacheKey("product_bom", { productId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_product", { productId, include: ["itemBoms"] }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async getStockLevels(productId?: string): Promise<any> {
    if (!productId) {
      throw new Error("productId is required for get_inventory_summary. Use list-products first to get product IDs.");
    }

    const cacheKey = createCacheKey("stock", { productId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_inventory_summary", { productId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
 * @deprecated
 */
  async getStockByLocation(locationId?: string): Promise<any> {
    throw new Error("Stock by location requires listing products first, then calling get-stock-levels for each. This command is not directly supported.");
  }


  async listStockAdjustments(options?: { limit?: number }): Promise<any> {
    const cacheKey = createCacheKey("stock_adjustments", { limit: options?.limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.limit) args.limit = options.limit;
        return this.callTool("list_stock_adjustments", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async createStockAdjustment(data: {
    locationId: string;
    reasonId?: string;
    items: Array<{
      productId: string;
      quantity: number;
      sublocation?: string;
      serialNumbers?: string[];
      unitCost?: number;
    }>;
    remarks?: string;
    adjustmentDate?: string;
  }): Promise<any> {
    const values = compactDefined({
      date: data.adjustmentDate,
      locationId: data.locationId,
      adjustmentReasonId: data.reasonId,
      items: data.items,
      remarks: data.remarks,
    }) as Record<string, unknown>;
    return this.previewThenApply(
      "set_stock_adjustment",
      { mode: "replace", values },
      true,
      ["inventory:stock", ...data.items.map((item) => `product:${item.productId}`)],
    );
  }

  async getStockAdjustment(adjustmentId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_adjustment", { id: adjustmentId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_adjustment", { adjustmentId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async listStockTransfers(options?: {
    limit?: number;
    status?: string;
    fromLocationId?: string;
    toLocationId?: string;
  }): Promise<any> {
    const cacheKey = createCacheKey("stock_transfers", {
      limit: options?.limit,
      status: options?.status,
      fromLocationId: options?.fromLocationId,
      toLocationId: options?.toLocationId,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.fromLocationId) args.fromLocationId = options.fromLocationId;
        if (options?.toLocationId) args.toLocationId = options.toLocationId;
        return this.callListToolPaged("list_stock_transfers", args, options?.limit, 0);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getStockTransfer(transferId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_transfer", { id: transferId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_transfer", { transferId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async createStockTransfer(data: {
    fromLocationId: string;
    toLocationId: string;
    items: Array<{
      productId: string;
      quantity: number;
      fromSublocation?: string;
      toSublocation?: string;
      serialNumbers?: string[];
    }>;
    remarks?: string;
    transferDate?: string;
  }): Promise<any> {
    const values = compactDefined({
      transferDate: data.transferDate,
      fromLocationId: data.fromLocationId,
      toLocationId: data.toLocationId,
      items: data.items,
      remarks: data.remarks,
    }) as Record<string, unknown>;
    return this.previewThenApply(
      "set_stock_transfer",
      { mode: "replace", values },
      true,
      ["inventory:stock", ...data.items.map((item) => `product:${item.productId}`)],
    );
  }


  async listStockCounts(options?: {
    limit?: number;
    status?: string;
    locationId?: string;
  }): Promise<any> {
    const cacheKey = createCacheKey("stock_counts", {
      limit: options?.limit,
      status: options?.status,
      locationId: options?.locationId,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.locationId) args.locationId = options.locationId;
        return this.callListToolPaged("list_stock_counts", args, options?.limit, 0);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getStockCount(stockCountId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_count", { id: stockCountId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_count", { stockCountId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async createStockCount(data: {
    locationId: string;
    remarks?: string;
    countDate?: string;
  }): Promise<any> {
    const values = compactDefined({
      countDate: data.countDate,
      locationId: data.locationId,
      remarks: data.remarks,
    }) as Record<string, unknown>;
    return this.previewThenApply(
      "set_stock_count",
      { mode: "replace", values },
      true,
      ["inventory:stock", `location:${data.locationId}`],
    );
  }


  async listAdjustmentReasons(): Promise<any> {
    return cache.getOrFetch(
      "adjustment_reasons",
      () => this.callTool("list_adjustment_reasons", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }


  async listSalesOrders(options?: {
    limit?: number;
    skip?: number;
    status?: string;
    include?: string[];
  }): Promise<any> {
    const cacheKey = createCacheKey("sales_orders", {
      limit: options?.limit,
      skip: options?.skip,
      status: options?.status,
      include: options?.include?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.include) args.include = options.include;
        return this.callListToolPaged("list_sales_orders", args, options?.limit, options?.skip ?? 0);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getSalesOrder(orderId: string, options?: { include?: string[] }): Promise<any> {
    const cacheKey = createCacheKey("sales_order", {
      id: orderId,
      include: options?.include?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { salesOrderId: orderId };
        if (options?.include) args.include = options.include;
        return this.callTool("get_sales_order", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async searchSalesOrders(query: string): Promise<any> {
    const cacheKey = createCacheKey("sales_orders_search", { query });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_sales_orders", { smart: query }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async listPurchaseOrders(options?: {
    limit?: number;
    skip?: number;
    status?: string;
    include?: string[];
  }): Promise<any> {
    const cacheKey = createCacheKey("purchase_orders", {
      limit: options?.limit,
      skip: options?.skip,
      status: options?.status,
      include: options?.include?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.status) args.status = options.status;
        if (options?.include) args.include = options.include;
        return this.callListToolPaged(
          "list_purchase_orders",
          args,
          options?.limit,
          options?.skip ?? 0
        );
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async getPurchaseOrder(orderId: string, options?: { include?: string[] }): Promise<any> {
    const cacheKey = createCacheKey("purchase_order", {
      id: orderId,
      include: options?.include?.join(","),
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = { purchaseOrderId: orderId };
        if (options?.include) args.include = options.include;
        return this.callTool("get_purchase_order", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async listLocations(): Promise<any> {
    return cache.getOrFetch(
      "locations",
      () => this.callTool("list_locations", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  async getLocation(locationId: string): Promise<any> {
    const cacheKey = createCacheKey("location", { id: locationId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_location", { locationId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }



  async getSalesOrderSerials(orderId: string): Promise<any> {
    const order = await this.getSalesOrder(orderId, {
      include: ['lines', 'pickLines', 'packLines']
    });

    const serialMap = new Map<string, { serial: string; productId: string; sources: string[] }>();

    const extractSerials = (lines: any[], source: string) => {
      for (const line of lines || []) {
        const serialNumbers = line.quantity?.serialNumbers;
        if (!Array.isArray(serialNumbers)) continue;

        for (const serial of serialNumbers) {
          if (!serial) continue;

          const existing = serialMap.get(serial);
          if (existing) {
            existing.sources.push(source);
          } else {
            serialMap.set(serial, {
              serial: serial,
              productId: line.productId,
              sources: [source],
            });
          }
        }
      }
    };

    extractSerials(order.packLines, 'pack');
    extractSerials(order.pickLines, 'pick');
    extractSerials(order.lines, 'order');

    const serials = Array.from(serialMap.values());

    return {
      salesOrderId: order.salesOrderId,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: order.inventoryStatus,
      serialCount: serials.length,
      serials,
    };
  }

  async getPurchaseOrderSerials(orderId: string): Promise<any> {
    const order = await this.getPurchaseOrder(orderId, { include: ['lines'] });
    const serials: Array<{ serial: string; productId: string; lineId: string }> = [];

    for (const line of order.lines || []) {
      const serialNumbers = line.quantity?.serialNumbers || [];
      for (const serial of serialNumbers) {
        serials.push({
          serial: serial,
          productId: line.productId,
          lineId: line.purchaseOrderLineId,
        });
      }
    }

    return {
      purchaseOrderId: order.purchaseOrderId,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: order.inventoryStatus,
      serialCount: serials.length,
      serials,
    };
  }

  async buildSerialIndex(options?: {
    status?: string;
    limit?: number;
  }): Promise<Record<string, any>> {
    const status = options?.status || 'Fulfilled';
    const maxOrders = options?.limit;

    const allOrders: any[] = [];
    let skip = 0;
    const pageSize = 100;

    while (true) {
      const result = await this.callTool("list_sales_orders", {
        status,
        include: ['lines', 'pickLines', 'packLines'],
        count: pageSize,
        skip,
      });

      const orders = result.data || result || [];
      const orderList = Array.isArray(orders) ? orders : [orders];
      allOrders.push(...orderList);

      if (orderList.length < pageSize) break;
      if (maxOrders && allOrders.length >= maxOrders) {
        allOrders.length = maxOrders;
        break;
      }
      skip += pageSize;
    }

    const serialIndex: Record<string, any> = {};

    const extractFromLines = (lines: any[], order: any) => {
      for (const line of lines || []) {
        const serialNumbers = line.quantity?.serialNumbers;
        if (!Array.isArray(serialNumbers)) continue;

        for (const serial of serialNumbers) {
          if (!serial) continue;
          const normalizedSerial = serial.trim().toUpperCase();
          if (!serialIndex[normalizedSerial]) {
            serialIndex[normalizedSerial] = {
              serial: normalizedSerial,
              salesOrderId: order.salesOrderId,
              orderNumber: order.orderNumber,
              orderDate: order.orderDate,
              productId: line.productId,
              shopifyOrderUrl: order.customFields?.custom4 || null,
            };
          }
        }
      }
    };

    for (const order of allOrders) {
      extractFromLines(order.packLines, order);
      extractFromLines(order.pickLines, order);
      extractFromLines(order.lines, order);
    }

    return serialIndex;
  }

  async searchSerial(serial: string): Promise<any> {
    const cacheKey = "serial_index";

    const serialIndex = await cache.getOrFetch(
      cacheKey,
      () => this.buildSerialIndex(),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    ) as Record<string, any>;

    const normalizedSerial = serial.trim().toUpperCase();
    const result = serialIndex[normalizedSerial];

    if (result) {
      return {
        found: true,
        ...result,
      };
    }

    return {
      found: false,
      serial: normalizedSerial,
      message: "Serial number not found in fulfilled sales orders. Check Airtable for authoritative serial number data.",
    };
  }

  async listSerials(options?: {
    limit?: number;
    productId?: string;
  }): Promise<any> {
    const cacheKey = "serial_index";

    const serialIndex = await cache.getOrFetch(
      cacheKey,
      () => this.buildSerialIndex(),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    ) as Record<string, any>;

    let serials = Object.values(serialIndex);

    if (options?.productId) {
      serials = serials.filter(v => v.productId === options.productId);
    }

    if (options?.limit && options.limit < serials.length) {
      serials = serials.slice(0, options.limit);
    }

    return {
      count: serials.length,
      totalInIndex: Object.keys(serialIndex).length,
      serials,
    };
  }


  async getProductSerials(productId: string): Promise<any> {
    const cacheKey = createCacheKey("product_serials", { productId });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        return this.callTool("get_product_serials", { productId });
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async listAllSerials(options?: {
    maxProducts?: number;
    inStockOnly?: boolean;
  }): Promise<any> {
    const cacheKey = createCacheKey("all_serials", {
      maxProducts: options?.maxProducts,
      inStockOnly: options?.inStockOnly,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.maxProducts) args.maxProducts = options.maxProducts;
        if (options?.inStockOnly) args.inStockOnly = options.inStockOnly;
        return this.callTool("list_all_serials", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async buildSerialIndexFromProducts(options?: {
    maxProducts?: number;
  }): Promise<Record<string, any>> {
    const result = await this.callTool("list_all_serials", {
      maxProducts: options?.maxProducts || 100,
    });

    const serialIndex: Record<string, any> = {};
    for (const serial of result.serials || []) {
      const normalizedSerial = serial.serial.trim().toUpperCase();
      serialIndex[normalizedSerial] = {
        serial: normalizedSerial,
        productId: serial.productId,
        productName: serial.productName,
        locationId: serial.locationId,
        quantityOnHand: serial.quantityOnHand,
        sublocation: serial.sublocation,
        inStock: serial.inStock,
      };
    }

    return serialIndex;
  }

  async searchSerialByProduct(serial: string): Promise<any> {
    const cacheKey = "serial_index_products";

    const serialIndex = await cache.getOrFetch(
      cacheKey,
      () => this.buildSerialIndexFromProducts(),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    ) as Record<string, any>;

    const normalizedSerial = serial.trim().toUpperCase();
    const result = serialIndex[normalizedSerial];

    if (result) {
      return {
        found: true,
        ...result,
      };
    }

    return {
      found: false,
      serial: normalizedSerial,
      message: "Serial number not found in product inventory. May not exist or may be in a non-serialized product.",
    };
  }


  /**
 * @deprecated
 */
  async listSerialNumbers(options?: { productId?: string; limit?: number }): Promise<any> {
    return this.listSerials(options);
  }

  /**
 * @deprecated
 */
  async getSerialNumber(serialNumber: string): Promise<any> {
    return this.searchSerial(serialNumber);
  }

  /**
 * @deprecated
 */
  async searchSerialNumbers(query: string): Promise<any> {
    return this.searchSerial(query);
  }


  async listCustomers(options?: { limit?: number }): Promise<any> {
    const cacheKey = createCacheKey("customers", { limit: options?.limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.limit) args.limit = options.limit;
        return this.callTool("list_customers", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  async listVendors(options?: { limit?: number }): Promise<any> {
    const cacheKey = createCacheKey("vendors", { limit: options?.limit });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.limit) args.limit = options.limit;
        return this.callTool("list_vendors", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }


  async upsertProduct(data: {
    id?: string;
    name: string;
    sku?: string;
    description?: string;
    categoryId?: string;
    cost?: number;
    defaultPrice?: number;
    prices?: unknown[];
    barcode?: string;
    reorderPoint?: number;
    reorderQuantity?: number;
    weight?: number;
    weightUnit?: string;
    isActive?: boolean;
    customFields?: Record<string, unknown>;
    timestamp?: string;
  }): Promise<any> {
    if (data.defaultPrice !== undefined || data.prices !== undefined) {
      throw new Error(
        "OPERATION_UNSUPPORTED: price fields cannot be mixed into set_product; use setProductPrices explicitly",
      );
    }
    const { id, timestamp: _timestamp, defaultPrice: _defaultPrice, prices: _prices, ...rawValues } = data;
    const values = compactDefined(rawValues) as Record<string, unknown>;
    return this.previewThenApply(
      "set_product",
      { ...(id ? { productId: id } : {}), mode: id ? "patch" : "replace", values },
      true,
      [`product:${id ?? "new"}`, `bom:${id ?? "new"}`],
    );
  }


  async getVendor(vendorId: string): Promise<any> {
    return this.callTool("get_vendor", { vendorId });
  }

  async upsertVendor(data: {
    id?: string;
    name: string;
    email?: string;
    phone?: string;
    fax?: string;
    website?: string;
    address?: {
      street1?: string;
      street2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
    paymentTermsId?: string;
    currencyCode?: string;
    contacts?: Array<{
      name?: string;
      email?: string;
      phone?: string;
      isPrimary?: boolean;
    }>;
    customFields?: Record<string, unknown>;
    isActive?: boolean;
    timestamp?: string;
  }): Promise<any> {
    const { id, timestamp: _timestamp, ...rawValues } = data;
    const values = compactDefined(rawValues) as Record<string, unknown>;
    return this.previewThenApply(
      "set_vendor",
      { ...(id ? { vendorId: id } : {}), mode: id ? "patch" : "replace", values },
      true,
      [`vendor:${id ?? "new"}`],
    );
  }


  async upsertPurchaseOrder(data: {
    id?: string;
    vendorId: string;
    orderNumber?: string;
    orderDate?: string;
    expectedDate?: string;
    locationId?: string;
    items: Array<{
      id?: string;
      productId?: string;
      description?: string;
      quantity: number;
      unitCost?: number;
      taxCodeId?: string;
      sublocation?: string;
      serialNumbers?: string[];
    }>;
    shippingAddress?: {
      street1?: string;
      street2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
    currencyCode?: string;
    remarks?: string;
    customFields?: Record<string, unknown>;
    timestamp?: string;
  }): Promise<any> {
    const values = compactDefined({
      orderNumber: data.orderNumber,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate,
      vendorId: data.vendorId,
      locationId: data.locationId,
      lines: data.items.map((item) => ({
        purchaseOrderLineId: item.id,
        productId: item.productId,
        description: item.description,
        quantity: {
          standardQuantity: item.quantity,
          uomQuantity: item.quantity,
          serialNumbers: item.serialNumbers?.length ? item.serialNumbers : undefined,
        },
        unitPrice: item.unitCost,
        taxCodeId: item.taxCodeId,
        sublocation: item.sublocation,
      })),
      shippingAddress: data.shippingAddress,
      currencyCode: data.currencyCode,
      orderRemarks: data.remarks,
      customFields: data.customFields,
    }) as Record<string, unknown>;
    return this.previewThenApply(
      "set_purchase_order",
      {
        ...(data.id ? { purchaseOrderId: data.id } : {}),
        mode: data.id ? "patch" : "replace",
        values,
      },
      true,
      [`purchase-order:${data.id ?? "new"}`, "inventory:stock"],
    );
  }

  async updatePurchaseOrderHeaders(data: {
    id: string;
    vendorId: string;
    timestamp: string;
    remarks?: string;
    orderDate?: string;
    expectedDate?: string;
    currencyCode?: string;
  }): Promise<unknown> {
    const values = compactDefined({
      vendorId: data.vendorId,
      orderRemarks: data.remarks,
      orderDate: data.orderDate,
      expectedDate: data.expectedDate,
      currencyCode: data.currencyCode,
    }) as Record<string, unknown>;
    return this.previewThenApply(
      "set_purchase_order",
      { purchaseOrderId: data.id, mode: "patch", values },
      true,
      [`purchase-order:${data.id}`, "inventory:stock"],
    );
  }

  async receivePurchaseOrder(data: {
    purchaseOrderId: string;
    receiveAll?: boolean;
    items?: Array<{
      purchaseOrderLineId?: string;
      productId?: string;
      quantity: number;
      serialNumbers?: string[];
    }>;
    allowOverReceive?: boolean;
  }): Promise<any> {
    if (data.receiveAll || !data.items?.length) {
      throw new Error(
        "OPERATION_UNSUPPORTED: safe receipts require explicit items with productId and quantity; receiveAll is not supported",
      );
    }
    if (data.items.some((item) => !item.productId)) {
      throw new Error(
        "OPERATION_UNSUPPORTED: safe receipts cannot resolve purchaseOrderLineId; supply productId explicitly",
      );
    }
    if (data.allowOverReceive) {
      throw new Error(
        "OPERATION_UNSUPPORTED: safe receipts do not support allowOverReceive",
      );
    }
    const receiveLines = data.items.map((item) => compactDefined({
      productId: item.productId,
      quantity: {
        standardQuantity: item.quantity.toFixed(4),
        uomQuantity: item.quantity.toFixed(4),
        serialNumbers: item.serialNumbers?.length ? item.serialNumbers : undefined,
      },
    }) as Record<string, unknown>);
    return this.previewThenApply(
      "set_purchase_order_receipts",
      { purchaseOrderId: data.purchaseOrderId, action: "receive", receiveLines },
      true,
      [`purchase-order:${data.purchaseOrderId}`, "inventory:stock"],
    );
  }

  async unreceivePurchaseOrder(data: {
    purchaseOrderId: string;
    receiveLineIds?: string[];
    items?: Array<{ productId: string; quantity: number }>;
    unreceiveAll?: boolean;
    dryRun?: boolean;
  }): Promise<any> {
    if (data.unreceiveAll || data.items?.length || !data.receiveLineIds?.length) {
      throw new Error(
        "OPERATION_UNSUPPORTED: safe unreceive requires exact receiveLineIds; product-quantity LIFO and unreceiveAll are not supported",
      );
    }
    const receiveLines = data.receiveLineIds.map((purchaseOrderReceiveLineId) => ({
      purchaseOrderReceiveLineId,
    }));
    return this.previewThenApply(
      "set_purchase_order_receipts",
      { purchaseOrderId: data.purchaseOrderId, action: "unreceive", receiveLines },
      data.dryRun !== true,
      [`purchase-order:${data.purchaseOrderId}`, "inventory:stock"],
    );
  }

  /**
 * @deprecated
 */
  async getCompanyInfo(): Promise<any> {
    throw new Error("Company info endpoint is not available via MCP. Company ID is set via INFLOW_COMPANY_ID environment variable.");
  }
}

export default InFlowMCPClient;
