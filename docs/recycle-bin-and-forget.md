# Recycle bin and forget: findings

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
