// In-page confirmation before permanently deleting. Lives in a shadow root so the Freshsales
// page styles can't reach it, and in the page (not the popup) so it survives the popup
// closing. The user has to type the number of records to enable the delete button.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});

  const PREVIEW = 8;

  const STYLE = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; background: rgba(17,24,39,.45); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .dialog { background: #fff; color: #111827; width: min(460px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 32px));
      display: flex; flex-direction: column; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
    header { padding: 14px 16px 8px; }
    h2 { font-size: 15px; margin: 0 0 4px; }
    .muted { color: #6b7280; }
    .warn { color: #b91c1c; font-weight: 600; margin: 8px 0 0; }
    ul { margin: 0; padding: 6px 16px 6px 32px; overflow: auto; flex: 1; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
    li { padding: 1px 0; word-break: break-word; }
    .confirm { padding: 10px 16px 0; }
    .confirm input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
    footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; }
    footer button { padding: 7px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: inherit; font: inherit; cursor: pointer; }
    footer .danger { background: #dc2626; border-color: #dc2626; color: #fff; font-weight: 600; }
    footer .danger:disabled { opacity: .5; cursor: default; }
    @media (prefers-color-scheme: dark) {
      .dialog { background: #111827; color: #f3f4f6; }
      .muted { color: #9ca3af; }
      .warn { color: #f87171; }
      .confirm input, footer button { background: #1f2937; border-color: #374151; color: inherit; }
      ul { border-color: #374151; }
    }
  `;

  /**
   * Show the confirmation and resolve true when the user confirms, false if they cancel.
   * `records` is [{ id, label }]; the first few are listed as a preview.
   */
  function confirmForget({ records, viewName, moduleLabel }) {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.setAttribute('data-erb-confirm', '');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>${STYLE}</style>
        <div class="backdrop">
          <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="w">
            <header>
              <h2 id="t"></h2>
              <div class="muted" id="sub"></div>
              <p class="warn" id="w">This permanently deletes them and can't be undone. They can't be restored from the recycle bin afterwards.</p>
            </header>
            <ul id="list"></ul>
            <label class="confirm">Type <b id="n"></b> to confirm
              <input id="typed" inputmode="numeric" autocomplete="off" />
            </label>
            <footer>
              <button id="cancel">Cancel</button>
              <button class="danger" id="ok" disabled>Delete forever</button>
            </footer>
          </div>
        </div>`;

      const $ = (id) => shadow.getElementById(id);
      const count = String(records.length);
      $('t').textContent = `Permanently delete ${count} ${count === '1' ? 'record' : 'records'}?`;
      $('sub').textContent = [moduleLabel, viewName].filter(Boolean).join(' · ');
      $('n').textContent = count;
      for (const r of records.slice(0, PREVIEW)) {
        const li = document.createElement('li');
        li.textContent = r.label;
        $('list').appendChild(li);
      }
      if (records.length > PREVIEW) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = `and ${records.length - PREVIEW} more`;
        $('list').appendChild(li);
      }

      const finish = (value) => {
        document.removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      };
      $('typed').addEventListener('input', (e) => {
        $('ok').disabled = e.target.value.trim() !== count;
      });
      $('cancel').addEventListener('click', () => finish(false));
      $('ok').addEventListener('click', () => {
        if ($('typed').value.trim() === count) finish(true);
      });
      document.addEventListener('keydown', onKey, true);
      document.documentElement.appendChild(host);
      $('typed').focus();
    });
  }

  FSX.confirmDialog = { confirmForget };
})(globalThis);
