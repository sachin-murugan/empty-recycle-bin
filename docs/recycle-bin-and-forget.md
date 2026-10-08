# Recycle bin and forget: findings

## without-api branch (2026-10-08)

Asked for after the API version hit the hourly API limit. This branch:

- Reads `filters` and `{module}/view/{id}` through the web app's routes only
  (`/crm/sales/...` on CRM, `/...` on classic). The exporter kept these as fallbacks behind
  the `/api` prefixes; they are **(to verify)** as JSON endpoints on a live account. If they
  answer HTML instead, the run stops with "Could not read the recycle bin…".
- Deletes by replaying the request the Freshsales UI sends for **Delete forever**, captured
  once by the user with DevTools "Copy as fetch". The real endpoint and body are unknown
  until someone captures one, so `ui-request.js` handles the common shapes: an id array in a
  JSON body (batches of 100), `ids[]` form fields, an id in the URL path (one request per
  record), or no ids at all (the whole view in one request).
- Checks its own work: after deleting, it reads the recycle bin again and reports how many
  of the targeted records are still there.
- Whether the UI's own routes count against the API's hourly limit is **(to verify)**. Even
  if they do, a bulk request deletes 100 records per call, so a recycle bin of 1,500 is about
  15 requests instead of 1,500.

An earlier idea, having the extension watch the page's own network calls to learn the
request automatically, was dropped: patching the page's `fetch`/`XMLHttpRequest` is more
invasive than a one-time copy and paste the user controls.

## API version (main)

Status: built from the patterns confirmed for
[fs-list-view-exporter](https://github.com/sachin-murugan/fs-list-view-exporter/blob/main/docs/auth-and-list-view.md)
(session-cookie GETs on `/crm/sales/api` and `/api`, the `filters` list, and paging a
view with `page`/`per_page`). Nothing here has been run against a live account yet, so
every write-side claim is **(to verify)**.

## What the extension assumes

| Step | Request | Status |
|---|---|---|
| Find the view name | `GET {api}/{module}/filters` | Confirmed shape in the exporter |
| Read the recycle bin | `GET {api}/{module}/view/{recycle bin view id}?page=N&per_page=100` | **(to verify)** that the recycle bin is a saved view this endpoint serves |
| Forget a record | `DELETE {api}/{module}/{id}/forget` | Documented public API for contacts and leads; **(to verify)** for deals, accounts and custom modules (`custom_module/{entity}/{id}/forget`) |
| Session writes | `X-CSRF-Token` from `<meta name="csrf-token">` | **(to verify)**; the API key fallback avoids it |

Freshsales' own docs describe forget as permanently deleting a contact or lead and its
associated data (the GDPR "right to be forgotten"). Whether forget accepts a record that is
already in the recycle bin is part of what needs checking; a JSON 404 is treated as "already
gone" and counted as deleted.

## Rate limits (seen live, 2026-10-08)

A live run stalled after about 1,000 deletes, and the popup then hung on every page: session
requests count against the account's hourly API limit, and the client slept through each
429's Retry-After (up to an hour) inside every request. Now a 429 with a long Retry-After is
handed back to the caller: the run pauses all workers until the limit resets and shows when it
will resume, and the popup's check fails fast with the reset time. Each request also times out
after 60 s so a stuck connection can't hang the run.

## URL shapes

The recycle bin is expected to open as a normal saved view
(`/crm/sales/contacts/view/<id>`, `/contacts/view/<id>`, or `#/contacts/view/<id>`). As a
fallback, a module URL that mentions `recycle_bin`, `deleted` or `trash` without a view id is
matched to the module's view whose name looks like a recycle bin.

## Safety gate

The run refuses unless the resolved view name matches `recycle bin`, `deleted` or `trash`.
If the view list can't be read, the name is unknown and nothing is deleted.

## Verify in one step (read-only)

Open the recycle bin of a module while logged in, paste
[`tools/recycle-bin-probe.js`](../tools/recycle-bin-probe.js) into the DevTools console and
share the `[probe]` lines. It prints the URL shape, the module's saved views, whether the
page has a CSRF token, and the first page's status and keys. It sends no DELETE.
