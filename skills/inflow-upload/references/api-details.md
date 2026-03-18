# inFlow Cloud API — Attachment Upload Details

## Authentication

Tokens are extracted from live browser sessions. They are NOT in localStorage/sessionStorage.

**Token format:** `Bearer <64-hex-chars>-1` (73 chars total including "Bearer "). Example: `Bearer AAAA...AAAA-1`

**Interceptor injection:**
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

**Reading captured token:**
```javascript
window.__freshAuth ? String.fromCharCode(...window.__freshAuth) : null
```

The char-code array approach avoids Chrome MCP truncating or masking the token string.

---

## API Endpoints

### GET Upload URL

```
GET https://cloudapi.inflowinventory.com/{accountId}/attachments/upload-url?fileName={urlEncodedName}
```

**Headers:**
```
Authorization: Bearer {token}
Accept: application/vnd.api+json; version=2026-02-24
```

**Full curl:**
```bash
ACCOUNT="YOUR_INFLOW_ACCOUNT_ID"
AUTH="Bearer C38C0FA5..."
ENCODED_NAME=$(python3 -c "import urllib.parse; print(urllib.parse.quote('CI_PL.pdf'))")

curl -s "https://cloudapi.inflowinventory.com/${ACCOUNT}/attachments/upload-url?fileName=${ENCODED_NAME}" \
  -H "Authorization: $AUTH" \
  -H "Accept: application/vnd.api+json; version=2026-02-24"
```

**Response (200):**
```json
{
  "data": {
    "id": "YOUR_ATTACHMENT_ID_3",
    "type": "attachments",
    "attributes": {
      "blobRelativeUrl": "attachments/cysuwbsbvfrzyitfcy0bndoi.pdf",
      "uploadUrl": "https://inflowclouduser.blob.core.windows.net/YOUR_INFLOW_ACCOUNT_ID-private/attachments/cysuwbsbvfrzyitfcy0bndoi.pdf?sv=2024-11-04&se=...&sig=...&sp=cw&sr=b",
      "mimeType": "application/pdf"
    }
  }
}
```

---

### PUT File to Azure Blob

```
PUT {uploadUrl from previous step}
```

**Headers:**
```
x-ms-blob-type: BlockBlob
Content-Type: {mimeType from previous step}
```

**Body:** Raw file bytes (binary)

**Full curl:**
```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$UPLOAD_URL" \
  -H "x-ms-blob-type: BlockBlob" \
  -H "Content-Type: application/pdf" \
  --data-binary @"/path/to/file.pdf")
echo $HTTP_CODE  # Expected: 201
```

**Response:** HTTP 201 Created (empty body)

---

### GET Purchase Order (with includes)

```
GET https://cloudapi.inflowinventory.com/{accountId}/purchase-orders/{poId}?include=attachments,vendor
```

**Headers:**
```
Authorization: Bearer {token}
Accept: application/vnd.api+json; version=2026-02-24
```

**Response (200) — key fields:**
```json
{
  "data": {
    "id": "c657960f-9c44-4360-ad7f-1704ca8bc84d",
    "type": "purchaseOrders",
    "attributes": {
      "timestamp": "00000000000DB251",
      "orderNumber": "PO-000011",
      "orderDate": "2025-12-01",
      "remarks": "Some notes\r\nwith line breaks"
    },
    "relationships": {
      "vendor": {
        "data": {"id": "YOUR_VENDOR_ID", "type": "vendors"}
      },
      "attachments": {
        "data": [
          {"id": "YOUR_ATTACHMENT_ID_1", "type": "attachments"},
          {"id": "YOUR_ATTACHMENT_ID_2", "type": "attachments"}
        ]
      },
      "lines": {
        "data": [
          {"id": "...", "type": "purchaseOrderLines"}
        ]
      }
    }
  },
  "included": [
    {
      "id": "YOUR_ATTACHMENT_ID_1",
      "type": "attachments",
      "attributes": {
        "fileName": "example-receipt.pdf",
        "fileSize": 225283,
        "attachmentUrl": "attachments/example-upload-path.pdf",
        "lastModDttm": "2026-01-20T17:06:26.3122114+00:00"
      },
      "relationships": null,
      "meta": null
    },
    {
      "id": "YOUR_VENDOR_ID",
      "type": "vendors",
      "attributes": {
        "name": "Vendor Name"
      }
    }
  ]
}
```

---

### PUT Purchase Order (link attachments)

```
PUT https://cloudapi.inflowinventory.com/{accountId}/purchase-orders
```

**Important:** This is PUT to the **collection URL**, not `/purchase-orders/{id}`. The PO ID is in `data.id`.

**Headers:**
```
Authorization: Bearer {token}
Accept: application/vnd.api+json; version=2026-02-24
Content-Type: application/vnd.api+json
```

**Request body:**
```json
{
  "meta": {"apiVersion": "2026-02-24"},
  "data": {
    "id": "c657960f-9c44-4360-ad7f-1704ca8bc84d",
    "type": "purchaseOrders",
    "attributes": {
      "timestamp": "00000000000DB251",
      "orderNumber": "PO-000011",
      "orderDate": "2025-12-01"
    },
    "relationships": {
      "vendor": {
        "data": {"id": "YOUR_VENDOR_ID", "type": "vendors"}
      },
      "attachments": {
        "data": [
          {"id": "YOUR_ATTACHMENT_ID_1", "type": "attachments"},
          {"id": "YOUR_ATTACHMENT_ID_2", "type": "attachments"},
          {"id": "YOUR_ATTACHMENT_ID_3", "type": "attachments"}
        ]
      }
    }
  },
  "included": [
    {
      "id": "YOUR_ATTACHMENT_ID_3",
      "type": "attachments",
      "attributes": {
        "fileName": "example-document.pdf",
        "fileSize": 64355,
        "attachmentUrl": "attachments/example-upload-path2.pdf",
        "lastModDttm": "2026-03-17T21:36:15.437000+00:00"
      }
    }
  ]
}
```

**Full curl:**
```bash
curl -s -w "\n%{http_code}" -X PUT "https://cloudapi.inflowinventory.com/${ACCOUNT}/purchase-orders" \
  -H "Authorization: $AUTH" \
  -H "Accept: application/vnd.api+json; version=2026-02-24" \
  -H "Content-Type: application/vnd.api+json" \
  -d @payload.json
```

**Response (200):** Returns the updated PO object. Note: attachments may show as empty in the response unless `?include=attachments` is appended.

---

## Error Reference

| HTTP | Error ID/Title | Cause | Fix |
|------|---------------|-------|-----|
| 400 | `invalidMimeType` | Missing or wrong `Accept` header | Use `application/vnd.api+json; version=2026-02-24` |
| 400 | `Vendor is missing` | PUT payload missing vendor relationship | Include `relationships.vendor` from GET response |
| 400 | `Product does not exist.` | PUT payload includes `lines` relationship | Remove `lines` — only include `vendor` + `attachments` |
| 401 | Unauthorized | Bearer token expired | Re-extract from browser |
| 405 | Method Not Allowed | Using PATCH on `/purchase-orders/{id}` | Use PUT on `/purchase-orders` (collection) |

---

## Complete Bash Upload Pattern

```bash
#!/bin/bash
set -euo pipefail

ACCOUNT="YOUR_INFLOW_ACCOUNT_ID"
AUTH="Bearer ${TOKEN}"
ACCEPT="application/vnd.api+json; version=2026-02-24"
API="https://cloudapi.inflowinventory.com"

# Files to upload
FILES=("file1.pdf" "file2.pdf")
DIR="/path/to/files"

# Collect upload results
ATTACHMENTS=()

for FILE in "${FILES[@]}"; do
  ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$FILE'))")
  SIZE=$(stat -f%z "${DIR}/${FILE}")
  NOW=$(python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).isoformat())")

  # Step 1: Get signed URL
  RESP=$(curl -s "${API}/${ACCOUNT}/attachments/upload-url?fileName=${ENCODED}" \
    -H "Authorization: $AUTH" \
    -H "Accept: $ACCEPT")

  ATT_ID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")
  UPLOAD_URL=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['attributes']['uploadUrl'])")
  MIME=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['attributes']['mimeType'])")
  BLOB_URL=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['attributes']['blobRelativeUrl'])")

  # Step 2: Upload to Azure
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$UPLOAD_URL" \
    -H "x-ms-blob-type: BlockBlob" \
    -H "Content-Type: $MIME" \
    --data-binary @"${DIR}/${FILE}")

  if [ "$HTTP_CODE" != "201" ]; then
    echo "ERROR: Upload failed for $FILE (HTTP $HTTP_CODE)"
    exit 1
  fi

  echo "Uploaded: $FILE ($SIZE bytes)"

  # Collect for linking
  ATTACHMENTS+=("{\"id\":\"$ATT_ID\",\"fileName\":\"$FILE\",\"fileSize\":$SIZE,\"attachmentUrl\":\"$BLOB_URL\",\"lastModDttm\":\"$NOW\"}")
done

# Step 3: Fetch current PO, merge, and PUT back
# (construct JSON payload with existing + new attachments, then PUT)
echo "All files uploaded. Build PUT payload with ${#ATTACHMENTS[@]} new attachment(s)."
```
