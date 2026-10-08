// Platform detection and API path styles for Classic Freshsales (*.freshsales.io)
// and Freshworks CRM (*.myfreshworks.com). Same as fs-list-view-exporter's platform.js,
// plus recognising the recycle bin view.
(function (root) {
  const FSX = (root.FSX = root.FSX || {});

  const CLASSIC = {
    platform: 'classic',
    label: 'Classic Freshsales (.freshsales.io)',
    apiFallbacks: ['/api', ''],
  };

  const CRM = {
    platform: 'crm',
    label: 'Freshworks CRM (.myfreshworks.com)',
    apiFallbacks: ['/crm/sales/api', '/crm/sales'],
  };

  function detectPlatform(host) {
    const h = String(host || '').toLowerCase();
    if (h === 'freshsales.io' || h.endsWith('.freshsales.io')) return 'classic';
    // Unknown hosts prefer CRM paths first, then classic (universal fallback).
    return 'crm';
  }

  function pathStyleFor(host) {
    return detectPlatform(host) === 'classic' ? CLASSIC : CRM;
  }

  function otherStyle(style) {
    return style.platform === 'crm' ? CLASSIC : CRM;
  }

  function joinPrefix(prefix, suffix) {
    const s = suffix.startsWith('/') ? suffix : `/${suffix}`;
    if (!prefix) return s;
    return prefix.replace(/\/+$/, '') + s;
  }

  // Module slug in the web app URL -> { entity, endpoint } used by the API.
  // Products and CPQ documents are left out: they have no documented forget endpoint.
  const URL_MODULES = {
    contacts: { entity: 'contact', endpoint: 'contacts' },
    deals: { entity: 'deal', endpoint: 'deals' },
    accounts: { entity: 'sales_account', endpoint: 'sales_accounts' },
    sales_accounts: { entity: 'sales_account', endpoint: 'sales_accounts' },
    leads: { entity: 'lead', endpoint: 'leads' },
  };

  /** View names that mark the recycle bin, e.g. "Recycle Bin", "Recycle bin contacts", "Deleted contacts". */
  const RECYCLE_BIN_NAME = /recycle\s*bin|\bdeleted\b|\btrash\b/i;

  function isRecycleBinName(name) {
    return RECYCLE_BIN_NAME.test(String(name || ''));
  }

  /**
   * Work out which module the user is looking at and, when the URL carries one, which saved
   * view. Handles /contacts/view/123 (classic), /crm/sales/contacts/view/123 (CRM), hash URLs
   * and custom modules at /custom_module/cm_foo/view/123. A module page whose URL mentions the
   * recycle bin but has no numeric view id (e.g. /contacts/recycle_bin) returns viewId null and
   * recycleBinRoute true, and the view is then looked up by name. Returns null otherwise.
   */
  function parseRecycleBinUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (_e) {
      return null;
    }
    const path = url.pathname + url.hash.replace(/^#/, '');
    const recycleBinRoute = /recycle[_-]?bin|deleted|trash/i.test(path);

    const custom = path.match(/\/custom_module\/([\w-]+)(?:\/view\/(\d+))?/);
    if (custom) {
      if (!custom[2] && !recycleBinRoute) return null;
      return {
        host: url.host,
        entity: custom[1],
        endpoint: custom[1],
        custom: true,
        viewId: custom[2] || null,
        recycleBinRoute,
      };
    }
    const std = path.match(/\/(contacts|deals|accounts|sales_accounts|leads)(?:\/view\/(\d+))?(?=[/?#]|$)/);
    if (std) {
      if (!std[2] && !recycleBinRoute) return null;
      const mod = URL_MODULES[std[1]];
      return {
        host: url.host,
        entity: mod.entity,
        endpoint: mod.endpoint,
        custom: false,
        viewId: std[2] || null,
        recycleBinRoute,
      };
    }
    return null;
  }

  FSX.platform = {
    CLASSIC,
    CRM,
    detectPlatform,
    pathStyleFor,
    otherStyle,
    joinPrefix,
    parseRecycleBinUrl,
    isRecycleBinName,
  };
})(globalThis);
