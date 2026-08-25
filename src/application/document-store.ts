import type { BlackboardFile, Stroke } from '../domain/entities';
import type { IDrawingRepository } from '../domain/ports';
import type { TextItem } from '../domain/text-item';
import { serialize, deserialize, stampFormatVersion, textItemsOf, withTextItems } from './file-format';

/**
 * A handle to the shared document for one file path, held by a single mounted surface.
 * Each acquire() returns a distinct handle (a distinct subscriber identity), so a commit
 * from one surface notifies its siblings but never itself.
 */
export interface SharedDocumentHandle {
  /** Canonical strokes for the path (authoritative across all surfaces). */
  getStrokes(): Stroke[];
  /** Canonical file (for the saved width/height used as a stable fit reference). */
  getFile(): BlackboardFile;
  /** Canonical text labels of the document. */
  getTextItems(): TextItem[];
  /**
   * Replace the document's labels and persist through the same debounced save as strokes.
   * Text is part of the document, so this is `commit` for the text layer — same dirty flag,
   * same debounce, same sibling refresh, same file.
   */
  commitText(items: TextItem[]): void;
  /** Register this surface's refresh callback (fired when a sibling or external edit lands). */
  subscribe(onChange: () => void): void;
  /** Replace the canonical document, persist (debounced), and refresh sibling surfaces. */
  commit(file: BlackboardFile): void;
  /** Release this surface's reference; the entry is dropped when the last surface unmounts. */
  release(): void;
}

interface Entry {
  file: BlackboardFile;
  subscribers: Map<symbol, () => void>;
  refCount: number;
  /**
   * Serialized forms we've written to disk (or accepted as an external edit) that are still
   * echoing back through the vault `modify` event. The `modify` handler is async, so an echo
   * of an EARLIER save can arrive AFTER a newer commit has advanced the document — a single
   * "last written" slot mis-reads that stale echo as a foreign edit and reverts, silently
   * deleting the strokes drawn in between. Remembering every recent self-write closes that race.
   */
  seen: Set<string>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  repo: IDrawingRepository;
}

/**
 * Hook run ONCE per path, on the first acquire, between loading the document and publishing
 * it. Returns the document to publish. This is where the sidecar import lives: it is the one
 * point every surface (view, embed, Canvas node) funnels through, so a drawing opened in two
 * panes at once still migrates exactly once — the in-flight load below is shared.
 */
export type DocumentMigration = (path: string, file: BlackboardFile) => Promise<BlackboardFile>;

/** How many recent self-writes to remember. Far above any realistic number of in-flight
 * disk writes, so a delayed echo is always still recognized, while the set stays bounded. */
const SEEN_LIMIT = 32;

/**
 * Single source of truth for `.blackboard` stroke data, keyed by file path. Every mounted
 * surface (standalone view, Markdown embed, Canvas node) of the same file shares one canonical
 * document: a commit from any surface updates the canonical strokes, persists once (debounced),
 * and synchronously refreshes the other surfaces — so drawing on one is immediately visible on
 * all (B2). External edits arrive via reconcile() and are suppressed when they echo our own write.
 */
export class DocumentStore {
  private entries = new Map<string, Entry>();
  /**
   * First-acquire loads in flight, keyed by path. Two surfaces of the same drawing mounting in
   * the same tick both used to await their own `repo.load` and both create an entry — the
   * second silently replacing the first, orphaning its subscribers and its refcount. Sharing
   * the promise makes the load (and the migration hanging off it) happen exactly once.
   */
  private loading = new Map<string, Promise<Entry>>();
  private readonly saveDelayMs: number;
  private readonly migrate: DocumentMigration | null;

  constructor(opts?: { saveDelayMs?: number; migrate?: DocumentMigration }) {
    this.saveDelayMs = opts?.saveDelayMs ?? 250;
    this.migrate = opts?.migrate ?? null;
  }

  async acquire(path: string, repo: IDrawingRepository): Promise<SharedDocumentHandle> {
    const entry = this.entries.get(path) ?? await this.load(path, repo);
    entry.refCount++;
    const id = Symbol('surface');
    const e = entry;
    return {
      getStrokes: () => e.file.strokes,
      getFile: () => e.file,
      getTextItems: () => textItemsOf(e.file),
      subscribe: (onChange) => { e.subscribers.set(id, onChange); },
      commit: (file) => this.commit(path, id, file),
      commitText: (items) => this.commit(path, id, withTextItems(e.file, items)),
      release: () => this.release(path, id),
    };
  }

  private load(path: string, repo: IDrawingRepository): Promise<Entry> {
    const inFlight = this.loading.get(path);
    if (inFlight) return inFlight;
    const started = (async () => {
      try {
        return await this.loadEntry(path, repo);
      } finally {
        this.loading.delete(path);
      }
    })();
    this.loading.set(path, started);
    return started;
  }

  private async loadEntry(path: string, repo: IDrawingRepository): Promise<Entry> {
    const { file, readonly } = await repo.load(path);
    // The migration runs before the entry is published, so no surface ever observes the
    // pre-migration document and no commit can race the import. It is skipped outright for a
    // document we are not allowed to write — a corrupt file, or one from a future version —
    // because importing means saving, and saving either of those would destroy content this
    // build cannot represent.
    const migrated = this.migrate && !readonly ? await this.migrate(path, file) : file;
    // A concurrent path could still have published an entry while we awaited; the first one
    // wins, exactly as it does for a concurrent reconcile.
    const existing = this.entries.get(path);
    if (existing) return existing;
    const entry: Entry = {
      // A readonly document keeps whatever version it declared; stamping is for what we write.
      file: readonly ? migrated : stampFormatVersion(migrated),
      subscribers: new Map(),
      refCount: 0,
      seen: new Set(),
      saveTimer: null,
      repo,
    };
    // The migration wrote these exact bytes; remembering them keeps its own `modify` echo
    // from being mistaken for a foreign edit.
    entry.seen.add(serialize(entry.file));
    this.entries.set(path, entry);
    return entry;
  }

  /** External-edit channel (vault `modify`): refresh from disk unless the content is our own write. */
  reconcile(path: string, diskContent: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    if (diskContent === serialize(entry.file)) return; // already our canonical state — nothing to do
    if (entry.seen.has(diskContent)) return; // a (possibly delayed) echo of one of our own writes
    const { file } = deserialize(diskContent);
    entry.file = file;
    this.remember(entry, diskContent); // remember accepted bytes so duplicate echoes are ignored too
    for (const cb of entry.subscribers.values()) cb(); // genuine external edit: refresh everyone
  }

  private commit(path: string, originId: symbol, file: BlackboardFile): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.file = stampFormatVersion(file);
    for (const [id, cb] of entry.subscribers) {
      if (id !== originId) cb(); // refresh siblings, never the committer
    }
    this.scheduleSave(path);
  }

  /** Record a serialized content as one of ours, evicting the oldest to stay bounded. */
  private remember(entry: Entry, content: string): void {
    entry.seen.add(content);
    while (entry.seen.size > SEEN_LIMIT) {
      const oldest = entry.seen.values().next().value;
      if (oldest === undefined) break;
      entry.seen.delete(oldest);
    }
  }

  /**
   * Immediately write every path with a pending debounced save. Called when the app is about
   * to be backgrounded/suspended (iPad lock screen, tab hidden) — otherwise a stroke drawn
   * within the debounce window before suspension is lost, because the timer never fires while
   * the WebView is frozen. Writes the canonical document, so it can never blank a drawing.
   */
  flushAll(): void {
    for (const [path, entry] of this.entries) {
      if (entry.saveTimer !== null) {
        window.clearTimeout(entry.saveTimer);
        entry.saveTimer = null;
        this.remember(entry, serialize(entry.file));
        void entry.repo.save(path, entry.file);
      }
    }
  }

  private scheduleSave(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    if (entry.saveTimer !== null) window.clearTimeout(entry.saveTimer);
    entry.saveTimer = window.setTimeout(() => {
      entry.saveTimer = null;
      // Remember exactly what we're about to write BEFORE its `modify` echo can arrive, so a
      // later reconcile recognizes it as our own even after newer commits move the document on.
      this.remember(entry, serialize(entry.file));
      void entry.repo.save(path, entry.file);
    }, this.saveDelayMs);
  }

  private release(path: string, id: symbol): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.subscribers.delete(id);
    entry.refCount--;
    if (entry.refCount <= 0) {
      // Flush any pending debounced write so the last edit is never lost on unmount.
      if (entry.saveTimer !== null) {
        window.clearTimeout(entry.saveTimer);
        entry.saveTimer = null;
        this.remember(entry, serialize(entry.file));
        void entry.repo.save(path, entry.file);
      }
      this.entries.delete(path);
    }
  }
}
