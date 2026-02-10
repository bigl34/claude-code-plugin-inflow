#!/usr/bin/env npx tsx
/**
 * inFlow Inventory Manager CLI
 *
 * Zod-validated CLI for inFlow inventory management via MCP.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { InFlowMCPClient } from "./mcp-client.js";

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => {
      const tools = await client.listTools();
      return tools.map((t: { name: string; description?: string }) => ({
        name: t.name,
        description: t.description,
      }));
    },
    "List all available MCP tools"
  ),

  // ==================== Products ====================
  "list-products": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records to return"),
      skip: cliTypes.int(0).optional().describe("Records to skip (pagination)"),
      filter: z.string().optional().describe("OData filter"),
      categoryId: z.string().optional().describe("Category ID to filter by"),
      category: z.string().optional().describe("Category name to filter by"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, filter, categoryId, category } = args as {
        limit?: number; skip?: number; filter?: string;
        categoryId?: string; category?: string;
      };
      return client.listProducts({ limit, skip, filter, categoryId, categoryName: category });
    },
    "List products with optional category filtering"
  ),

  "get-product": createCommand(
    z.object({ id: z.string().min(1).describe("Product ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getProduct(id);
    },
    "Get product details by ID"
  ),

  "search-products": createCommand(
    z.object({ query: z.string().min(1).describe("Search term") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchProducts(query);
    },
    "Search products by name/SKU"
  ),

  "get-bom": createCommand(
    z.object({ id: z.string().min(1).describe("Product ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getBillOfMaterials(id);
    },
    "Get bill of materials for a manufacturable product"
  ),

  "list-categories": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.listCategories(),
    "List all product categories"
  ),

  // ==================== Stock & Inventory ====================
  "get-stock-levels": createCommand(
    z.object({ productId: z.string().optional().describe("Product ID to filter by") }),
    async (args, client: InFlowMCPClient) => {
      const { productId } = args as { productId?: string };
      return client.getStockLevels(productId);
    },
    "Get current stock quantities"
  ),

  "get-stock-by-location": createCommand(
    z.object({ locationId: z.string().optional().describe("Location ID to filter by") }),
    async (args, client: InFlowMCPClient) => {
      const { locationId } = args as { locationId?: string };
      return client.getStockByLocation(locationId);
    },
    "Get stock breakdown by location"
  ),

  "list-stock-adjustments": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.listStockAdjustments({ limit });
    },
    "List stock adjustment history"
  ),

  "get-stock-adjustment": createCommand(
    z.object({ id: z.string().min(1).describe("Adjustment ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockAdjustment(id);
    },
    "Get stock adjustment details"
  ),

  "create-stock-adjustment": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID"),
      locationId: z.string().min(1).describe("Location ID"),
      quantity: cliTypes.int().describe("Quantity adjustment"),
      reasonId: z.string().optional().describe("Adjustment reason ID"),
      remarks: z.string().optional().describe("Notes/remarks"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { productId, locationId, quantity, reasonId, remarks } = args as {
        productId: string; locationId: string; quantity: number;
        reasonId?: string; remarks?: string;
      };
      return client.createStockAdjustment({
        locationId, reasonId, remarks,
        items: [{ productId, quantity }],
      });
    },
    "Create a new stock adjustment"
  ),

  "list-adjustment-reasons": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.listAdjustmentReasons(),
    "List available adjustment reasons"
  ),

  // ==================== Stock Transfers ====================
  "list-stock-transfers": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
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
    "List stock transfers between locations"
  ),

  "get-stock-transfer": createCommand(
    z.object({ id: z.string().min(1).describe("Transfer ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockTransfer(id);
    },
    "Get stock transfer details"
  ),

  "create-stock-transfer": createCommand(
    z.object({
      productId: z.string().min(1).describe("Product ID"),
      fromLocationId: z.string().min(1).describe("Source location ID"),
      toLocationId: z.string().min(1).describe("Destination location ID"),
      quantity: cliTypes.int(1).describe("Quantity to transfer"),
      remarks: z.string().optional().describe("Notes/remarks"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { productId, fromLocationId, toLocationId, quantity, remarks } = args as {
        productId: string; fromLocationId: string;
        toLocationId: string; quantity: number; remarks?: string;
      };
      return client.createStockTransfer({
        fromLocationId, toLocationId, remarks,
        items: [{ productId, quantity }],
      });
    },
    "Create a new stock transfer"
  ),

  // ==================== Stock Counts ====================
  "list-stock-counts": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
      status: z.string().optional().describe("Filter by status"),
      locationId: z.string().optional().describe("Location ID"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, status, locationId } = args as {
        limit?: number; status?: string; locationId?: string;
      };
      return client.listStockCounts({ limit, status, locationId });
    },
    "List inventory count records"
  ),

  "get-stock-count": createCommand(
    z.object({ id: z.string().min(1).describe("Stock count ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getStockCount(id);
    },
    "Get stock count details"
  ),

  "create-stock-count": createCommand(
    z.object({
      locationId: z.string().min(1).describe("Location ID"),
      remarks: z.string().optional().describe("Notes/remarks"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { locationId, remarks } = args as { locationId: string; remarks?: string };
      return client.createStockCount({ locationId, remarks });
    },
    "Create a new stock count"
  ),

  // ==================== Sales Orders ====================
  "list-sales-orders": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
      skip: cliTypes.int(0).optional().describe("Records to skip"),
      status: z.string().optional().describe("Filter by status"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, status, include } = args as {
        limit?: number; skip?: number; status?: string; include?: string;
      };
      return client.listSalesOrders({
        limit, skip, status,
        include: include?.split(","),
      });
    },
    "List sales orders"
  ),

  "get-sales-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Sales order ID"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, include } = args as { id: string; include?: string };
      return client.getSalesOrder(id, { include: include?.split(",") });
    },
    "Get sales order details"
  ),

  "search-sales-orders": createCommand(
    z.object({ query: z.string().min(1).describe("Search term") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSalesOrders(query);
    },
    "Search sales orders"
  ),

  // ==================== Purchase Orders ====================
  "list-purchase-orders": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
      skip: cliTypes.int(0).optional().describe("Records to skip"),
      status: z.string().optional().describe("Filter by status"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, skip, status, include } = args as {
        limit?: number; skip?: number; status?: string; include?: string;
      };
      return client.listPurchaseOrders({
        limit, skip, status,
        include: include?.split(","),
      });
    },
    "List purchase orders"
  ),

  "get-purchase-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Purchase order ID"),
      include: z.string().optional().describe("Include relationships (comma-separated)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, include } = args as { id: string; include?: string };
      return client.getPurchaseOrder(id, { include: include?.split(",") });
    },
    "Get purchase order details"
  ),

  // ==================== Product Write Operations ====================
  "create-product": createCommand(
    z.object({
      name: z.string().min(1).describe("Product name (required)"),
      sku: z.string().optional().describe("Product SKU"),
      description: z.string().optional().describe("Product description"),
      categoryId: z.string().optional().describe("Category ID"),
      cost: z.coerce.number().optional().describe("Unit cost"),
      price: z.coerce.number().optional().describe("Selling price"),
      barcode: z.string().optional().describe("Product barcode"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { name, sku, description, categoryId, cost, price, barcode } = args as {
        name: string; sku?: string; description?: string; categoryId?: string;
        cost?: number; price?: number; barcode?: string;
      };
      return client.upsertProduct({
        name, sku, description, categoryId, cost,
        defaultPrice: price, barcode,
      });
    },
    "Create a new product in inFlow"
  ),

  "update-product": createCommand(
    z.object({
      id: z.string().min(1).describe("Product ID (required)"),
      name: z.string().optional().describe("Product name"),
      sku: z.string().optional().describe("Product SKU"),
      description: z.string().optional().describe("Product description"),
      cost: z.coerce.number().optional().describe("Unit cost"),
      price: z.coerce.number().optional().describe("Selling price"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, name, sku, description, cost, price } = args as {
        id: string; name?: string; sku?: string; description?: string;
        cost?: number; price?: number;
      };
      // Bypass cache to get fresh timestamp (per Codex review)
      client.disableCache();
      const current = await client.getProduct(id);
      client.enableCache();
      return client.upsertProduct({
        id,
        name: name || current.name,
        sku, description, cost,
        defaultPrice: price,
        timestamp: current.timestamp,
      });
    },
    "Update an existing product"
  ),

  // ==================== Vendor Write Operations ====================
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
    }),
    async (args, client: InFlowMCPClient) => {
      const { name, email, phone, website, street1, city, postalCode, country, currency } = args as {
        name: string; email?: string; phone?: string; website?: string;
        street1?: string; city?: string; postalCode?: string; country?: string; currency?: string;
      };
      const address = (street1 || city || country) ? { street1, city, postalCode, country } : undefined;
      return client.upsertVendor({ name, email, phone, website, address, currencyCode: currency });
    },
    "Create a new vendor in inFlow"
  ),

  "update-vendor": createCommand(
    z.object({
      id: z.string().min(1).describe("Vendor ID (required)"),
      name: z.string().optional().describe("Vendor name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      website: z.string().optional().describe("Website URL"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, name, email, phone, website } = args as {
        id: string; name?: string; email?: string; phone?: string; website?: string;
      };
      // Use getVendor() directly - bypasses cache and avoids pagination issues (per Codex review)
      const vendor = await client.getVendor(id);
      if (!vendor) throw new Error(`Vendor ${id} not found`);
      return client.upsertVendor({
        id, name: name || vendor.name, email, phone, website,
        timestamp: vendor.timestamp,
      });
    },
    "Update an existing vendor"
  ),

  // ==================== Purchase Order Write Operations ====================
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
    }),
    async (args, client: InFlowMCPClient) => {
      const { vendorId, orderNumber, orderDate, expectedDate, locationId, items, currency, remarks } = args as {
        vendorId: string; orderNumber?: string; orderDate?: string; expectedDate?: string;
        locationId?: string; items: string; currency?: string; remarks?: string;
      };
      let parsedItems: Array<{ productId?: string; quantity: number; unitCost?: number; description?: string }>;
      try {
        parsedItems = JSON.parse(items);
      } catch {
        throw new Error('Invalid items JSON. Format: [{"productId":"...", "quantity":5}]');
      }
      return client.upsertPurchaseOrder({
        vendorId, orderNumber, orderDate, expectedDate, locationId,
        items: parsedItems, currencyCode: currency, remarks,
      });
    },
    "Create a new purchase order"
  ),

  "add-po-item": createCommand(
    z.object({
      purchaseOrderId: z.string().min(1).describe("Purchase order ID"),
      productId: z.string().min(1).describe("Product ID to add"),
      quantity: cliTypes.int(1).describe("Quantity to order"),
      unitCost: z.coerce.number().optional().describe("Unit cost"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { purchaseOrderId, productId, quantity, unitCost } = args as {
        purchaseOrderId: string; productId: string; quantity: number; unitCost?: number;
      };
      // Bypass cache to get fresh PO with current items (per Codex review)
      client.disableCache();
      const currentPO = await client.getPurchaseOrder(purchaseOrderId, { include: ["lines"] });
      client.enableCache();
      const existingItems = currentPO.lines || [];
      return client.upsertPurchaseOrder({
        id: purchaseOrderId,
        vendorId: currentPO.vendorId,
        items: [...existingItems, { productId, quantity, unitCost }],
        timestamp: currentPO.timestamp,
      });
    },
    "Add a line item to an existing purchase order"
  ),

  "update-purchase-order": createCommand(
    z.object({
      id: z.string().min(1).describe("Purchase order ID"),
      remarks: z.string().optional().describe("Order remarks/notes"),
      orderDate: z.string().optional().describe("Order date (ISO format)"),
      expectedDate: z.string().optional().describe("Expected delivery date"),
      carrier: z.string().optional().describe("Carrier name"),
      currency: z.string().optional().describe("Currency code (GBP, USD)"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { id, remarks, orderDate, expectedDate, carrier, currency } = args as {
        id: string; remarks?: string; orderDate?: string; expectedDate?: string; carrier?: string; currency?: string;
      };
      // Bypass cache to get fresh PO (per Codex review)
      client.disableCache();
      const currentPO = await client.getPurchaseOrder(id, { include: ["lines"] });
      client.enableCache();

      // Transform existing items to match the expected format for upsert
      const existingItems = (currentPO.lines || []).map((line: any) => ({
        id: line.purchaseOrderLineId,
        productId: line.productId,
        description: line.description,
        quantity: typeof line.quantity === 'object' ?
          parseFloat(line.quantity.standardQuantity || line.quantity.uomQuantity || '1') :
          parseFloat(line.quantity || '1'),
        unitCost: parseFloat(line.unitPrice || '0'),
      }));

      return client.upsertPurchaseOrder({
        id,
        vendorId: currentPO.vendorId,
        items: existingItems,
        remarks: remarks !== undefined ? remarks : currentPO.orderRemarks,
        orderDate: orderDate || currentPO.orderDate,
        expectedDate: expectedDate || currentPO.expectedDate,
        currencyCode: currency,
        timestamp: currentPO.timestamp,
      });
    },
    "Update an existing purchase order (remarks, dates, currency, etc)"
  ),

  "receive-po-items": createCommand(
    z.object({
      purchaseOrderId: z.string().min(1).describe("Purchase order ID"),
      receiveAll: cliTypes.bool().optional().describe("Fully receive all lines"),
      items: z.string().optional().describe(
        'JSON array: [{"purchaseOrderLineId":"...","quantity":6}] or [{"productId":"...","quantity":6}]'
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
      const parsedItems = items ? JSON.parse(items) : undefined;
      return client.receivePurchaseOrder({
        purchaseOrderId,
        receiveAll,
        items: parsedItems,
        allowOverReceive,
      });
    },
    "Receive items on a purchase order (partial or full)"
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
      // Validate mutual exclusivity
      const modes = [receiveLineIds, items, unreceiveAll].filter(Boolean).length;
      if (modes === 0) throw new Error('Provide --receiveLineIds, --items, or --unreceiveAll');
      if (modes > 1) throw new Error('Use only one of --receiveLineIds, --items, or --unreceiveAll');

      return client.unreceivePurchaseOrder({
        purchaseOrderId,
        receiveLineIds: receiveLineIds ? JSON.parse(receiveLineIds) : undefined,
        items: items ? JSON.parse(items) : undefined,
        unreceiveAll,
        dryRun,
      });
    },
    "Remove received items from a purchase order (reverse stock)"
  ),

  // ==================== Locations ====================
  "list-locations": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.listLocations(),
    "List warehouse locations"
  ),

  "get-location": createCommand(
    z.object({ id: z.string().min(1).describe("Location ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getLocation(id);
    },
    "Get location details"
  ),

  // ==================== Serial Number Operations (Order-Based) ====================
  "get-order-serials": createCommand(
    z.object({ id: z.string().min(1).describe("Sales order ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getSalesOrderSerials(id);
    },
    "Get serial numbers from a sales order"
  ),

  "get-po-vins": createCommand(
    z.object({ id: z.string().min(1).describe("Purchase order ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getPurchaseOrderSerials(id);
    },
    "Get serial numbers from a purchase order"
  ),

  "search-serial": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search for") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSerial(query);
    },
    "Find which order a serial number is on"
  ),

  "list-vins": createCommand(
    z.object({
      limit: cliTypes.int(1, 250).optional().describe("Max records"),
      productId: z.string().optional().describe("Filter by product ID"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { limit, productId } = args as { limit?: number; productId?: string };
      return client.listSerials({ limit, productId });
    },
    "List all serial numbers from fulfilled orders"
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
    "Rebuild the serial cache (slow)"
  ),

  // ==================== Serial Number Operations (Product-Based - Fast) ====================
  "get-product-vins": createCommand(
    z.object({ id: z.string().min(1).describe("Product ID") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.getProductSerials(id);
    },
    "Get serial numbers for a specific product (FAST)"
  ),

  "list-all-vins": createCommand(
    z.object({
      maxProducts: cliTypes.int(1, 100).optional().describe("Max products to fetch"),
      inStockOnly: cliTypes.bool().optional().describe("Only show in-stock serials"),
    }),
    async (args, client: InFlowMCPClient) => {
      const { maxProducts, inStockOnly } = args as { maxProducts?: number; inStockOnly?: boolean };
      return client.listAllSerials({ maxProducts, inStockOnly });
    },
    "List ALL serial numbers across all serialized products (FAST)"
  ),

  "search-serial-fast": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search for") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSerialByProduct(query);
    },
    "Find serial number by product lookup (no order info)"
  ),

  // ==================== Legacy Aliases ====================
  "list-serial-numbers": createCommand(
    z.object({ productId: z.string().optional(), limit: cliTypes.int(1).optional() }),
    async (args, client: InFlowMCPClient) => {
      const { productId, limit } = args as { productId?: string; limit?: number };
      return client.listSerials({ productId, limit });
    },
    "Alias for list-vins"
  ),

  "search-serial-numbers": createCommand(
    z.object({ query: z.string().min(1).describe("serial number to search") }),
    async (args, client: InFlowMCPClient) => {
      const { query } = args as { query: string };
      return client.searchSerial(query);
    },
    "Alias for search-serial"
  ),

  "get-serial-number": createCommand(
    z.object({ id: z.string().min(1).describe("serial number") }),
    async (args, client: InFlowMCPClient) => {
      const { id } = args as { id: string };
      return client.searchSerial(id);
    },
    "Alias for search-serial"
  ),

  // ==================== Other ====================
  "list-customers": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.listCustomers({ limit });
    },
    "List customer records"
  ),

  "list-vendors": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.listVendors({ limit });
    },
    "List vendor records"
  ),

  "get-company-info": createCommand(
    z.object({}),
    async (_args, client: InFlowMCPClient) => client.getCompanyInfo(),
    "Get company configuration"
  ),

  "list-currencies": createCommand(
    z.object({ limit: cliTypes.int(1, 250).optional().describe("Max records") }),
    async (args, client: InFlowMCPClient) => {
      const { limit } = args as { limit?: number };
      return client.callTool("list_currencies", { count: limit });
    },
    "List all available currencies"
  ),

  // Pre-built cache commands
  ...cacheCommands<InFlowMCPClient>(),
};

// Run CLI
runCli(commands, InFlowMCPClient, {
  programName: "inflow-cli",
  description: "inFlow inventory management via MCP",
});
