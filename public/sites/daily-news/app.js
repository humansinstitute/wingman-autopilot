/**
 * Daily News — Runtime Static Site
 *
 * Fetches news records from Superbased at runtime using an embedded
 * public group key for client-side decryption. No build pipeline.
 *
 * Dependencies: marked (loaded via CDN for markdown rendering)
 */

// ── State ──────────────────────────────────────────────────────────

const state = {
  config: null,
  articles: [],
  filteredArticles: [],
  activeCategory: 'all',
  expandedArticleId: null,
  userPubkey: null,
  loading: true,
  error: null,
  refreshTimer: null,
};

// ── Config ─────────────────────────────────────────────────────────

async function loadConfig() {
  const res = await fetch('./config.json');
  if (!res.ok) throw new Error('Failed to load config.json');
  return res.json();
}

// ── Superbased Client ──────────────────────────────────────────────

/**
 * Fetch daily_news records from Superbased public endpoint.
 * Uses the public group pattern: records are fetched without NIP-98 auth,
 * decrypted client-side with the embedded group key.
 */
async function fetchRecords(config) {
  const url = new URL('/api/v1/records', config.superbased_url);
  url.searchParams.set('collection', config.collection);
  url.searchParams.set('app_namespace', config.app_namespace);
  if (config.owner_pubkey) {
    url.searchParams.set('owner_pubkey', config.owner_pubkey);
  }
  if (config.public_group_id) {
    url.searchParams.set('group_id', config.public_group_id);
  }

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Superbased fetch failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  return json.records || json.data || json || [];
}

// ── Decryption ─────────────────────────────────────────────────────

/**
 * Decrypt a record payload using the public group key.
 * For the initial implementation, records may already be returned
 * decrypted (if Superbased supports public groups natively) or may
 * need NIP-44-style decryption with the embedded key.
 *
 * This stub handles both cases:
 * - If record has `decrypted_payload`, use it directly
 * - If record has `encrypted_payload` and we have a group key, attempt decrypt
 * - Otherwise return the record data as-is
 */
function decryptPayload(record, groupKey) {
  // Already decrypted by server or plaintext
  if (record.decrypted_payload) {
    return parsePayload(record.decrypted_payload);
  }

  // Raw data field (some API shapes)
  if (record.data && typeof record.data === 'object') {
    return record.data;
  }

  // Payload field
  if (record.payload) {
    return parsePayload(record.payload);
  }

  // Encrypted payload — needs client-side decryption
  if (record.encrypted_payload && groupKey) {
    // TODO: Implement NIP-44 v2 client-side decryption when
    // the public group key format is finalized in Tower.
    // For now, log and return null to indicate decrypt needed.
    console.warn('Client-side decryption not yet implemented for record:', record.record_id);
    return null;
  }

  return null;
}

function parsePayload(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === 'object') return value;
  return null;
}

// ── Data Transform ─────────────────────────────────────────────────

function recordToArticle(record, groupKey) {
  const payload = decryptPayload(record, groupKey);
  if (!payload) return null;

  // Support both nested data.field and flat field shapes
  const data = payload.data || payload;

  // Skip archived records
  if (data.record_state === 'archived') return null;

  return {
    id: record.record_id || record.id || crypto.randomUUID(),
    title: data.title || 'Untitled',
    summary: data.summary || '',
    body: data.body || '',
    sourceUrl: data.source_url || null,
    category: normalizeCategory(data.category),
    publishedAt: data.published_at || record.updated_at || record.created_at || new Date().toISOString(),
    imageUrl: data.image_url || null,
    tags: parseTags(data.tags),
    version: record.version,
  };
}

function normalizeCategory(cat) {
  if (!cat) return 'general';
  const lower = cat.toLowerCase().trim();
  if (['tech', 'nostr', 'wingman', 'general'].includes(lower)) return lower;
  return 'general';
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

// ── Markdown Rendering ─────────────────────────────────────────────

/**
 * Render markdown to HTML. Uses the `marked` library if loaded,
 * otherwise falls back to basic paragraph splitting.
 */
function renderMarkdown(md) {
  if (typeof marked !== 'undefined' && marked.parse) {
    return marked.parse(md, { breaks: true });
  }
  // Basic fallback: escape HTML and convert line breaks to paragraphs
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\n\n+/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ── NIP-07 Auth ────────────────────────────────────────────────────

async function loginWithNip07() {
  if (!window.nostr) {
    state.error = 'No Nostr extension found (nos2x / Alby)';
    render();
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    state.userPubkey = pubkey;
    state.error = null;
    render();
  } catch (err) {
    state.error = `Login failed: ${err.message}`;
    render();
  }
}

function logout() {
  state.userPubkey = null;
  render();
}

function formatNpubShort(hex) {
  if (!hex) return '';
  // Simple hex truncation for display
  return hex.slice(0, 8) + '...' + hex.slice(-4);
}

// ── Date Formatting ────────────────────────────────────────────────

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ── Filtering ──────────────────────────────────────────────────────

function filterArticles() {
  if (state.activeCategory === 'all') {
    state.filteredArticles = [...state.articles];
  } else {
    state.filteredArticles = state.articles.filter(
      a => a.category === state.activeCategory
    );
  }
  // Sort reverse chronological
  state.filteredArticles.sort((a, b) =>
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

function setCategory(cat) {
  state.activeCategory = cat;
  state.expandedArticleId = null;
  filterArticles();
  render();
}

function expandArticle(id) {
  state.expandedArticleId = id;
  render();
  // Scroll to top of article
  const el = document.querySelector('.article-expanded');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function collapseArticle() {
  state.expandedArticleId = null;
  render();
}

// ── Data Loading ───────────────────────────────────────────────────

async function loadArticles() {
  const config = state.config;
  if (!config || !config.superbased_url) {
    state.error = 'Missing superbased_url in config.json';
    state.loading = false;
    render();
    return;
  }

  try {
    state.loading = true;
    state.error = null;
    render();

    const records = await fetchRecords(config);
    const articles = [];
    for (const record of records) {
      const article = recordToArticle(record, config.public_group_key);
      if (article) articles.push(article);
    }

    state.articles = articles;
    filterArticles();
    state.loading = false;
    state.error = null;
  } catch (err) {
    state.loading = false;
    state.error = err.message;
    console.error('Failed to load articles:', err);
  }
  render();
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const interval = state.config?.refresh_interval_ms || 300000;
  state.refreshTimer = setInterval(() => loadArticles(), interval);
}

// ── Rendering ──────────────────────────────────────────────────────

function getCategories() {
  const cats = new Set(state.articles.map(a => a.category));
  return ['all', ...Array.from(cats).sort()];
}

function renderHeader() {
  const title = state.config?.site_title || 'Daily News';
  const authHtml = state.userPubkey
    ? `<span class="user-badge">${formatNpubShort(state.userPubkey)}</span>
       <button class="btn" onclick="logout()">Logout</button>`
    : `<button class="btn btn-primary" onclick="loginWithNip07()">Login</button>`;

  return `
    <header class="site-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="header-actions">
        <button class="btn" onclick="loadArticles()">Refresh</button>
        ${authHtml}
      </div>
    </header>
  `;
}

function renderCategoryTabs() {
  const categories = getCategories();
  const tabs = categories.map(cat => {
    const active = cat === state.activeCategory ? 'active' : '';
    const label = cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1);
    return `<button class="category-tab ${active}" onclick="setCategory('${cat}')">${escapeHtml(label)}</button>`;
  }).join('');
  return `<nav class="category-tabs">${tabs}</nav>`;
}

function renderArticleCard(article) {
  return `
    <article class="article-card" onclick="expandArticle('${article.id}')">
      <div class="article-meta">
        <span class="article-date">${formatDate(article.publishedAt)}</span>
        <span class="category-badge ${article.category}">${escapeHtml(article.category)}</span>
      </div>
      <h2 class="article-title">${escapeHtml(article.title)}</h2>
      <p class="article-summary">${escapeHtml(article.summary)}</p>
    </article>
  `;
}

function renderExpandedArticle(article) {
  const heroHtml = article.imageUrl
    ? `<img class="hero-image" src="${escapeAttr(article.imageUrl)}" alt="${escapeAttr(article.title)}">`
    : '';
  const sourceHtml = article.sourceUrl
    ? `<a class="source-link" href="${escapeAttr(article.sourceUrl)}" target="_blank" rel="noopener">Source &rarr;</a>`
    : '';
  const tagsHtml = article.tags.length
    ? `<div class="article-tags">${article.tags.map(t => `<span class="article-tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="article-expanded">
      <a class="back-link" onclick="collapseArticle()">&larr; Back to feed</a>
      ${heroHtml}
      <div class="article-meta">
        <span class="article-date">${formatDate(article.publishedAt)}</span>
        <span class="category-badge ${article.category}">${escapeHtml(article.category)}</span>
      </div>
      <h1 class="article-title">${escapeHtml(article.title)}</h1>
      <div class="article-body">${renderMarkdown(article.body)}</div>
      ${sourceHtml}
      ${tagsHtml}
    </div>
  `;
}

function renderFeed() {
  if (state.loading) {
    return '<div class="status">Loading articles...</div>';
  }
  if (state.error) {
    return `<div class="status error">${escapeHtml(state.error)}</div>`;
  }
  if (state.filteredArticles.length === 0) {
    return '<div class="status">No articles found.</div>';
  }

  // If an article is expanded, show that
  if (state.expandedArticleId) {
    const article = state.articles.find(a => a.id === state.expandedArticleId);
    if (article) return renderExpandedArticle(article);
  }

  // Feed view
  return `<div class="news-feed">${state.filteredArticles.map(renderArticleCard).join('')}</div>`;
}

function renderFooter() {
  const desc = state.config?.site_description || '';
  return `<footer class="site-footer">${escapeHtml(desc)}</footer>`;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = renderHeader() + renderCategoryTabs() + '<main>' + renderFeed() + '</main>' + renderFooter();
}

// ── Utilities ──────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Init ───────────────────────────────────────────────────────────

async function init() {
  try {
    state.config = await loadConfig();
    render();
    await loadArticles();
    startAutoRefresh();
  } catch (err) {
    state.error = `Initialization failed: ${err.message}`;
    state.loading = false;
    render();
    console.error('Init error:', err);
  }
}

// Expose functions for inline event handlers
window.loginWithNip07 = loginWithNip07;
window.logout = logout;
window.loadArticles = loadArticles;
window.setCategory = setCategory;
window.expandArticle = expandArticle;
window.collapseArticle = collapseArticle;

// Boot
document.addEventListener('DOMContentLoaded', init);
