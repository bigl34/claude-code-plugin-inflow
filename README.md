<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-inflow

inFlow Inventory stock management and operations

![Version](https://img.shields.io/badge/version-1.15.1-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-products** — List all products
- **list-recent-products** — Exhaustively list products created in a stable UTC window
- **list-product-names** — Exhaustively list the stable active product ID/name catalogue
- **get-product** — Get product details and optional relationships
- **set-product** — Bounded product create/update; patch custom fields preserve siblings
- **search-products** — Search products
- **get-bom** — Get bill of materials
- **get-boms** — Read 2-25 bills of materials with serial provider-safe pacing
- **compare-boms** — Compare 2-25 BOMs, operations, and settings
- **list-product-groups** — List product groups, options, and variants
- **get-product-group** — Get one product group
- **get-group-quantities** — Get group variant quantities at a location
- **set-bom** — Preview/apply BOM, operation, and setting changes
- **list-operation-types / get-operation-type** — Discover operation taxonomy
- **get-product-prices / set-product-prices** — Exact scheme-ID price reads/writes
- **copy-manufacturing-config** — Copy selected manufacturing sections
- **audit-product-group** — Audit option matrix and manufacturing consistency
- **calculate-bom-requirements** — Direct/leaf/net material calculation
- **set-product-group-config** — Exact-ID group configuration
- **create-product-group-variants** — Compensated variant saga
- **list-categories** — List all product categories

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/bigl34/claude-code-plugin-inflow.git
cd claude-code-plugin-inflow
cp config.template.json config.json  # fill in your credentials
npm --prefix scripts install
```

```bash
npm --prefix scripts run cli -- list-products
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```
4. Ensure the MCP server binary is available on your system (see the service's documentation)

## Available Commands

| Command                                       | Description                                                          | Options                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `list-products`                               | List all products                                                    | `--limit --category --category-id`                                                            |
| `list-recent-products`                        | Exhaustively list products created in a stable UTC window            | `--since --before --active-only`                                                              |
| `list-product-names`                          | Exhaustively list the stable active product ID/name catalogue        | `--active-only`                                                                               |
| `get-product`                                 | Get product details and optional relationships                       | `--id` (required), `--include`, `--no-cache`                                                  |
| `set-product`                                 | Bounded product create/update; patch custom fields preserve siblings | `--id --mode --values --apply --confirm --confirm-preview-hash`                               |
| `search-products`                             | Search products                                                      | `--query` (required), `--no-cache`                                                            |
| `get-bom`                                     | Get bill of materials                                                | `--id` (required)                                                                             |
| `get-boms`                                    | Read 2-25 bills of materials with serial provider-safe pacing        | `--product-ids` (unique, comma-separated)                                                     |
| `compare-boms`                                | Compare 2-25 BOMs, operations, and settings                          | `--product-ids` (comma-separated)                                                             |
| `list-product-groups`                         | List product groups, options, and variants                           | `--limit --skip --sort --sort-desc --include-count`                                           |
| `get-product-group`                           | Get one product group                                                | `--id` (required)                                                                             |
| `get-group-quantities`                        | Get group variant quantities at a location                           | `--product-group-id --location-id`                                                            |
| `set-bom`                                     | Preview/apply BOM, operation, and setting changes                    | `--id --mode --components --operations --apply --confirm --confirm-preview-hash`              |
| `list-operation-types` / `get-operation-type` | Discover operation taxonomy                                          | `--limit`, `--id`                                                                             |
| `get-product-prices` / `set-product-prices`   | Exact scheme-ID price reads/writes                                   | `--id --mode --prices --apply`                                                                |
| `copy-manufacturing-config`                   | Copy selected manufacturing sections                                 | `--source-product-id --target-product-id --sections --apply --confirm --confirm-preview-hash` |
| `audit-product-group`                         | Audit option matrix and manufacturing consistency                    | `--id --baseline-product-id --location-id`                                                    |
| `calculate-bom-requirements`                  | Direct/leaf/net material calculation                                 | `--id --build-quantity --location-id --mode`                                                  |
| `set-product-group-config`                    | Exact-ID group configuration                                         | `--id --mode --options --variants --apply`                                                    |
| `create-product-group-variants`               | Compensated variant saga                                             | `--id --variants --apply`                                                                     |
| `list-categories`                             | List all product categories                                          | (none)                                                                                        |

## Usage Examples

```bash
# List products
npm --prefix "scripts" run cli -- list-products --limit 10

# List all product categories
npm --prefix "scripts" run cli -- list-categories

# List products filtered by category name
npm --prefix "scripts" run cli -- list-products --category "Parts" --limit 20

# List products filtered by category ID
npm --prefix "scripts" run cli -- list-products --category-id "00000000-0000-0000-0000-000000000001"

# Search for a product (by customer name, not manufacturer code)
npm --prefix "scripts" run cli -- search-products --query "ProductName Product"

# Get bill of materials for a product
npm --prefix "scripts" run cli -- get-bom --id "00000000-0000-0000-0000-000000000002"

# Get stock levels for a specific product
npm --prefix "scripts" run cli -- get-stock-levels --product-id "00000000-0000-0000-0000-000000000003"

# List sales orders (Open status)
npm --prefix "scripts" run cli -- list-sales-orders --status "Open" --limit 10

# List warehouse locations
npm --prefix "scripts" run cli -- list-locations

# List adjustment reasons
npm --prefix "scripts" run cli -- list-adjustment-reasons

# List stock transfers
npm --prefix "scripts" run cli -- list-stock-transfers --status "Open"

# List stock counts
npm --prefix "scripts" run cli -- list-stock-counts --status "InProgress"
```

## How It Works

This plugin wraps an MCP (Model Context Protocol) server, providing a CLI interface that communicates with the service's MCP binary. The CLI translates commands into MCP tool calls and returns structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| MCP connection timeout | Ensure the MCP server binary is installed and accessible |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
