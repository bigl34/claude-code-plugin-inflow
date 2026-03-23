---
name: inflow-upload
description: This skill should be used when the user asks to "upload files to inFlow", "attach documents to a PO", "add attachments to purchase order", "inflow upload", "attach PDF to inFlow", "upload to purchase order", or mentions uploading PDFs/documents/files to inFlow purchase orders or sales orders.
argument-hint: "[--chrome] <order-number> <file-path> [file-path...]"
---

# Upload Attachments to inFlow Purchase/Sales Orders

Upload file attachments to inFlow orders via the undocumented Cloud API. The inFlow REST API has no official attachment endpoint — this uses a reverse-engineered 3-step flow: get a signed Azure URL, PUT the file, then PUT the order to link it.

Two browser automation modes for token extraction:
- **Default (Playwright):** Automated login via `pass` credentials — no manual browser setup needed
- **`--chrome` flag:** Uses an existing Chrome inFlow tab — the original approach, useful as fallback

## Prerequisites

**Default (Playwright):**
- Playwright MCP (`mcp__playwright__*`) tools available
- Credentials in `pass`: `claude-plugins/inflow-billing/email`, `claude-plugins/inflow-billing/password`, `claude-plugins/inflow-billing/totp-secret`
- `oathtool` available for TOTP generation

**`--chrome` mode:**
- An open inFlow tab in Chrome "Claude" profile (logged in)
- Chrome MCP (`mcp__claude-in-chrome__*`) tools available

**Both modes:**
- File paths on disk for the documents to upload

## Step 1 — Gather Inputs

Parse `$ARGUMENTS` for:
1. **`--chrome` flag** — if present, use Chrome MCP path (Step 2B); otherwise use Playwright (Step 2A)
2. **Order number** — PO number (e.g. `PO-000011`) or SO number
3. **File paths** — absolute paths to files to upload

If order number or file paths were not provided, ask the user.

## Step 2A — Extract Bearer Token (Playwright — DEFAULT)

The inFlow Cloud API uses session-based Bearer tokens (HTTP-only cookies, not in localStorage/sessionStorage). Playwright automates login and captures the token via request interception.

### 2A.1. Read credentials

```bash
EMAIL=$(pass claude-plugins/inflow-billing/email)
PASSWORD=$(pass claude-plugins/inflow-billing/password)
```

### 2A.2. Navigate and log in

1. `mcp__playwright__browser_navigate` to `https://app.inflowinventory.com`
2. `mcp__playwright__browser_snapshot` — check if login form is visible
3. `mcp__playwright__browser_fill_form` with the email and password fields
4. Click the login button or press Enter via `mcp__playwright__browser_click`
5. Wait briefly: `mcp__playwright__browser_wait_for` (2-3 seconds)
6. `mcp__playwright__browser_snapshot` — check what appeared:

**If TOTP/verification code prompt appears:**

```bash
TOTP_SECRET=$(pass claude-plugins/inflow-billing/totp-secret)
TOTP_CODE=$(oathtool --totp -b "$TOTP_SECRET")
```

- `mcp__playwright__browser_type` the TOTP code into the verification field
- Submit the form
- `mcp__playwright__browser_snapshot` — verify app shell loaded

**If app dashboard/shell loads:** Login succeeded, proceed to token capture.

**If error message appears:** STOP. Report the error to the user. Do not retry in a loop.

### 2A.3. Capture Bearer token

**Primary method — Playwright request listener via `browser_run_code`:**

```javascript
async (page) => {
  let token = null;
  page.on('request', req => {
    const auth = req.headers()['authorization'];
    if (auth && auth.startsWith('Bearer') && !token) {
      token = auth;
    }
  });
  await page.goto('https://app.inflowinventory.com/#/purchase-orders');
  await page.waitForTimeout(3000);
  return token;
}
```

If this returns the token, store it for all subsequent API calls. Skip to Step 3.

**Fallback method — XHR + fetch monkey-patch via `browser_evaluate`:**

If `browser_run_code` returns null (listener didn't fire or is unsupported), inject a client-side interceptor:

```javascript
window.__freshAuth = null;
const _origSRH = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
  if (name === 'Authorization' && value.startsWith('Bearer')) {
    window.__freshAuth = value;
  }
  return _origSRH.apply(this, arguments);
};
const _origFetch = window.fetch;
window.fetch = function(url, opts) {
  if (opts && opts.headers) {
    const h = opts.headers;
    const auth = h['Authorization'] || h['authorization'];
    if (auth && auth.startsWith('Bearer')) window.__freshAuth = auth;
  }
  return _origFetch.apply(this, arguments);
};
```

Then trigger an API call by navigating within the app (e.g. click a menu item or navigate to a PO page). Read the captured token:

```javascript
window.__freshAuth
```

**If both methods fail:** STOP. Tell the user: "Could not capture inFlow Bearer token via Playwright. Retry with `--chrome` flag to use Chrome browser instead."

## Step 2B — Extract Bearer Token (`--chrome` flag)

Use the existing Chrome MCP approach. This requires the user to already be logged in to inFlow in Chrome.

### 2B.1. Find the inFlow tab

Use `mcp__claude-in-chrome__tabs_context_mcp` to find a tab on `app.inflowinventory.com`. If none exists, ask the user to open inFlow in Chrome first.

### 2B.2. Inject the interceptor

Use `mcp__claude-in-chrome__javascript_tool` on the inFlow tab:

```javascript
window.__freshAuth = null;
const _origSRH = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
  if (name === 'Authorization' && value.startsWith('Bearer')) {
    window.__freshAuth = Array.from(value).map(c => c.charCodeAt(0));
  }
  return _origSRH.apply(this, arguments);
};
```

### 2B.3. Trigger an API call

Navigate or click something in the inFlow app to force an XHR request. Then read the captured token:

```javascript
window.__freshAuth ? String.fromCharCode(...window.__freshAuth) : null
```

This returns the full `Bearer XXXX...` string. Store it for all subsequent API calls.

**If token is null:** The user may need to interact with the inFlow app (navigate to a different page) to trigger an API call, then re-read `window.__freshAuth`.

## Step 3 — Resolve Order ID

Look up the PO/SO UUID. Use one of:
- `mcp__knowledge__smart_query` with the order number
- inFlow MCP tools to search for the order
- Direct API call:

```bash
curl -s "https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders?filter[orderNumber]=${ORDER_NUM}" \
  -H "Authorization: ${AUTH}" \
  -H "Accept: application/vnd.api+json; version=2026-02-24"
```

You need the order's `id` (UUID) and `timestamp` (concurrency token).

**Also fetch the current PO with includes** — you'll need this for the linking step AND duplicate detection:

```bash
curl -s "https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders/${PO_ID}?include=attachments,vendor" \
  -H "Authorization: ${AUTH}" \
  -H "Accept: application/vnd.api+json; version=2026-02-24"
```

Save the response — you need:
- `data.attributes.timestamp` (concurrency token, e.g. `"00000000000DB251"`)
- `data.attributes.orderNumber` and `orderDate`
- `data.relationships.vendor.data` (vendor ID and type)
- `data.relationships.attachments.data` (existing attachment references)
- `included[]` entries for existing attachments (including `fileName` and `fileSize`)

## Step 4 — Duplicate Detection

Before uploading, check each local file against existing attachments to avoid duplicates.

### 4a. Collect existing attachment metadata

From the Step 3 response, extract each attachment's `fileName` and `fileSize` from the `included[]` array:

```json
{
  "id": "existing-att-uuid",
  "type": "attachments",
  "attributes": {
    "fileName": "invoice.pdf",
    "fileSize": 64355,
    "attachmentUrl": "attachments/...",
    "lastModDttm": "..."
  }
}
```

Build a lookup: `{ "invoice.pdf": 64355, ... }`

### 4b. Check each local file

For each file to upload, get the local file size and basename:

```bash
# macOS
FILE_SIZE=$(stat -f%z "${FILE_PATH}")
# Linux
FILE_SIZE=$(stat -c%s "${FILE_PATH}")

FILE_NAME=$(basename "${FILE_PATH}")
```

Compare against existing attachments:

- **Exact duplicate** (same `fileName` AND same `fileSize`): Mark as SKIP
- **Size-only match** (same `fileSize`, different `fileName`): Mark as WARN (upload anyway)
- **No match**: Mark as UPLOAD

### 4c. Report findings

Before proceeding, report the status of each file:

- "Skipping: invoice.pdf (64,355 bytes) — exact duplicate already attached"
- "Warning: receipt.pdf (64,355 bytes) — same size as existing invoice.pdf, uploading anyway"
- "Uploading: new-doc.pdf (128,000 bytes)"

**If ALL files are exact duplicates:** Stop early — "All files already attached to PO-XXXXXX. Nothing to upload."

Only files marked UPLOAD or WARN proceed to Step 5.

## Step 5 — Upload Files

For each non-duplicate file, perform two API calls:

### 5a. Get signed upload URL

```bash
ACCOUNT="YOUR_INFLOW_ACCOUNT_ID"
ENCODED_NAME=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${FILENAME}'))")

curl -s "https://cloudapi.inflowinventory.com/${ACCOUNT}/attachments/upload-url?fileName=${ENCODED_NAME}" \
  -H "Authorization: ${AUTH}" \
  -H "Accept: application/vnd.api+json; version=2026-02-24"
```

Response:
```json
{
  "data": {
    "id": "29085fe3-...",
    "type": "attachments",
    "attributes": {
      "blobRelativeUrl": "attachments/randomid.pdf",
      "uploadUrl": "https://inflowclouduser.blob.core.windows.net/...",
      "mimeType": "application/pdf"
    }
  }
}
```

Save from the response:
- `data.id` → `attachmentId`
- `data.attributes.blobRelativeUrl` → `attachmentUrl` (for linking)
- `data.attributes.uploadUrl` → where to PUT the file
- `data.attributes.mimeType` → Content-Type for the PUT

### 5b. PUT file to Azure Blob Storage

```bash
curl -s -o /dev/null -w "%{http_code}" -X PUT "${UPLOAD_URL}" \
  -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: ${MIME_TYPE}" \
  --data-binary @"${FILE_PATH}"
```

Expected response: HTTP **201** (no body).

### 5c. Collect attachment metadata

For each uploaded file, build an attachment record:

```json
{
  "attachmentId": "<data.id from 5a>",
  "fileName": "<original filename>",
  "fileSize": <file size in bytes from disk>,
  "attachmentUrl": "<blobRelativeUrl from 5a>",
  "lastModDttm": "<current ISO 8601 timestamp with timezone>"
}
```

Get file size with: `stat -f%z "${FILE_PATH}"` (macOS) or `stat -c%s "${FILE_PATH}"` (Linux).

Generate timestamp with: `python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat())"`.

## Step 6 — Link Attachments to Order

Build a PUT request that merges new attachments with existing ones.

**Endpoint:** `PUT https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders`

Note: This is PUT to the **collection URL** (not `/purchase-orders/{id}`). The PO ID goes in `data.id`. PATCH on individual IDs returns 405.

**Request body:**

```json
{
  "meta": {"apiVersion": "2026-02-24"},
  "data": {
    "id": "<PO UUID>",
    "type": "purchaseOrders",
    "attributes": {
      "timestamp": "<from Step 3 — DO NOT MODIFY>",
      "orderNumber": "<e.g. PO-000011>",
      "orderDate": "<e.g. 2025-12-01>"
    },
    "relationships": {
      "vendor": {
        "data": {"id": "<vendor UUID>", "type": "vendors"}
      },
      "attachments": {
        "data": [
          // ALL existing attachment refs (from Step 3 response)
          {"id": "<existing-att-1>", "type": "attachments"},
          // PLUS new attachment refs
          {"id": "<new-att-id>", "type": "attachments"}
        ]
      }
    }
  },
  "included": [
    // Only NEW attachments need included entries
    {
      "id": "<new-att-id>",
      "type": "attachments",
      "attributes": {
        "fileName": "document.pdf",
        "fileSize": 64355,
        "attachmentUrl": "attachments/randomid.pdf",
        "lastModDttm": "2026-03-17T21:36:15.437000+00:00"
      }
    }
  ]
}
```

**curl:**

```bash
curl -s -w "\n%{http_code}" -X PUT "https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders" \
  -H "Authorization: ${AUTH}" \
  -H "Accept: application/vnd.api+json; version=2026-02-24" \
  -H "Content-Type: application/vnd.api+json" \
  -d "${JSON_PAYLOAD}"
```

Expected: HTTP **200**.

## Step 7 — Verify

Fetch the PO again with `?include=attachments` and confirm the attachment count matches expectations:

```bash
curl -s "https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders/${PO_ID}?include=attachments" \
  -H "Authorization: ${AUTH}" \
  -H "Accept: application/vnd.api+json; version=2026-02-24"
```

Count the entries in `data.relationships.attachments.data` — should equal previous count + newly uploaded count.

Report to user:
- "Uploaded N file(s) to PO-XXXXXX. Skipped K duplicate(s). Total attachments: M."

---

## Constants

| Constant | Value |
|----------|-------|
| Account ID | `YOUR_INFLOW_ACCOUNT_ID` |
| API Base | `https://cloudapi.inflowinventory.com` |
| Accept Header | `application/vnd.api+json; version=2026-02-24` |
| Azure Blob Host | `inflowclouduser.blob.core.windows.net` |

---

## Gotchas

1. **Accept header is mandatory.** Using `application/json` or omitting it causes a misleading `{"errors":[{"id":"invalidMimeType","status":400}]}` — this actually means the versioned Accept header is missing.

2. **Vendor relationship is required in PUT.** Omitting it causes `{"errors":[{"status":400,"title":"Vendor is missing"}]}`. Always fetch the current PO with `?include=vendor` and include `relationships.vendor` in the PUT payload.

3. **Do NOT include `lines` in the PUT payload.** Including purchase order line items causes `{"errors":[{"status":400,"title":"Product does not exist."}]}`. Only include `vendor` and `attachments` relationships.

4. **`timestamp` is a concurrency token.** It must be sent back exactly as received from the GET response. Do not generate or modify it.

5. **`attachmentUrl` is a relative path.** Use the `blobRelativeUrl` from the upload-url response (e.g. `attachments/randomid.pdf`), NOT the full Azure URL.

6. **PUT targets the collection URL.** Use `PUT /purchase-orders` (not `/purchase-orders/{id}`). The PO UUID goes in `data.id`. PATCH returns 405.

7. **Azure PUT requires `x-ms-blob-type: BlockBlob`.** Without this header, Azure rejects the upload.

8. **Bearer token expires.** Tokens are session-based and expire after hours. If you get 401, re-extract via Playwright (re-run login) or Chrome tab.

9. **`\r\n` in response fields.** The `remarks` field may contain literal `\r\n` characters that break JSON parsing. Handle with `errors='replace'` or string replacement when parsing.

10. **PUT response may show 0 attachments.** This is normal if you don't include `?include=attachments` in the PUT response. The linkage still succeeds — verify with a separate GET.

11. **`fileSize` must be actual bytes from disk.** Use `stat` to get the real file size, not any value from API responses.

12. **Sales Orders** follow the same pattern but use `/sales-orders` endpoint and `type: "salesOrders"` with `customer` relationship instead of `vendor`.

13. **Playwright `browser_run_code` listener timing.** The request listener must be set up BEFORE navigating. Requests that complete before the listener is registered will not be captured. Always set up the listener first, then navigate.

14. **TOTP codes are time-sensitive.** Generate the TOTP code immediately before filling it in (30-second window). Do not cache or reuse codes.

15. **Do not retry failed Playwright logins.** If login fails (wrong credentials, changed password, unexpected UI), stop and report to the user. Do not retry in a loop — this risks account lockout.
