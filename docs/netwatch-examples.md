# Netwatch integration

The NOC relies on **RouterOS Netwatch** as the status sensor. The server never
ICMP-pings devices itself. There are two ways the router reports status:

1. **Webhook (recommended, near-realtime)** — a Netwatch entry runs an `up` and a
   `down` script that POSTs to the backend the instant status changes.
2. **Polling (heartbeat/reconciliation)** — the worker periodically reads
   `/tool/netwatch` over the API so status never gets stuck if a webhook is lost.

Both can run at the same time (hybrid). The webhook gives instant updates; the
poll (default every 20s, plus a slower reconcile) is the safety net.

---

## How the script is built

We pass parameters in the **URL query string** (not a JSON body) so the generated
RouterOS script contains no inner quotes to escape — the exact same text works
when pasted into the terminal *and* when installed automatically via the API.

```
/tool fetch url="https://NOC_HOST/api/v1/webhook/netwatch?host=DEVICE_IP&status=up&router_id=ROUTER_ID" http-method=post http-header-field="X-Webhook-Token: ROUTER_TOKEN" keep-result=no
```

- `NOC_HOST` — public address of the backend (the app shows this for you).
- `DEVICE_IP` — the host the Netwatch entry watches.
- `ROUTER_ID` — the router's id in the NOC.
- `ROUTER_TOKEN` — the router's unique webhook token (secret, per router).

The backend authenticates the call by the `X-Webhook-Token` header (a unique
secret per router) plus an optional source-IP allowlist.

---

## Option A — copy/paste from the UI

1. Go to **Admin → Sites & Routers**.
2. On the router row click **Netwatch script**, enter the device IP.
3. Copy the generated block into the router terminal. Example (watching `192.168.88.10`):

```routeros
# NOC Netwatch for AP Lobby (192.168.88.10)
:foreach i in=[/tool netwatch find where host="192.168.88.10"] do={/tool netwatch remove $i}
/tool netwatch add host=192.168.88.10 interval=00:00:10 \
    up-script="/tool fetch url=\"https://noc.example.com/api/v1/webhook/netwatch?host=192.168.88.10&status=up&router_id=ckxxx\" http-method=post http-header-field=\"X-Webhook-Token: 3f9a...\" keep-result=no" \
    down-script="/tool fetch url=\"https://noc.example.com/api/v1/webhook/netwatch?host=192.168.88.10&status=down&router_id=ckxxx\" http-method=post http-header-field=\"X-Webhook-Token: 3f9a...\" keep-result=no" \
    comment="NOC:ckxxx"
```

## Option B — automatic install via API

When you create a device you can tick **“Also create Netwatch entry on the
router”**, or hit **`POST /api/v1/routers/:id/netwatch/install`** to (re)install
Netwatch for every device on a router. The backend connects over the binary API
and creates the entries for you. Device is then marked `netwatchSynced`.

---

## Manual test

You can simulate a status change without a router:

```bash
curl -X POST "http://localhost:8080/api/v1/webhook/netwatch?host=192.168.88.10&status=down&router_id=<ROUTER_ID>" \
  -H "X-Webhook-Token: <ROUTER_TOKEN>"
```

The matching device (router + matching `ipAddress`) flips to **down** and the map
updates in real time over WebSocket. Get the token/id from **Admin → Sites &
Routers** (or the seed output).

> Note: the device's **IP address in the NOC must match the Netwatch `host`** for
> the status to map to the right marker.
