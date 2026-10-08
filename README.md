# Empty Recycle Bin

A Chrome (Manifest V3) extension that permanently deletes ("forgets") every record in a
Freshsales recycle bin. It works on both platforms:

| Domain | Platform | API root |
|--------|----------|----------|
| `*.freshsales.io` | Classic Freshsales | `/api` |
| `*.myfreshworks.com` | Freshworks CRM | `/crm/sales/api` |

> **Branch `without-api`:** this variant never calls the public Freshsales API (`/api`,
> `/crm/sales/api`). It reads the recycle bin through the web app's own routes and deletes by
> replaying the request the Freshsales screen itself sends for **Delete forever**, which you
> copy once from DevTools. See "One-time setup" below. `main` keeps the API version.

It is built the same way as [fs-list-view-exporter](https://github.com/sachin-murugan/fs-list-view-exporter):
it reads the open view from the URL, pages through it with your logged-in session (or an
optional API key on `main`), and retries on 429/5xx with backoff. Instead of writing a CSV
it deletes every record in the view forever.

> **This can't be undone.** Forgotten records are gone for good, including from the recycle bin.

## One-time setup (without-api branch)

For each module (Contacts, Leads, …) and each Freshsales account:

1. Open the module's **Recycle Bin** in Freshsales, then open DevTools (F12) on the **Network** tab.
2. Tick **one** record and click **Delete forever**. That record is deleted as normal.
3. Right-click the request that appeared, choose **Copy > Copy as fetch**, and paste it into
   the extension's **Options** page, then click **Save request**.

The options page shows what it understood: "many records per request" (the extension then
sends batches of 100, so 1,500 records is about 15 requests), "one record per request", or
"whole view in one request". Cookies and the security token in the pasted text are not saved.

## Use it

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder.
2. In Freshsales, open the **Recycle Bin** view of a module, e.g. Contacts > Recycle Bin.
3. Click the extension icon, then **Empty recycle bin**. It reads every record in the view first.
4. A dialog in the Freshsales tab shows how many records will go and the first few names.
   Type that number and click **Delete forever**. Progress shows in the popup and on the
   toolbar badge; **Stop** halts further deletes.

Safety rules:

- It only runs when the open view's name looks like a recycle bin ("Recycle Bin", "Deleted …",
  "Trash"). On any other view the button stays disabled, so live records are never touched.
- All record ids are read before anything is deleted, so deleting can't shift the pages.
- The first delete runs alone. If it's refused (no permission, unknown endpoint), the run
  stops before touching anything else.
- Records that fail later are skipped and listed in the page console; the rest carry on.
- Freshsales caps API calls per hour (about 1,000 on some plans), so a big recycle bin hits
  the limit part-way. The run then pauses, shows the time it will carry on, and resumes on its
  own; keep the tab open. **Stop** works while paused. Opening the popup while the limit is
  used up says so and when to try again, instead of hanging on "Checking this tab…".

Requests use your logged-in Freshsales session, plus the page's CSRF token for the deletes.
After deleting, the extension reads the recycle bin again and reports how many of the
records are really gone. See
[docs/recycle-bin-and-forget.md](docs/recycle-bin-and-forget.md) for what's confirmed and what
still needs checking against a live account.

Supported modules: Contacts, Leads, Deals, Accounts and custom modules.

## Layout

```
manifest.json
src/
  lib/            shared logic, loaded into the content script in manifest order
    platform.js   host → platform, API path styles, URL parsing, recycle bin name check
    client.js     same-origin fetch with retries, timeouts and path fallbacks
    ui-request.js turns a copied "Delete forever" request into a template and replays it
    recycle-bin.js  resolves the recycle bin view, reads its record ids, deletes them
  content/        detects the open view, confirmation dialog, runs the delete
  background/     per-tab state and toolbar badge
  popup/          Empty button, progress and Stop
  options/        paste and manage the saved "Delete forever" requests
icons/           toolbar and store icons (icon.svg is the source)
test/             node:test unit tests
tools/            read-only DevTools console probe
```

## Develop

```bash
npm test          # unit tests, no dependencies needed (Node 18+)
npm run package   # zip for the Chrome Web Store into dist/
```
