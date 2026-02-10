<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-inflow

inFlow Inventory stock management and operations

![Version](https://img.shields.io/badge/version-1.7.2-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- **list-products** — List all products
- **get-product** — Get product details
- **search-products** — Search products
- **get-bom** — Get bill of materials
- **list-categories** — List all product categories

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- MCP server binary for the target service (configured via `config.json`)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-inflow.git
cd claude-code-plugin-inflow
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-products
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

| Command           | Description                 | Options                            |
| ----------------- | --------------------------- | ---------------------------------- |
| `list-products`   | List all products           | `--limit --category --category-id` |
| `get-product`     | Get product details         | `--id` (required)                  |
| `search-products` | Search products             | `--query` (required)               |
| `get-bom`         | Get bill of materials       | `--id` (required)                  |
| `list-categories` | List all product categories | (none)                             |

## Usage Examples

```bash
# List products
node scripts/dist/cli.js list-products --limit 10

# List all product categories
node scripts/dist/cli.js list-categories

# List products filtered by category name
node scripts/dist/cli.js list-products --category "Parts" --limit 20

# List products filtered by category ID
node scripts/dist/cli.js list-products --category-id "00000000-0000-0000-0000-000000000001"

# Search for a product (by customer name, not manufacturer code)
node scripts/dist/cli.js search-products --query "Ranger Product"

# Get bill of materials for a product
node scripts/dist/cli.js get-bom --id "00000000-0000-0000-0000-000000000002"

# Get stock levels for a specific product
node scripts/dist/cli.js get-stock-levels --product-id "00000000-0000-0000-0000-000000000003"

# List sales orders (Open status)
node scripts/dist/cli.js list-sales-orders --status "Open" --limit 10

# List warehouse locations
node scripts/dist/cli.js list-locations

# List adjustment reasons
node scripts/dist/cli.js list-adjustment-reasons

# List stock transfers
node scripts/dist/cli.js list-stock-transfers --status "Open"

# List stock counts
node scripts/dist/cli.js list-stock-counts --status "InProgress"
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
