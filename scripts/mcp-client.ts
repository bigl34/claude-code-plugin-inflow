/**
 * inFlow Inventory MCP Client
 *
 * Wrapper client for the inFlow Cloud API via MCP server.
 * Handles products, stock levels, orders, transfers, and serial number tracking.
 * Configuration from config.json with INFLOW_API_KEY and INFLOW_COMPANY_ID env vars.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MCPConfig {
  mcpServer: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

// Initialize cache with namespace
// Stock levels use short TTL (5 min), products use longer (15 min)
const cache = new PluginCache({
  namespace: "inflow-inventory-manager",
  defaultTTL: TTL.FIVE_MINUTES,
});

export class InFlowMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPConfig;
  private connected: boolean = false;
  private cacheDisabled: boolean = false;

  constructor() {
    // When compiled, __dirname is dist/, so look in parent for config.json
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /**
   * Disables caching for all subsequent requests.
   */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /**
   * Re-enables caching after it was disabled.
   */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /**
   * Returns cache statistics including hit/miss counts.
   */
  getCacheStats() {
    return cache.getStats();
  }

  /**
   * Clears all cached data.
   * @returns Number of cache entries cleared
   */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates a specific cache entry by key.
   * @param key - The cache key to invalidate
   * @returns true if entry was found and removed
   */
  invalidateCacheKey(key: string): boolean {
    return cache.invalidate(key);
  }

  // ============================================
  // CONNECTION MANAGEMENT
  // ============================================

  /**
   * Establishes connection to the MCP server.
   * Called automatically by other methods when needed.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const env = {
      ...process.env,
      ...this.config.mcpServer.env,
    };

    // Ensure required env vars are set
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
      { name: "inflow-cli", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /**
   * Disconnects from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  /**
   * Lists available MCP tools.
   * @returns Array of tool definitions
   */
  async listTools(): Promise<any[]> {
    await this.connect();
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Calls an MCP tool with arguments.
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Parsed tool response
   * @throws {Error} If tool call fails
   */
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

  // ============================================
  // PRODUCT OPERATIONS
  // ============================================

  /**
   * Lists products with optional filtering and pagination.
   *
   * @param options - Filter and pagination options
   * @param options.limit - Maximum products to return
   * @param options.skip - Number of products to skip (pagination)
   * @param options.filter - Smart search query (searches name, SKU, etc.)
   * @param options.categoryId - Filter by category ID
   * @param options.categoryName - Filter by category name
   * @returns Paginated product list
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const products = await client.listProducts({ filter: "Product A", limit: 20 });
   */
  async listProducts(options?: {
    limit?: number;
    skip?: number;
    filter?: string;
    categoryId?: string;
    categoryName?: string;
  }): Promise<any> {
    const cacheKey = createCacheKey("products", {
      limit: options?.limit,
      skip: options?.skip,
      filter: options?.filter,
      categoryId: options?.categoryId,
      categoryName: options?.categoryName,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const args: Record<string, any> = {};
        if (options?.limit) args.count = options.limit;
        if (options?.skip) args.skip = options.skip;
        if (options?.filter) args.smart = options.filter;
        if (options?.categoryId) args.categoryId = options.categoryId;
        if (options?.categoryName) args.categoryName = options.categoryName;
        return this.callTool("list_products", args);
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single product by ID.
   *
   * @param productId - inFlow product ID
   * @param options - Additional options
   * @param options.include - Related data to include (e.g., ["itemBoms", "locations"])
   * @returns Product object with requested includes
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const product = await client.getProduct("prod_123", { include: ["itemBoms"] });
   */
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

  /**
   * Searches products by name, SKU, or description.
   *
   * @param query - Search query
   * @returns Array of matching products
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const results = await client.searchProducts("product");
   */
  async searchProducts(query: string): Promise<any> {
    const cacheKey = createCacheKey("products_search", { query });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_products", { smart: query }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // BILL OF MATERIALS
  // ============================================

  /**
   * Retrieves bill of materials (components) for a product.
   *
   * @param productId - Product ID to get BOM for
   * @returns Bill of materials with component list
   *
   * @cached TTL: 1 hour
   *
   * @example
   * const bom = await client.getBillOfMaterials("prod_123");
   */
  async getBillOfMaterials(productId: string): Promise<any> {
    const cacheKey = createCacheKey("bom", { productId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_bill_of_materials", { productId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // CATEGORIES
  // ============================================

  /**
   * Lists all product categories.
   *
   * @returns Array of category objects
   *
   * @cached TTL: 1 hour
   */
  async listCategories(): Promise<any> {
    return cache.getOrFetch(
      "categories",
      () => this.callTool("list_categories", { count: 100 }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a product with its bill of materials included.
   *
   * @param productId - Product ID
   * @returns Product with itemBoms field populated
   *
   * @cached TTL: 15 minutes
   */
  async getProductWithBom(productId: string): Promise<any> {
    const cacheKey = createCacheKey("product_bom", { productId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_product", { productId, include: ["itemBoms"] }),
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // STOCK & INVENTORY
  // ============================================

  /**
   * Gets stock levels/inventory summary for a product.
   *
   * @param productId - Product ID (required)
   * @returns Inventory summary with quantities per location
   * @throws {Error} If productId not provided
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const stock = await client.getStockLevels("prod_123");
   */
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
   * Gets stock by location (not directly supported).
   *
   * @throws {Error} Always throws - use listProducts + getStockLevels instead
   * @deprecated Use listProducts then getStockLevels for each product
   */
  async getStockByLocation(locationId?: string): Promise<any> {
    throw new Error("Stock by location requires listing products first, then calling get-stock-levels for each. This command is not directly supported.");
  }

  // ============================================
  // STOCK ADJUSTMENTS
  // ============================================

  /**
   * Lists stock adjustment records.
   *
   * @param options - Filter options
   * @param options.limit - Maximum adjustments to return
   * @returns Array of stock adjustments
   *
   * @cached TTL: 5 minutes
   */
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

  /**
   * Creates a stock adjustment to add or remove inventory.
   *
   * @param data - Adjustment data
   * @param data.locationId - Location ID for the adjustment
   * @param data.reasonId - Adjustment reason ID
   * @param data.items - Array of items to adjust
   * @param data.items[].productId - Product ID
   * @param data.items[].quantity - Quantity to adjust (positive to add, negative to remove)
   * @param data.items[].sublocation - Optional sublocation
   * @param data.items[].serialNumbers - Serial numbers/serial numbers for serialized items
   * @param data.items[].unitCost - Unit cost for costing
   * @param data.remarks - Notes for the adjustment
   * @param data.adjustmentDate - Date of adjustment (ISO 8601)
   * @returns Created adjustment object
   *
   * @invalidates stock/*
   *
   * @example
   * await client.createStockAdjustment({
   *   locationId: "loc_warehouse",
   *   items: [{ productId: "prod_123", quantity: 5 }],
   *   remarks: "Received stock"
   * });
   */
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
    const result = await this.callTool("upsert_stock_adjustment", data);
    // Invalidate stock caches after mutation
    cache.invalidatePattern(/^stock/);
    return result;
  }

  /**
   * Retrieves a single stock adjustment by ID.
   *
   * @param adjustmentId - Adjustment ID
   * @returns Stock adjustment object
   *
   * @cached TTL: 5 minutes
   */
  async getStockAdjustment(adjustmentId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_adjustment", { id: adjustmentId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_adjustment", { adjustmentId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // STOCK TRANSFERS
  // ============================================

  /**
   * Lists stock transfer records.
   *
   * @param options - Filter options
   * @param options.limit - Maximum transfers to return
   * @param options.status - Filter by status
   * @param options.fromLocationId - Filter by source location
   * @param options.toLocationId - Filter by destination location
   * @returns Array of stock transfers
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const transfers = await client.listStockTransfers({ status: "Pending" });
   */
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
        if (options?.limit) args.count = options.limit;
        if (options?.status) args.status = options.status;
        if (options?.fromLocationId) args.fromLocationId = options.fromLocationId;
        if (options?.toLocationId) args.toLocationId = options.toLocationId;
        return this.callTool("list_stock_transfers", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single stock transfer by ID.
   *
   * @param transferId - Transfer ID
   * @returns Stock transfer object
   *
   * @cached TTL: 5 minutes
   */
  async getStockTransfer(transferId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_transfer", { id: transferId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_transfer", { transferId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a stock transfer between locations.
   *
   * @param data - Transfer data
   * @param data.fromLocationId - Source location ID
   * @param data.toLocationId - Destination location ID
   * @param data.items - Array of items to transfer
   * @param data.items[].productId - Product ID
   * @param data.items[].quantity - Quantity to transfer
   * @param data.items[].fromSublocation - Source sublocation
   * @param data.items[].toSublocation - Destination sublocation
   * @param data.items[].serialNumbers - Serial numbers for serialized items
   * @param data.remarks - Notes for the transfer
   * @param data.transferDate - Date of transfer (ISO 8601)
   * @returns Created transfer object
   *
   * @invalidates stock/*
   *
   * @example
   * await client.createStockTransfer({
   *   fromLocationId: "loc_warehouse",
   *   toLocationId: "loc_showroom",
   *   items: [{ productId: "prod_123", quantity: 2 }]
   * });
   */
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
    const result = await this.callTool("upsert_stock_transfer", data);
    // Invalidate stock caches after mutation
    cache.invalidatePattern(/^stock/);
    return result;
  }

  // ============================================
  // STOCK COUNTS
  // ============================================

  /**
   * Lists stock count records (physical inventory counts).
   *
   * @param options - Filter options
   * @param options.limit - Maximum counts to return
   * @param options.status - Filter by status
   * @param options.locationId - Filter by location
   * @returns Array of stock counts
   *
   * @cached TTL: 5 minutes
   */
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
        if (options?.limit) args.count = options.limit;
        if (options?.status) args.status = options.status;
        if (options?.locationId) args.locationId = options.locationId;
        return this.callTool("list_stock_counts", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single stock count by ID.
   *
   * @param stockCountId - Stock count ID
   * @returns Stock count object
   *
   * @cached TTL: 5 minutes
   */
  async getStockCount(stockCountId: string): Promise<any> {
    const cacheKey = createCacheKey("stock_count", { id: stockCountId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_stock_count", { stockCountId }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Creates a new stock count (physical inventory count).
   *
   * @param data - Stock count data
   * @param data.locationId - Location to count
   * @param data.remarks - Notes for the count
   * @param data.countDate - Date of count (ISO 8601)
   * @returns Created stock count object
   *
   * @invalidates stock/*
   */
  async createStockCount(data: {
    locationId: string;
    remarks?: string;
    countDate?: string;
  }): Promise<any> {
    const result = await this.callTool("upsert_stock_count", data);
    // Invalidate stock caches after mutation
    cache.invalidatePattern(/^stock/);
    return result;
  }

  // ============================================
  // ADJUSTMENT REASONS
  // ============================================

  /**
   * Lists available stock adjustment reasons.
   *
   * @returns Array of adjustment reason objects
   *
   * @cached TTL: 1 hour
   */
  async listAdjustmentReasons(): Promise<any> {
    return cache.getOrFetch(
      "adjustment_reasons",
      () => this.callTool("list_adjustment_reasons", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // SALES ORDERS
  // ============================================

  /**
   * Lists sales orders with optional filtering.
   *
   * @param options - Filter options
   * @param options.limit - Maximum orders to return
   * @param options.skip - Number of orders to skip (pagination)
   * @param options.status - Filter by status
   * @param options.include - Related data to include (e.g., ["lines"])
   * @returns Array of sales orders
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const orders = await client.listSalesOrders({ status: "Open", limit: 50 });
   */
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
        if (options?.limit) args.count = options.limit;
        if (options?.skip) args.skip = options.skip;
        if (options?.status) args.status = options.status;
        if (options?.include) args.include = options.include;
        return this.callTool("list_sales_orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single sales order by ID.
   *
   * @param orderId - Sales order ID
   * @param options - Additional options
   * @param options.include - Related data to include (e.g., ["lines"])
   * @returns Sales order object
   *
   * @cached TTL: 5 minutes
   *
   * @example
   * const order = await client.getSalesOrder("so_123", { include: ["lines"] });
   */
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

  /**
   * Searches sales orders by query.
   *
   * @param query - Search query (searches order number, customer, etc.)
   * @returns Array of matching sales orders
   *
   * @cached TTL: 5 minutes
   */
  async searchSalesOrders(query: string): Promise<any> {
    const cacheKey = createCacheKey("sales_orders_search", { query });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("list_sales_orders", { smart: query }),
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // PURCHASE ORDERS
  // ============================================

  /**
   * Lists purchase orders with optional filtering.
   *
   * @param options - Filter options
   * @param options.limit - Maximum orders to return
   * @param options.skip - Number of orders to skip (pagination)
   * @param options.status - Filter by status
   * @param options.include - Related data to include (e.g., ["lines"])
   * @returns Array of purchase orders
   *
   * @cached TTL: 5 minutes
   */
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
        if (options?.limit) args.count = options.limit;
        if (options?.skip) args.skip = options.skip;
        if (options?.status) args.status = options.status;
        if (options?.include) args.include = options.include;
        return this.callTool("list_purchase_orders", args);
      },
      { ttl: TTL.FIVE_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single purchase order by ID.
   *
   * @param orderId - Purchase order ID
   * @param options - Additional options
   * @param options.include - Related data to include (e.g., ["lines"])
   * @returns Purchase order object
   *
   * @cached TTL: 5 minutes
   */
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

  // ============================================
  // LOCATIONS
  // ============================================

  /**
   * Lists all warehouse locations.
   *
   * @returns Array of location objects
   *
   * @cached TTL: 1 hour
   */
  async listLocations(): Promise<any> {
    return cache.getOrFetch(
      "locations",
      () => this.callTool("list_locations", {}),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Retrieves a single location by ID.
   *
   * @param locationId - Location ID
   * @returns Location object
   *
   * @cached TTL: 1 hour
   */
  async getLocation(locationId: string): Promise<any> {
    const cacheKey = createCacheKey("location", { id: locationId });

    return cache.getOrFetch(
      cacheKey,
      () => this.callTool("get_location", { locationId }),
      { ttl: TTL.HOUR, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // SERIAL NUMBERS (serial numbers) - ORDER-BASED
  // ============================================

  // Note: inFlow has NO direct serial search API. We fetch orders with include=lines and extract serialNumbers.
  // The serial index is built from fulfilled sales orders and cached for 1 hour.

  /**
   * Extracts serial numbers/serial numbers from a specific sales order.
   *
   * @param orderId - Sales order ID
   * @returns Object with order info and extracted serial numbers
   *
   * @example
   * const result = await client.getSalesOrderSerials("so_123");
   * // Returns: { salesOrderId, orderNumber, serialCount, serials: [...] }
   */
  async getSalesOrderSerials(orderId: string): Promise<any> {
    const order = await this.getSalesOrder(orderId, {
      include: ['lines', 'pickLines', 'packLines']
    });

    // Track serial numbers with all sources where they appear
    const serialMap = new Map<string, { serial: string; productId: string; sources: string[] }>();

    // Helper to extract serial numbers from a line array
    // Priority: packLines (most authoritative) > pickLines > lines
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

    // Check all three sources (packLines most authoritative for fulfilled orders)
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

  /**
   * Extracts serial numbers/serial numbers from a specific purchase order.
   *
   * @param orderId - Purchase order ID
   * @returns Object with order info and extracted serial numbers
   */
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

  /**
   * Builds serial index from fulfilled sales orders.
   *
   * This is an expensive operation - fetches all fulfilled orders to build the index.
   * Results are cached for 1 hour. Uses plain object for cache serialization compatibility.
   *
   * @param options - Build options
   * @param options.status - Order status to index (default: "Fulfilled")
   * @param options.limit - Maximum orders to process
   * @returns serial → order mapping object
   *
   * @cached TTL: 1 hour (via searchSerial)
   */
  async buildSerialIndex(options?: {
    status?: string;
    limit?: number;
  }): Promise<Record<string, any>> {
    const status = options?.status || 'Fulfilled';
    const maxOrders = options?.limit;

    // Fetch all orders with specified status
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

    // Build serial -> order mapping (using plain object for cache compatibility)
    const serialIndex: Record<string, any> = {};

    // Helper to extract serial numbers from a line array
    const extractFromLines = (lines: any[], order: any) => {
      for (const line of lines || []) {
        const serialNumbers = line.quantity?.serialNumbers;
        if (!Array.isArray(serialNumbers)) continue;

        for (const serial of serialNumbers) {
          if (!serial) continue;
          const normalizedSerial = serial.trim().toUpperCase();
          // Only add if not already present (first source wins, packLines checked first)
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
      // Check all three sources (packLines most authoritative for fulfilled orders)
      extractFromLines(order.packLines, order);
      extractFromLines(order.pickLines, order);
      extractFromLines(order.lines, order);
    }

    return serialIndex;
  }

  /**
   * Searches for a serial number across fulfilled sales orders.
   *
   * Builds/uses cached serial index. For faster product-based lookup,
   * use searchSerialByProduct() instead.
   *
   * @param serial - serial number to search for
   * @returns Object with found status and order details if found
   *
   * @cached TTL: 1 hour (index is cached)
   *
   * @example
   * const result = await client.searchSerial("L9EXXX12345");
   * if (result.found) {
   *   console.log(result.salesOrderId, result.orderNumber);
   * }
   */
  async searchSerial(serial: string): Promise<any> {
    const cacheKey = "serial_index";

    // Get or build the serial index
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

  /**
   * Lists all serial numbers from fulfilled orders with optional filtering.
   *
   * @param options - Filter options
   * @param options.limit - Maximum serial numbers to return
   * @param options.productId - Filter by product ID
   * @returns Object with count and serial numbers array
   *
   * @cached TTL: 1 hour (index is cached)
   */
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

    // Filter by product if specified
    if (options?.productId) {
      serials = serials.filter(v => v.productId === options.productId);
    }

    // Apply limit
    if (options?.limit && options.limit < serials.length) {
      serials = serials.slice(0, options.limit);
    }

    return {
      count: serials.length,
      totalInIndex: Object.keys(serialIndex).length,
      serials,
    };
  }

  // ============================================
  // SERIAL NUMBERS (serial numbers) - PRODUCT-BASED
  // ============================================

  /**
   * Gets all serials (serial numbers) for a specific product using inventoryLines.
   *
   * Much faster than order-based lookup. Returns serials with stock status.
   *
   * @param productId - Product ID
   * @returns Object with serials array including stock status per serial
   *
   * @cached TTL: 15 minutes
   *
   * @example
   * const serials = await client.getProductSerials("prod_123");
   */
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

  /**
   * Lists all serials (serial numbers) across ALL products that track serials.
   *
   * Uses inventoryLines for fast retrieval.
   *
   * @param options - Filter options
   * @param options.maxProducts - Maximum products to scan
   * @param options.inStockOnly - Only return serials currently in stock
   * @returns Object with serials array
   *
   * @cached TTL: 15 minutes
   */
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

  /**
   * Builds serial index from products using inventoryLines (faster than order-based).
   *
   * @param options - Build options
   * @param options.maxProducts - Maximum products to scan
   * @returns serial → product mapping object
   *
   * @cached TTL: 15 minutes (via searchSerialByProduct)
   */
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

  /**
   * Searches for a serial number using product-based index (faster than order-based).
   *
   * Note: Does NOT return order info - use searchSerial() for order details.
   *
   * @param serial - serial number to search for
   * @returns Object with found status and product/stock details if found
   *
   * @cached TTL: 15 minutes (index is cached)
   *
   * @example
   * const result = await client.searchSerialByProduct("L9EXXX12345");
   * if (result.found) {
   *   console.log(result.productName, result.inStock);
   * }
   */
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

  // ============================================
  // LEGACY METHODS
  // ============================================

  /**
   * @deprecated Use listSerials() instead
   */
  async listSerialNumbers(options?: { productId?: string; limit?: number }): Promise<any> {
    return this.listSerials(options);
  }

  /**
   * @deprecated Use searchSerial() instead
   */
  async getSerialNumber(serialNumber: string): Promise<any> {
    return this.searchSerial(serialNumber);
  }

  /**
   * @deprecated Use searchSerial() instead
   */
  async searchSerialNumbers(query: string): Promise<any> {
    return this.searchSerial(query);
  }

  // ============================================
  // CUSTOMERS & VENDORS
  // ============================================

  /**
   * Lists customers.
   *
   * @param options - Filter options
   * @param options.limit - Maximum customers to return
   * @returns Array of customer objects
   *
   * @cached TTL: 15 minutes
   */
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

  /**
   * Lists vendors/suppliers.
   *
   * @param options - Filter options
   * @param options.limit - Maximum vendors to return
   * @returns Array of vendor objects
   *
   * @cached TTL: 15 minutes
   */
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

  // ============================================
  // PRODUCT WRITE OPERATIONS
  // ============================================

  /**
   * Creates a new product or updates an existing one.
   *
   * @param data - Product data
   * @param data.id - Product ID (for updates, omit for create)
   * @param data.name - Product name (required)
   * @param data.sku - Product SKU
   * @param data.description - Product description
   * @param data.categoryId - Category ID
   * @param data.cost - Unit cost
   * @param data.defaultPrice - Default selling price
   * @param data.barcode - Product barcode
   * @param data.reorderPoint - Reorder point quantity
   * @param data.reorderQuantity - Reorder quantity
   * @param data.weight - Product weight
   * @param data.weightUnit - Weight unit (kg, lb, etc.)
   * @param data.isActive - Whether product is active
   * @param data.customFields - Custom field values
   * @param data.timestamp - Required for updates (optimistic locking)
   * @returns Created/updated product object
   *
   * @invalidates products, product:*, products_search, product_bom, bom
   *
   * @example
   * // Create a new product
   * await client.upsertProduct({ name: "HDPE Pallet", sku: "PALLET-001", cost: 72 });
   *
   * // Update existing product (must include timestamp)
   * await client.upsertProduct({ id: "prod_123", name: "Updated Name", timestamp: "..." });
   */
  async upsertProduct(data: {
    id?: string;
    name: string;
    sku?: string;
    description?: string;
    categoryId?: string;
    cost?: number;
    defaultPrice?: number;
    barcode?: string;
    reorderPoint?: number;
    reorderQuantity?: number;
    weight?: number;
    weightUnit?: string;
    isActive?: boolean;
    customFields?: Record<string, unknown>;
    timestamp?: string;
  }): Promise<any> {
    const result = await this.callTool("upsert_product", data);
    // Comprehensive cache invalidation (per Codex review)
    cache.invalidatePattern(/^products/);
    cache.invalidatePattern(/^product:/);
    cache.invalidatePattern(/^products_search/);
    cache.invalidatePattern(/^product_bom/);
    cache.invalidatePattern(/^bom/);
    return result;
  }

  // ============================================
  // VENDOR WRITE OPERATIONS
  // ============================================

  /**
   * Gets a single vendor by ID (bypasses cache for fresh timestamp).
   *
   * Required for update operations to get current timestamp for optimistic locking.
   *
   * @param vendorId - Vendor ID
   * @returns Vendor object with current timestamp
   */
  async getVendor(vendorId: string): Promise<any> {
    // Always bypass cache to get fresh timestamp for updates
    return this.callTool("get_vendor", { vendorId });
  }

  /**
   * Creates a new vendor or updates an existing one.
   *
   * @param data - Vendor data
   * @param data.id - Vendor ID (for updates, omit for create)
   * @param data.name - Vendor name (required)
   * @param data.email - Email address
   * @param data.phone - Phone number
   * @param data.fax - Fax number
   * @param data.website - Website URL
   * @param data.address - Address object
   * @param data.paymentTermsId - Payment terms ID
   * @param data.currencyCode - Currency code (GBP, USD, etc.)
   * @param data.contacts - Array of contact objects
   * @param data.customFields - Custom field values
   * @param data.isActive - Whether vendor is active
   * @param data.timestamp - Required for updates (optimistic locking)
   * @returns Created/updated vendor object
   *
   * @invalidates vendors
   *
   * @example
   * // Create a new vendor
   * await client.upsertVendor({
   *   name: "Example Supplier Co",
   *   email: "sales@example.com",
   *   address: { city: "Qingdao", country: "China" },
   *   currencyCode: "USD"
   * });
   */
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
    const result = await this.callTool("upsert_vendor", data);
    cache.invalidatePattern(/^vendors/);
    return result;
  }

  // ============================================
  // PURCHASE ORDER WRITE OPERATIONS
  // ============================================

  /**
   * Creates a new purchase order or updates an existing one.
   *
   * @param data - Purchase order data
   * @param data.id - PO ID (for updates, omit for create)
   * @param data.vendorId - Vendor ID (required)
   * @param data.orderNumber - PO number (auto-generated if omitted)
   * @param data.orderDate - Order date (ISO format)
   * @param data.expectedDate - Expected delivery date
   * @param data.locationId - Destination warehouse ID
   * @param data.items - Array of line items (required)
   * @param data.shippingAddress - Shipping address object
   * @param data.currencyCode - Currency code
   * @param data.remarks - Notes/remarks
   * @param data.customFields - Custom field values
   * @param data.timestamp - Required for updates (optimistic locking)
   * @returns Created/updated purchase order object
   *
   * @invalidates purchase_orders, purchase_order:*
   *
   * @example
   * await client.upsertPurchaseOrder({
   *   vendorId: "vendor_123",
   *   items: [{ productId: "prod_456", quantity: 100, unitCost: 72 }],
   *   currencyCode: "USD",
   *   remarks: "Alibaba order #123"
   * });
   */
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
    const result = await this.callTool("upsert_purchase_order", data);
    // Comprehensive cache invalidation (per Codex review)
    cache.invalidatePattern(/^purchase_orders/);
    cache.invalidatePattern(/^purchase_order:/);
    return result;
  }

  /**
   * Receive items on a purchase order (partial or full).
   *
   * Uses GET→modify→minimal PUT pattern. Supports receiving specific lines
   * by purchaseOrderLineId or productId, or receiving all remaining with receiveAll.
   *
   * @param data.purchaseOrderId - PO ID (required)
   * @param data.receiveAll - Receive all remaining qty on every line
   * @param data.items - Specific lines to receive (mutually exclusive with receiveAll)
   * @param data.allowOverReceive - Allow receiving more than ordered
   * @returns Summary with per-line received quantities
   *
   * @invalidates purchase_orders, purchase_order:*, stock*
   */
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
    const result = await this.callTool("receive_purchase_order", data);
    cache.invalidatePattern(/^purchase_orders/);
    cache.invalidatePattern(/^purchase_order:/);
    cache.invalidatePattern(/^stock/);
    return result;
  }

  /**
   * Unreceive items from a purchase order (reverse stock).
   *
   * Removes receive line entries from the PO's receiveLines[] array via PUT,
   * which reverses the stock that was added when the items were received.
   *
   * Supports three modes (mutually exclusive):
   * - receiveLineIds: Remove specific receive lines by ID
   * - items: Remove by product+quantity using LIFO (newest first)
   * - unreceiveAll: Remove all receive lines
   *
   * @param data.purchaseOrderId - PO ID (required)
   * @param data.receiveLineIds - Specific receive line IDs to remove
   * @param data.items - Products to unreceive by quantity (LIFO)
   * @param data.unreceiveAll - Remove ALL receive lines
   * @param data.dryRun - Preview without making changes
   * @returns Summary of removed/modified receive lines
   *
   * @invalidates purchase_orders, purchase_order:*, stock* (unless dryRun)
   */
  async unreceivePurchaseOrder(data: {
    purchaseOrderId: string;
    receiveLineIds?: string[];
    items?: Array<{ productId: string; quantity: number }>;
    unreceiveAll?: boolean;
    dryRun?: boolean;
  }): Promise<any> {
    const result = await this.callTool("unreceive_purchase_order", data);
    if (!data.dryRun) {
      cache.invalidatePattern(/^purchase_orders/);
      cache.invalidatePattern(/^purchase_order:/);
      cache.invalidatePattern(/^stock/);
    }
    return result;
  }

  /**
   * Gets company information (not available via MCP).
   *
   * @throws {Error} Always throws - company ID is set via INFLOW_COMPANY_ID env var
   * @deprecated Company info not available via MCP
   */
  async getCompanyInfo(): Promise<any> {
    throw new Error("Company info endpoint is not available via MCP. Company ID is set via INFLOW_COMPANY_ID environment variable.");
  }
}

export default InFlowMCPClient;
