/*!
 * annotate-js — vanilla-JS annotation layer for static HTML
 * Built for the AI-revision loop. Export reviewer comments as JSON,
 * hand to your agent of choice, import the result back into the revised doc.
 *
 * @license MIT
 * @version 1.0.0
 * @see https://github.com/Buzz-Interactive/annotate
 */

// ---- Types ----

type AnchorStatus = 'fresh' | 'moved' | 'stale';

interface Annotation {
  id: string;
  documentPath: string;
  sessionId: string | null;
  selectedText: string;
  sectionHeading: string;
  prefix: string;
  suffix: string;
  note: string;
  author: string;
  createdAt: string;
  color: string;
}

interface Session {
  id: string;
  name: string;
  documentPath: string;
  createdAt: string;
  isActive: boolean;
}

interface Setting {
  key: string;
  value: string;
}

interface TextContext {
  prefix: string;
  suffix: string;
}

interface FindResult {
  range: Range | null;
  quality: AnchorStatus;
}

interface NodeMapEntry {
  node: Text;
  start: number;
  end: number;
}

interface StoreMap {
  annotations: Annotation;
  sessions: Session;
  settings: Setting;
}

type StoreName = keyof StoreMap;

(function (): void {
  'use strict';

  const DB_NAME = 'annotate-js';
  const DB_VERSION = 2;
  const STORE_ANNOTATIONS = 'annotations' as const;
  const STORE_SETTINGS = 'settings' as const;
  const STORE_SESSIONS = 'sessions' as const;

  let db: IDBDatabase | null = null;
  let currentPopover: HTMLElement | null = null;
  let sidebarOpen = false;
  let sidebarView: 'annotations' | 'sessions' = 'annotations';
  let activeSessionId: string | null = null;
  const staleMap: Record<string, AnchorStatus> = {};

  const docPath = location.pathname.split('/').pop() || 'index.html';

  // ---- IndexedDB ----

  function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
        const d = req.result;
        const oldVersion = e.oldVersion;

        if (!d.objectStoreNames.contains(STORE_ANNOTATIONS)) {
          const store = d.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' });
          store.createIndex('documentPath', 'documentPath', { unique: false });
          store.createIndex('sectionHeading', 'sectionHeading', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        } else if (oldVersion < 2) {
          const tx = req.transaction;
          if (tx) {
            const store = tx.objectStore(STORE_ANNOTATIONS);
            if (!store.indexNames.contains('sessionId')) {
              store.createIndex('sessionId', 'sessionId', { unique: false });
            }
          }
        }

        if (!d.objectStoreNames.contains(STORE_SETTINGS)) {
          d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }

        if (!d.objectStoreNames.contains(STORE_SESSIONS)) {
          d.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    });
  }

  function dbPut<K extends StoreName>(store: K, data: StoreMap[K]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('Database not initialised')); return; }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbDelete(store: StoreName, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('Database not initialised')); return; }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function dbGetAll<K extends StoreName>(store: K): Promise<Array<StoreMap[K]>> {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('Database not initialised')); return; }
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll() as IDBRequest<Array<StoreMap[K]>>;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbGet<K extends StoreName>(store: K, key: string): Promise<StoreMap[K] | undefined> {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error('Database not initialised')); return; }
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key) as IDBRequest<StoreMap[K] | undefined>;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- Utilities ----

  function uuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getNearestHeading(node: Node): string {
    let el: Element | null = node.nodeType === Node.TEXT_NODE
      ? (node.parentElement as Element | null)
      : (node as Element);
    while (el) {
      let prev: Element | null = el.previousElementSibling;
      while (prev) {
        if (/^H[1-3]$/.test(prev.tagName)) return (prev.textContent || '').trim();
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return 'General';
  }

  function getTextContext(range: Range, chars: number): TextContext {
    const container = range.startContainer;
    const text = container.textContent || '';
    const start = Math.max(0, range.startOffset - chars);
    const end = Math.min(text.length, range.endOffset + chars);
    return {
      prefix: text.slice(start, range.startOffset),
      suffix: text.slice(range.endOffset, end)
    };
  }

  function removePopover(): void {
    if (currentPopover) { currentPopover.remove(); currentPopover = null; }
  }

  function closeSidebar(): void {
    const sidebar = document.querySelector('.annotate-sidebar') as HTMLElement | null;
    if (sidebar) sidebar.classList.remove('open');
    const toolbar = document.querySelector('.annotate-toolbar') as HTMLElement | null;
    if (toolbar) toolbar.style.display = '';
    sidebarOpen = false;
  }

  function hideToolbar(): void {
    const toolbar = document.querySelector('.annotate-toolbar') as HTMLElement | null;
    if (toolbar) toolbar.style.display = 'none';
  }

  function escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '...' : s;
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---- Sessions ----

  async function ensureActiveSession(): Promise<void> {
    const sessions = await dbGetAll(STORE_SESSIONS);
    const docSessions = sessions.filter((s) => s.documentPath === docPath);
    const active = docSessions.find((s) => s.isActive);

    if (active) {
      activeSessionId = active.id;
      return;
    }

    // Migrate v1 annotations or create first session
    const session: Session = {
      id: uuid(),
      name: 'Session — ' + formatDate(new Date().toISOString()),
      documentPath: docPath,
      createdAt: new Date().toISOString(),
      isActive: true
    };
    await dbPut(STORE_SESSIONS, session);
    activeSessionId = session.id;

    // Migrate any existing annotations without a sessionId
    const allAnnotations = await dbGetAll(STORE_ANNOTATIONS);
    for (const ann of allAnnotations) {
      if (ann.documentPath === docPath && !ann.sessionId) {
        ann.sessionId = session.id;
        await dbPut(STORE_ANNOTATIONS, ann);
      }
    }
  }

  async function startNewSession(): Promise<void> {
    if (!confirm('Start a new session? Current annotations will be archived and can be restored later.')) return;

    // Deactivate current session
    const sessions = await dbGetAll(STORE_SESSIONS);
    for (const s of sessions) {
      if (s.documentPath === docPath && s.isActive) {
        s.isActive = false;
        await dbPut(STORE_SESSIONS, s);
      }
    }

    // Create new session
    const session: Session = {
      id: uuid(),
      name: 'Session — ' + formatDate(new Date().toISOString()),
      documentPath: docPath,
      createdAt: new Date().toISOString(),
      isActive: true
    };
    await dbPut(STORE_SESSIONS, session);
    activeSessionId = session.id;

    await renderAnnotations();
    updateToolbarCount();
    if (sidebarOpen) {
      if (sidebarView === 'sessions') showSessionsPanel();
      else refreshSidebar();
    }
  }

  async function restoreSession(sessionId: string): Promise<void> {
    const sessions = await dbGetAll(STORE_SESSIONS);
    for (const s of sessions) {
      if (s.documentPath === docPath) {
        s.isActive = (s.id === sessionId);
        await dbPut(STORE_SESSIONS, s);
      }
    }
    activeSessionId = sessionId;

    await renderAnnotations();
    updateToolbarCount();
    if (sidebarOpen) showSessionsPanel();
  }

  async function deleteSession(sessionId: string): Promise<void> {
    if (!confirm('Permanently delete this session and all its annotations? This cannot be undone.')) return;

    // Delete all annotations in the session
    const all = await dbGetAll(STORE_ANNOTATIONS);
    for (const ann of all) {
      if (ann.sessionId === sessionId) {
        await dbDelete(STORE_ANNOTATIONS, ann.id);
      }
    }

    // Delete the session
    await dbDelete(STORE_SESSIONS, sessionId);

    if (sidebarOpen) showSessionsPanel();
  }

  async function exportSession(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    const text = await generateExportText(sessionId);
    if (!text) {
      alert('No annotations in this session.');
      return;
    }

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const author = await getAuthor() || 'unknown';
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    const safeName = author.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    a.download = `${docPath.replace('.html', '')}-${safeName}-${timestamp}.annotations.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Text anchoring ----

  function findTextInDocument(selectedText: string, prefix: string, suffix: string): FindResult {
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n: Node): number => {
          const p = n.parentElement;
          if (p && (p.closest('.annotate-toolbar') || p.closest('.annotate-sidebar') ||
              p.closest('.annotate-popover') || p.closest('.annotate-modal-overlay') ||
              p.closest('script') || p.closest('style'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    let fullText = '';
    const nodeMap: NodeMapEntry[] = [];
    textNodes.forEach((node) => {
      const start = fullText.length;
      fullText += node.textContent || '';
      nodeMap.push({ node, start, end: fullText.length });
    });

    let matchQuality: AnchorStatus = 'fresh';
    const searchText = prefix + selectedText + suffix;
    let idx = fullText.indexOf(searchText);
    let matchStart = idx >= 0 ? idx + prefix.length : -1;

    // Fallback: text found but surrounding context changed — may have moved
    if (matchStart < 0) {
      idx = fullText.indexOf(selectedText);
      matchStart = idx;
      if (matchStart >= 0) matchQuality = 'moved';
    }

    // Text not found at all — stale
    if (matchStart < 0) return { range: null, quality: 'stale' };

    const matchEnd = matchStart + selectedText.length;
    const range = document.createRange();
    let startSet = false;

    for (const nm of nodeMap) {
      if (!startSet && nm.end > matchStart) {
        range.setStart(nm.node, matchStart - nm.start);
        startSet = true;
      }
      if (startSet && nm.end >= matchEnd) {
        range.setEnd(nm.node, matchEnd - nm.start);
        break;
      }
    }

    return { range, quality: matchQuality };
  }

  function highlightRange(range: Range, annotationId: string): HTMLSpanElement | null {
    // Collect all text nodes within the range
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n: Node): number => {
          if (range.intersectsNode(n)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_REJECT;
        }
      }
    );
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    // If single text node, simple wrap
    if (textNodes.length <= 1) {
      const span = document.createElement('span');
      span.className = 'annotate-highlight';
      span.dataset.annotationId = annotationId;
      try {
        range.surroundContents(span);
        return span;
      } catch (e) {
        // Fall through to per-node approach
      }
    }

    // Wrap each text node (or partial text node) individually
    // This avoids breaking table/element boundaries
    let firstSpan: HTMLSpanElement | null = null;
    for (const node of textNodes) {
      const nodeRange = document.createRange();

      if (node === range.startContainer) {
        nodeRange.setStart(node, range.startOffset);
      } else {
        nodeRange.setStart(node, 0);
      }

      if (node === range.endContainer) {
        nodeRange.setEnd(node, range.endOffset);
      } else {
        nodeRange.setEnd(node, (node.textContent || '').length);
      }

      if (nodeRange.toString().length === 0) continue;

      const span = document.createElement('span');
      span.className = 'annotate-highlight';
      span.dataset.annotationId = annotationId;
      nodeRange.surroundContents(span);
      if (!firstSpan) firstSpan = span;
    }

    return firstSpan;
  }

  // ---- Author ----

  async function getAuthor(): Promise<string | null> {
    const setting = await dbGet(STORE_SETTINGS, 'authorName');
    return setting ? setting.value : null;
  }

  function promptForAuthor(): Promise<string> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'annotate-modal-overlay';
      overlay.innerHTML = `
        <div class="annotate-modal annotate-help-modal">
          <h3>Welcome to document annotations</h3>

          <p>You can add notes to any part of this document by selecting text. Here's how it works:</p>

          <p><strong>Adding a note</strong><br>
          Select any text on the page. A prompt will appear — click it, type your note, and press Save. The text will be highlighted in yellow.</p>

          <div class="annotate-alert-info">
            <strong>Important — your notes are stored locally</strong><br>
            Annotations are saved in your browser only. They are <strong>not</strong> sent to us automatically. To share your feedback, you need to export and email them.
          </div>

          <p>You can review these instructions anytime by clicking <strong>?</strong> in the toolbar.</p>

          <hr style="border:none; border-top:1px solid #eaeff2; margin: 16px 0;">

          <p><strong>Before you start, what name should appear on your annotations?</strong></p>
          <input type="text" placeholder="e.g. Alex Smith" autofocus>
          <div style="text-align:right;">
            <button class="annotate-btn annotate-btn-save">Get started</button>
          </div>

          <hr style="border:none; border-top:1px solid #eaeff2; margin: 16px 0 12px;">

          <p style="font-size: 0.85em; color: #6a6a6a; margin: 0; text-align: center;">
            Developed by <a href="https://buzzinteractive.co.uk" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Buzz Interactive</a>.
          </p>
        </div>
      `;
      document.body.appendChild(overlay);

      const input = overlay.querySelector('input') as HTMLInputElement;
      const btn = overlay.querySelector('button') as HTMLButtonElement;
      const submit = async (): Promise<void> => {
        const name = input.value.trim();
        if (!name) return;
        await dbPut(STORE_SETTINGS, { key: 'authorName', value: name });
        overlay.remove();
        resolve(name);
      };
      btn.addEventListener('click', submit);
      input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); });
      input.focus();
    });
  }

  // ---- Popover UI ----

  function showAnnotatePopover(range: Range, rect: DOMRect): void {
    removePopover();

    const pop = document.createElement('div');
    pop.className = 'annotate-popover';
    pop.innerHTML = `<div class="annotate-popover-prompt">📝 Annotate this selection</div>`;
    document.body.appendChild(pop);

    const top = rect.bottom + window.scrollY + 8;
    const left = Math.min(rect.left + window.scrollX, window.innerWidth - 320);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, left) + 'px';
    currentPopover = pop;

    const prompt = pop.querySelector('.annotate-popover-prompt') as HTMLElement;
    prompt.addEventListener('click', async () => {
      let author = await getAuthor();
      if (!author) author = await promptForAuthor();

      const selectedText = range.toString();
      const ctx = getTextContext(range, 30);
      const section = getNearestHeading(range.startContainer);

      pop.innerHTML = `
        <div class="annotate-popover-form">
          <textarea placeholder="Add your note..."></textarea>
          <div class="annotate-popover-actions">
            <button class="annotate-btn annotate-btn-cancel">Cancel</button>
            <button class="annotate-btn annotate-btn-save">Save</button>
          </div>
        </div>
      `;

      const textarea = pop.querySelector('textarea') as HTMLTextAreaElement;
      textarea.focus();

      const cancelBtn = pop.querySelector('.annotate-btn-cancel') as HTMLButtonElement;
      const saveBtn = pop.querySelector('.annotate-btn-save') as HTMLButtonElement;
      cancelBtn.addEventListener('click', removePopover);
      saveBtn.addEventListener('click', async () => {
        const note = textarea.value.trim();
        if (!note) return;

        const annotation: Annotation = {
          id: uuid(),
          documentPath: docPath,
          sessionId: activeSessionId,
          selectedText,
          sectionHeading: section,
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          note,
          author: author as string,
          createdAt: new Date().toISOString(),
          color: 'yellow'
        };

        await dbPut(STORE_ANNOTATIONS, annotation);
        removePopover();

        const result = findTextInDocument(selectedText, ctx.prefix, ctx.suffix);
        if (result.range) highlightRange(result.range, annotation.id);

        updateToolbarCount();
        if (sidebarOpen && sidebarView === 'annotations') refreshSidebar();
        window.getSelection()?.removeAllRanges();
      });
    });
  }

  function showViewPopover(annotationId: string, rect: DOMRect): void {
    removePopover();

    dbGet(STORE_ANNOTATIONS, annotationId).then((ann) => {
      if (!ann) return;

      const pop = document.createElement('div');
      pop.className = 'annotate-popover';
      pop.innerHTML = `
        <div class="annotate-view">
          <div class="annotate-view-quote">"${escapeHtml(truncate(ann.selectedText, 80))}"</div>
          <div class="annotate-view-note">${escapeHtml(ann.note)}</div>
          <div class="annotate-view-meta">— ${escapeHtml(ann.author)}, ${formatDate(ann.createdAt)}</div>
          <div class="annotate-popover-actions">
            <button class="annotate-btn annotate-btn-delete">Delete</button>
            <button class="annotate-btn annotate-btn-cancel">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(pop);

      const top = rect.bottom + window.scrollY + 8;
      const left = Math.min(rect.left + window.scrollX, window.innerWidth - 320);
      pop.style.top = top + 'px';
      pop.style.left = Math.max(8, left) + 'px';
      currentPopover = pop;

      const cancelBtn = pop.querySelector('.annotate-btn-cancel') as HTMLButtonElement;
      const deleteBtn = pop.querySelector('.annotate-btn-delete') as HTMLButtonElement;
      cancelBtn.addEventListener('click', removePopover);
      deleteBtn.addEventListener('click', async () => {
        await dbDelete(STORE_ANNOTATIONS, ann.id);
        document.querySelectorAll(`.annotate-highlight[data-annotation-id="${ann.id}"]`).forEach((hl) => {
          const parent = hl.parentNode;
          if (!parent) return;
          while (hl.firstChild) parent.insertBefore(hl.firstChild, hl);
          parent.removeChild(hl);
          (parent as Node & { normalize(): void }).normalize();
        });
        removePopover();
        updateToolbarCount();
        if (sidebarOpen && sidebarView === 'annotations') refreshSidebar();
      });
    });
  }

  // ---- Toolbar ----

  function createToolbar(): void {
    const bar = document.createElement('div');
    bar.className = 'annotate-toolbar';
    bar.innerHTML = `
      <div class="annotate-toolbar-item" data-action="list">
        📝 <span class="annotate-toolbar-count">0</span> annotations
      </div>
      <div class="annotate-toolbar-item" data-action="export">↓ Export</div>
      <div class="annotate-toolbar-item" data-action="import">↑ Import</div>
      <div class="annotate-toolbar-item" data-action="copy">📋 Copy</div>
      <div class="annotate-toolbar-item" data-action="new-session">⟳ New</div>
      <div class="annotate-toolbar-item" data-action="sessions">📂 Sessions</div>
      <div class="annotate-toolbar-item" data-action="help">?</div>
    `;
    document.body.appendChild(bar);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.txt,.md';
    fileInput.className = 'annotate-file-input';
    document.body.appendChild(fileInput);

    (bar.querySelector('[data-action="list"]') as HTMLElement).addEventListener('click', () => {
      sidebarView = 'annotations';
      toggleSidebar();
    });
    (bar.querySelector('[data-action="export"]') as HTMLElement).addEventListener('click', () => exportSession(activeSessionId));
    (bar.querySelector('[data-action="import"]') as HTMLElement).addEventListener('click', () => fileInput.click());
    (bar.querySelector('[data-action="copy"]') as HTMLElement).addEventListener('click', copyAnnotations);
    (bar.querySelector('[data-action="new-session"]') as HTMLElement).addEventListener('click', startNewSession);
    (bar.querySelector('[data-action="sessions"]') as HTMLElement).addEventListener('click', () => {
      sidebarView = 'sessions';
      toggleSidebar();
    });
    (bar.querySelector('[data-action="help"]') as HTMLElement).addEventListener('click', showHelp);
    fileInput.addEventListener('change', handleImport);

    updateToolbarCount();
  }

  async function updateToolbarCount(): Promise<void> {
    const all = await dbGetAll(STORE_ANNOTATIONS);
    const count = all.filter((a) => a.documentPath === docPath && a.sessionId === activeSessionId).length;
    const el = document.querySelector('.annotate-toolbar-count') as HTMLElement | null;
    if (el) el.textContent = String(count);
  }

  // ---- Sidebar ----

  function createSidebar(): void {
    const sidebar = document.createElement('div');
    sidebar.className = 'annotate-sidebar';
    sidebar.innerHTML = `
      <div class="annotate-sidebar-header">
        <h3>Annotations</h3>
        <button class="annotate-sidebar-close">&times;</button>
      </div>
      <div class="annotate-sidebar-content"></div>
      <div class="annotate-sidebar-footer">
        <button class="annotate-sidebar-action" data-action="sidebar-export">↓ Export</button>
        <button class="annotate-sidebar-action" data-action="sidebar-copy">📋 Copy</button>
        <button class="annotate-sidebar-action" data-action="sidebar-import">↑ Import</button>
        <button class="annotate-sidebar-action" data-action="sidebar-new-session">⟳ New</button>
        <button class="annotate-sidebar-action" data-action="sidebar-sessions">📂 Sessions</button>
        <button class="annotate-sidebar-action" data-action="sidebar-help">?</button>
      </div>
    `;
    document.body.appendChild(sidebar);
    (sidebar.querySelector('.annotate-sidebar-close') as HTMLElement).addEventListener('click', closeSidebar);

    // Sidebar footer actions
    const fileInput = document.querySelector('.annotate-file-input') as HTMLInputElement;
    (sidebar.querySelector('[data-action="sidebar-export"]') as HTMLElement).addEventListener('click', () => exportSession(activeSessionId));
    (sidebar.querySelector('[data-action="sidebar-copy"]') as HTMLElement).addEventListener('click', async () => {
      if (!activeSessionId) return;
      const text = await generateExportText(activeSessionId);
      if (!text) { alert('No annotations to copy.'); return; }
      await navigator.clipboard.writeText(text);
      const btn = sidebar.querySelector('[data-action="sidebar-copy"]') as HTMLElement;
      const original = btn.innerHTML;
      btn.innerHTML = '✓ Copied';
      setTimeout(() => { btn.innerHTML = original; }, 1500);
    });
    (sidebar.querySelector('[data-action="sidebar-import"]') as HTMLElement).addEventListener('click', () => fileInput.click());
    (sidebar.querySelector('[data-action="sidebar-new-session"]') as HTMLElement).addEventListener('click', startNewSession);
    (sidebar.querySelector('[data-action="sidebar-sessions"]') as HTMLElement).addEventListener('click', () => {
      sidebarView = 'sessions';
      showSessionsPanel();
    });
    (sidebar.querySelector('[data-action="sidebar-help"]') as HTMLElement).addEventListener('click', showHelp);
  }

  async function refreshSidebar(): Promise<void> {
    const sidebar = document.querySelector('.annotate-sidebar') as HTMLElement;
    const header = sidebar.querySelector('.annotate-sidebar-header h3') as HTMLElement;
    const content = sidebar.querySelector('.annotate-sidebar-content') as HTMLElement;
    header.textContent = 'Annotations';

    const all = await dbGetAll(STORE_ANNOTATIONS);
    const annotations = all
      .filter((a) => a.documentPath === docPath && a.sessionId === activeSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (annotations.length === 0) {
      content.innerHTML = '<div class="annotate-sidebar-empty">No annotations in this session.<br>Select text on the page to add one.</div>';
    } else {
      const groups: Record<string, Annotation[]> = {};
      annotations.forEach((a) => {
        if (!groups[a.sectionHeading]) groups[a.sectionHeading] = [];
        groups[a.sectionHeading].push(a);
      });

      let html = '';
      for (const [section, anns] of Object.entries(groups)) {
        html += `<div class="annotate-sidebar-section">${escapeHtml(section)}</div>`;
        anns.forEach((a) => {
          const quality = staleMap[a.id] || 'fresh';
          const staleLabel = quality === 'stale' ? '<span class="annotate-stale-badge stale">text changed</span>'
            : quality === 'moved' ? '<span class="annotate-stale-badge moved">text moved</span>'
            : '';
          html += `
            <div class="annotate-sidebar-item ${quality !== 'fresh' ? 'annotate-sidebar-item--' + quality : ''}" data-annotation-id="${a.id}">
              <div class="annotate-sidebar-item-content">
                <div class="annotate-sidebar-item-quote">"${escapeHtml(truncate(a.selectedText, 60))}" ${staleLabel}</div>
                <div class="annotate-sidebar-item-note">${escapeHtml(truncate(a.note, 120))}</div>
                <div class="annotate-sidebar-item-meta">— ${escapeHtml(a.author)}, ${formatDate(a.createdAt)}</div>
              </div>
              <button class="annotate-btn annotate-btn-delete-annotation" data-annotation-id="${a.id}" title="Delete annotation">✕</button>
            </div>
          `;
        });
      }
      content.innerHTML = html;

      content.querySelectorAll('.annotate-sidebar-item-content').forEach((contentEl) => {
        contentEl.addEventListener('click', () => {
          const item = contentEl.closest('.annotate-sidebar-item') as HTMLElement | null;
          if (!item) return;
          const id = item.dataset.annotationId;
          if (!id) return;
          const hl = document.querySelector(`.annotate-highlight[data-annotation-id="${id}"]`) as HTMLElement | null;
          if (hl) {
            closeSidebar();
            hl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            hl.style.transition = 'background-color 0.3s';
            hl.style.backgroundColor = 'rgba(140, 198, 63, 0.4)';
            setTimeout(() => { hl.style.backgroundColor = ''; }, 1500);
          }
        });
      });

      content.querySelectorAll('.annotate-btn-delete-annotation').forEach((btnEl) => {
        const btn = btnEl as HTMLButtonElement;
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = btn.dataset.annotationId;
          if (!id) return;
          await dbDelete(STORE_ANNOTATIONS, id);
          document.querySelectorAll(`.annotate-highlight[data-annotation-id="${id}"]`).forEach((hl) => {
            const parent = hl.parentNode;
            if (!parent) return;
            while (hl.firstChild) parent.insertBefore(hl.firstChild, hl);
            parent.removeChild(hl);
            (parent as Node & { normalize(): void }).normalize();
          });
          updateToolbarCount();
          refreshSidebar();
        });
      });
    }
  }

  async function showSessionsPanel(): Promise<void> {
    const sidebar = document.querySelector('.annotate-sidebar') as HTMLElement;
    const header = sidebar.querySelector('.annotate-sidebar-header h3') as HTMLElement;
    const content = sidebar.querySelector('.annotate-sidebar-content') as HTMLElement;
    header.textContent = 'Sessions';

    const sessions = await dbGetAll(STORE_SESSIONS);
    const docSessions = sessions
      .filter((s) => s.documentPath === docPath)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const allAnnotations = await dbGetAll(STORE_ANNOTATIONS);

    if (docSessions.length === 0) {
      content.innerHTML = '<div class="annotate-sidebar-empty">No sessions yet.</div>';
    } else {
      let html = '';
      for (const s of docSessions) {
        const count = allAnnotations.filter((a) => a.sessionId === s.id).length;
        const isActive = s.id === activeSessionId;
        html += `
          <div class="annotate-session-item ${isActive ? 'active' : ''}">
            <div class="annotate-session-indicator">${isActive ? '●' : '○'}</div>
            <div class="annotate-session-info">
              <div class="annotate-session-name">${escapeHtml(s.name)}</div>
              <div class="annotate-session-meta">${count} annotation${count !== 1 ? 's' : ''}${isActive ? ' (active)' : ''}</div>
            </div>
            <div class="annotate-session-actions">
              ${!isActive ? `<button class="annotate-btn annotate-btn-restore" data-session-id="${s.id}">Restore</button>` : ''}
              <button class="annotate-btn annotate-btn-export-session" data-session-id="${s.id}">Export</button>
              ${!isActive ? `<button class="annotate-btn annotate-btn-delete-session" data-session-id="${s.id}">Delete</button>` : ''}
            </div>
          </div>
        `;
      }
      content.innerHTML = html;

      content.querySelectorAll('.annotate-btn-restore').forEach((btnEl) => {
        const btn = btnEl as HTMLButtonElement;
        btn.addEventListener('click', () => {
          const id = btn.dataset.sessionId;
          if (id) restoreSession(id);
        });
      });
      content.querySelectorAll('.annotate-btn-export-session').forEach((btnEl) => {
        const btn = btnEl as HTMLButtonElement;
        btn.addEventListener('click', () => {
          const id = btn.dataset.sessionId;
          if (id) exportSession(id);
        });
      });
      content.querySelectorAll('.annotate-btn-delete-session').forEach((btnEl) => {
        const btn = btnEl as HTMLButtonElement;
        btn.addEventListener('click', () => {
          const id = btn.dataset.sessionId;
          if (id) deleteSession(id);
        });
      });
    }

    sidebar.classList.add('open');
    sidebarOpen = true;
    hideToolbar();
  }

  async function toggleSidebar(): Promise<void> {
    const sidebar = document.querySelector('.annotate-sidebar') as HTMLElement;
    if (sidebarOpen) {
      closeSidebar();
      return;
    }

    if (sidebarView === 'sessions') {
      await showSessionsPanel();
    } else {
      await refreshSidebar();
      sidebar.classList.add('open');
      sidebarOpen = true;
    }
    hideToolbar();
  }

  // ---- Help ----

  function showHelp(): void {
    const overlay = document.createElement('div');
    overlay.className = 'annotate-modal-overlay';
    overlay.innerHTML = `
      <div class="annotate-modal annotate-help-modal">
        <h3>How to use annotations</h3>

        <p><strong>Adding a note</strong><br>
        Select any text on the page. A prompt will appear — click it, type your note, and press Save. The text will be highlighted in yellow.</p>

        <p><strong>Viewing a note</strong><br>
        Click any highlighted text to see the note. You can also delete it from there.</p>

        <div class="annotate-alert-info">
          <strong>Important — your notes are stored locally</strong><br>
          Annotations are saved in your browser only. They are <strong>not</strong> sent to us automatically. To share your feedback, you need to export and email them.
        </div>

        <p><strong>Sessions</strong><br>
        Click <strong>⟳ New</strong> to start a fresh set of annotations. Your previous notes are archived and can be restored anytime from <strong>📂 Sessions</strong>.</p>

        <p><strong>Tables</strong><br>
        Annotations work within individual table cells. To annotate a table, select text within a single cell.</p>

        <div style="text-align:right; margin-top: 16px;">
          <button class="annotate-btn annotate-btn-save">Got it</button>
        </div>

        <hr style="border:none; border-top:1px solid #eaeff2; margin: 16px 0 12px;">

        <p style="font-size: 0.85em; color: #6a6a6a; margin: 0; text-align: center;">
          Developed by <a href="https://buzzinteractive.co.uk" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Buzz Interactive</a>.
        </p>
      </div>
    `;
    document.body.appendChild(overlay);

    (overlay.querySelector('button') as HTMLButtonElement).addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ---- Generate export text ----

  async function generateExportText(sessionId: string): Promise<string | null> {
    const all = await dbGetAll(STORE_ANNOTATIONS);
    const annotations = all
      .filter((a) => a.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (annotations.length === 0) return null;

    const session = await dbGet(STORE_SESSIONS, sessionId);
    const groups: Record<string, Annotation[]> = {};
    annotations.forEach((a) => {
      if (!groups[a.sectionHeading]) groups[a.sectionHeading] = [];
      groups[a.sectionHeading].push(a);
    });

    let md = `---\ndocument: ${docPath}\nsession: ${session ? session.name : 'Unknown'}\nexported: ${new Date().toISOString()}\ntotal_annotations: ${annotations.length}\n---\n`;

    for (const [section, anns] of Object.entries(groups)) {
      md += `\n## ${section}\n`;
      anns.forEach((a) => {
        md += `\n> "${a.selectedText}"\n\n${a.note}\n\n— ${a.author}, ${a.createdAt.slice(0, 10)}\n\n---\n`;
      });
    }

    return md;
  }

  // ---- Copy to clipboard ----

  async function copyAnnotations(): Promise<void> {
    if (!activeSessionId) return;
    const text = await generateExportText(activeSessionId);
    if (!text) {
      alert('No annotations to copy on this page.');
      return;
    }

    await navigator.clipboard.writeText(text);

    // Brief visual feedback on the toolbar button
    const btn = document.querySelector('[data-action="copy"]') as HTMLElement | null;
    if (!btn) return;
    const original = btn.innerHTML;
    btn.innerHTML = '✓ Copied';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  }

  // ---- Import ----

  type ImportedAnnotation = Omit<Annotation, 'id' | 'documentPath' | 'sessionId'>;

  async function handleImport(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const annotations = parseAnnotationsMd(text);

    if (annotations.length === 0) {
      alert('No annotations found in the file.');
      return;
    }

    const existing = await dbGetAll(STORE_ANNOTATIONS);
    const existingKeys = new Set(
      existing.filter((a) => a.sessionId === activeSessionId)
        .map((a) => a.selectedText + '||' + a.sectionHeading)
    );

    let imported = 0;
    for (const ann of annotations) {
      const key = ann.selectedText + '||' + ann.sectionHeading;
      if (existingKeys.has(key)) continue;

      const fullAnnotation: Annotation = {
        ...ann,
        id: uuid(),
        documentPath: docPath,
        sessionId: activeSessionId
      };
      await dbPut(STORE_ANNOTATIONS, fullAnnotation);
      imported++;
    }

    await renderAnnotations();
    updateToolbarCount();
    if (sidebarOpen && sidebarView === 'annotations') refreshSidebar();
    alert(`Imported ${imported} annotation${imported !== 1 ? 's' : ''} (${annotations.length - imported} duplicates skipped).`);

    target.value = '';
  }

  function parseAnnotationsMd(text: string): ImportedAnnotation[] {
    const annotations: ImportedAnnotation[] = [];
    const bodyMatch = text.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1] : text;

    const blocks = body.split(/\n---\n/);
    let currentSection = 'General';

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const sectionMatch = trimmed.match(/^## (.+)/m);
      if (sectionMatch) currentSection = sectionMatch[1].trim();

      const quoteMatch = trimmed.match(/> "(.+?)"/s);
      const metaMatch = trimmed.match(/— (.+?), (\d{4}-\d{2}-\d{2})/);

      if (quoteMatch) {
        const selectedText = quoteMatch[1];
        const note = trimmed
          .replace(/^## .+\n*/m, '')
          .replace(/> ".+?"\n*/s, '')
          .replace(/— .+?, \d{4}-\d{2}-\d{2}.*$/m, '')
          .trim();

        annotations.push({
          selectedText,
          sectionHeading: currentSection,
          prefix: '',
          suffix: '',
          note: note || '(no note)',
          author: metaMatch ? metaMatch[1] : 'Unknown',
          createdAt: metaMatch ? metaMatch[2] + 'T00:00:00Z' : new Date().toISOString(),
          color: 'yellow'
        });
      }
    }

    return annotations;
  }

  // ---- Render ----

  async function renderAnnotations(): Promise<void> {
    document.querySelectorAll('.annotate-highlight').forEach((hl) => {
      const parent = hl.parentNode;
      if (!parent) return;
      while (hl.firstChild) parent.insertBefore(hl.firstChild, hl);
      parent.removeChild(hl);
      (parent as Node & { normalize(): void }).normalize();
    });

    // Clear stale map
    Object.keys(staleMap).forEach((k) => delete staleMap[k]);

    const all = await dbGetAll(STORE_ANNOTATIONS);
    const annotations = all.filter((a) => a.documentPath === docPath && a.sessionId === activeSessionId);

    for (const ann of annotations) {
      const result = findTextInDocument(ann.selectedText, ann.prefix, ann.suffix);
      staleMap[ann.id] = result.quality;

      if (result.range) {
        highlightRange(result.range, ann.id);
        // Apply stale/moved styling to all spans for this annotation
        if (result.quality !== 'fresh') {
          document.querySelectorAll(`.annotate-highlight[data-annotation-id="${ann.id}"]`).forEach((el) => {
            el.classList.add('annotate-highlight--' + result.quality);
          });
        }
      }
    }
  }

  // ---- Event listeners ----

  function init(): void {
    document.addEventListener('mouseup', (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.annotate-popover') || target.closest('.annotate-toolbar') ||
          target.closest('.annotate-sidebar') || target.closest('.annotate-modal-overlay')) return;

      const highlight = target.closest('.annotate-highlight') as HTMLElement | null;
      if (highlight) {
        const rect = highlight.getBoundingClientRect();
        if (highlight.dataset.annotationId) {
          showViewPopover(highlight.dataset.annotationId, rect);
        }
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.toString().trim().length < 3) {
        setTimeout(() => {
          if (currentPopover && !currentPopover.matches(':hover')) removePopover();
        }, 200);
        return;
      }

      const range = selection.getRangeAt(0);

      // Prevent annotations that span across table cells — they break table layout
      const startEl = range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : (range.startContainer as Element);
      const endEl = range.endContainer.nodeType === Node.TEXT_NODE
        ? range.endContainer.parentElement
        : (range.endContainer as Element);
      const startCell = startEl ? startEl.closest('td,th') : null;
      const endCell = endEl ? endEl.closest('td,th') : null;
      if (startCell && endCell && startCell !== endCell) {
        removePopover();
        const pop = document.createElement('div');
        pop.className = 'annotate-popover';
        pop.innerHTML = '<div class="annotate-popover-prompt" style="cursor:default; color:#999;">Annotations can only be made within a single table cell</div>';
        document.body.appendChild(pop);
        const r = range.getBoundingClientRect();
        pop.style.top = (r.bottom + window.scrollY + 8) + 'px';
        pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 320)) + 'px';
        currentPopover = pop;
        setTimeout(removePopover, 2500);
        return;
      }

      const rect = range.getBoundingClientRect();
      showAnnotatePopover(range, rect);
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { removePopover(); closeSidebar(); }
    });

    document.addEventListener('mousedown', (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (currentPopover && target && !currentPopover.contains(target) &&
          !(target as Element).closest?.('.annotate-highlight')) {
        removePopover();
      }
    });

    createToolbar();
    createSidebar();
    renderAnnotations();
  }

  // ---- Boot ----

  openDB()
    .then(() => ensureActiveSession())
    .then(init)
    .then(async () => {
      const author = await getAuthor();
      if (!author) await promptForAuthor();
    })
    .catch((err: unknown) => console.error('Annotation system failed to initialise:', err));
})();
