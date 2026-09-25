# Hotspot captive-portal skin (`LP-SF/`)

`LP-SF/` is a **MikroTik hotspot login-page skin** — the captive portal guests
see when they connect to the Wi-Fi. It is served by the router itself, not by
this app; the NOC only manages the hotspot users/profiles behind it.

## Install

1. Open the router in **Winbox/WebFig → Files** and upload the **contents** of
   `LP-SF/` into the router's `hotspot/` directory (overwrite `login.html`,
   `status.html`, etc.).
2. The login form authenticates with **HTTP-CHAP** (MD5), so
   `hotspot/md5.js` **must exist** — it is included in `LP-SF/`; make sure it
   uploads too. The hotspot server profile needs `http-chap` enabled
   (`/ip hotspot profile`). Without `md5.js`, CHAP logins silently fail.

## Pages

| File | Purpose |
| ---- | ------- |
| `login.html` | captive-portal login form (voucher / username+password) |
| `alogin.html` | shown right after a successful login (advert slot) |
| `status.html` | session status (uptime, bytes in/out, logout button) |
| `logout.html` | post-logout page |
| `rlogin.html` | redirect/login hand-off page |
| `error.html` | login-failure page (forwards the error text) |
| `radvert.html` | advertisement frame |
| `redirect.html` | post-login redirect target |
| `errors.txt`, `errors-en.txt` | RouterOS error-message variables |
| `md5.js` | CHAP-MD5 helper required by `login.html` |

## Walled garden (WhatsApp bot link)

The pages link to the WhatsApp support/voucher bot (`wa.me`). Guests must reach
it **before** logging in, so whitelist the hosts in the walled garden:

```routeros
/ip hotspot walled-garden add dst-host=wa.me comment="WhatsApp bot link"
/ip hotspot walled-garden add dst-host=whatsapp.com comment="WhatsApp apex"
/ip hotspot walled-garden add dst-host=*.whatsapp.com comment="WhatsApp app/web"
/ip hotspot walled-garden add dst-host=whatsapp.net comment="WhatsApp apex"
/ip hotspot walled-garden add dst-host=*.whatsapp.net comment="WhatsApp media"
```

Note: `dst-host` wildcards only match subdomains — `*.whatsapp.com` does **not**
cover the apex `whatsapp.com`, so both forms are listed. `wa.me` links redirect
through `api.whatsapp.com` / `web.whatsapp.com`.

Without this, the `wa.me` links on `login.html`/`error.html`/`status.html`
dead-end behind the captive portal.
