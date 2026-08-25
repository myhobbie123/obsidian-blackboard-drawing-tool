import { MarkdownView, Plugin, TFile, View } from 'obsidian';
import type { PluginSettings } from './domain/entities';
import { DEFAULT_PLUGIN_SETTINGS, DEFAULT_TOOL_STATE, validateSettings } from './domain/entities';
import type { IDrawingRepository } from './domain/ports';
import { ToolManager } from './domain/tool-manager';
import { ObsidianDrawingRepository } from './infrastructure/obsidian-drawing-repository';
import { CreateDrawingUseCase } from './application/use-cases/create-drawing';
import { ExportSvgUseCase } from './application/use-cases/export-svg';
import { BlackboardView, VIEW_TYPE, FILE_EXTENSION } from './presentation/blackboard-view';
import { insertDrawingAtCursor, insertExistingDrawing, patchCanvas } from './presentation/canvas-integration';
import { BlackboardSettingTab } from './presentation/settings';
import { mountBlackboardEmbed, unmountAllEmbeds } from './presentation/embed';
import { SurfaceManager } from './presentation/surface-manager';
import { DocumentStore } from './application/document-store';
import { GlobalToolbar } from './presentation/global-toolbar';
import { parseEmbedSize, fitSavedEmbedSize } from './presentation/embed-size';
import { rafCoalesce } from './presentation/dom-scheduling';
import { ObsidianTextSidecarRepository } from './infrastructure/obsidian-text-sidecar-repository';
import type { ITextSidecarRepository } from './domain/ports';
import { MigrateTextSidecarUseCase } from './application/use-cases/migrate-text-sidecar';
import { textSidecarPath } from './application/text-sidecar';
import { TextController } from './presentation/text-controller';
import { beginAreaSelection } from './presentation/area-selection';
import { TOOL_COMMANDS, isCommandRebound } from './presentation/tool-commands';
import type { AppWithCommands } from './types/obsidian-internals';

// Replaced by esbuild `define` (true in dev builds, false in production, where the
// branch and the src/dev module behind it are eliminated from the bundle).
declare const __DEV_BUILD__: boolean;

/**
 * Whether a view type should host the collapsed no-surface toolbar pill. Only Canvas
 * qualifies: on Canvas, inserting a drawing node is a core action, so a persistent pill is a
 * useful affordance. Markdown is deliberately excluded — a plain note has nothing to draw on,
 * and a note that already embeds a drawing shows the embed's own auto-activated toolbar
 * instead of a redundant pill (issue #9).
 */
export function isPillHostViewType(viewType: string | undefined): boolean {
  return viewType === 'canvas';
}

export default class BlackboardPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_PLUGIN_SETTINGS;
  private repo!: IDrawingRepository;
  private createDrawingUseCase!: CreateDrawingUseCase;
  private exportSvgUseCase!: ExportSvgUseCase;
  surfaceManager: SurfaceManager = new SurfaceManager();
  // Single source of truth for `.blackboard` document data — strokes AND labels — keyed by
  // path. Every surface of a file shares one canonical document so edits propagate across
  // panes/embeds/canvas nodes (B2), with a debounced single writer and an own-write/external-
  // edit reconcile guard. Constructed in onload, where the sidecar migration it runs on first
  // open of each path can be wired up.
  documentStore!: DocumentStore;
  // Exactly one ToolManager is the global source of truth for the active tool and every
  // tool's colour/size, shared across the standalone view and every embed/canvas node.
  // Seeded once from code defaults at startup; mounting a surface never re-seeds it
  // (fix-tool-state-isolation).
  toolManager: ToolManager = new ToolManager({ ...DEFAULT_TOOL_STATE });
  // Text labels live inside the `.blackboard` document. The sidecar repository is read-only
  // now: it exists so a drawing written by an older build can have its sidecar imported once
  // (and followed across a rename until that happens).
  private sidecarRepo!: ITextSidecarRepository;
  private textController!: TextController;
  private globalToolbar: GlobalToolbar | null = null;
  private cancelAreaSelection: (() => void) | null = null;
  // Coalesces the tool-preference writes: the colour wheel emits continuously while dragged,
  // and every emission would otherwise be one data.json write.
  private toolSettingsTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (__DEV_BUILD__) {
      const { startDevBridge } = await import('./dev/dev-bridge');
      startDevBridge(this);
    }

    this.repo = new ObsidianDrawingRepository(this.app);
    this.createDrawingUseCase = new CreateDrawingUseCase(this.repo);
    this.exportSvgUseCase = new ExportSvgUseCase(this.repo);
    this.sidecarRepo = new ObsidianTextSidecarRepository(this.app);
    // One-shot import of a legacy text sidecar, run by the document store the first time a
    // path is opened — the single point every surface funnels through, so a drawing opened in
    // two panes at once still migrates exactly once. See `MigrateTextSidecarUseCase` for the
    // ordering guarantees.
    const migrateText = new MigrateTextSidecarUseCase(this.repo, this.sidecarRepo, (m) => { console.warn(m); });
    this.documentStore = new DocumentStore({
      migrate: (path, file) => migrateText.execute(path, file),
    });

    // The text tool's colour and font size are user preferences like any other, so they are
    // seeded from settings here (the rest of the per-tool defaults are still code-level) and
    // written back whenever the toolbar changes them.
    this.toolManager.setDefaults({
      textColor: this.settings.textColor,
      textFontSize: this.settings.textFontSize,
    });
    this.register(this.toolManager.onChange(() => this.syncToolSettings()));
    this.register(() => {
      if (this.toolSettingsTimer !== null) window.clearTimeout(this.toolSettingsTimer);
      this.toolSettingsTimer = null;
    });

    this.textController = new TextController(this.toolManager, this.surfaceManager);
    this.register(() => this.textController.destroy());
    this.registerToolCommands();
    // The workspace container's document is the one every non-pop-out surface lives in;
    // pop-out documents are bound by TextController.attach as their surfaces mount.
    this.textController.bindDocument(this.app.workspace.containerEl?.ownerDocument ?? activeDocument);

    this.registerView(VIEW_TYPE, (leaf) => new BlackboardView(leaf, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.repo, this.textController));

    // One floating toolbar shared by every drawing surface; route it to whichever
    // drawing lives in the active view.
    this.app.workspace.onLayoutReady?.(() => {
      this.globalToolbar = new GlobalToolbar(this.app.workspace.containerEl, this.surfaceManager, () => {
        void insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore, this.textController);
      }, () => {
        insertExistingDrawing(this.app, this.repo, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.textController);
      }, this.settings, {
        isActive: () => this.textController.isTextMode(),
        toggle: () => this.textController.toggleTextMode(),
      });
      // The T button is a real toolbar child, so keeping it in sync is a callback, not a
      // MutationObserver re-injecting a button into someone else's DOM.
      this.textController.setStateListener(() => this.globalToolbar?.syncTextButton());
      this.register(() => this.globalToolbar?.destroy());
      this.routeToolbar();
    });
    // Flush pending debounced saves before the app is suspended (iPad lock screen / tab
    // hidden). A frozen WebView never fires the save timer, so an unflushed stroke would be
    // lost on lock; flushing on hide writes the canonical document while JS is still running.
    this.registerDomEvent(activeDocument, 'visibilitychange', () => {
      if (activeDocument.hidden) this.documentStore.flushAll();
    });
    this.registerDomEvent(activeWindow, 'pagehide', () => {
      this.documentStore.flushAll();
    });

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.routeToolbar()));
    // Keep the toolbar clamped inside the active view when the layout changes
    // (sidebar toggled, pane resized, device rotated).
    this.registerEvent(this.app.workspace.on('resize', () => this.globalToolbar?.reposition()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.globalToolbar?.reposition()));
    try {
      this.registerExtensions([FILE_EXTENSION], VIEW_TYPE);
    } catch {
      // Extension may still be registered from a previous load (e.g. plugin re-enable);
      // ignore so onload doesn't abort and leave the plugin disabled.
    }

    this.addCommand({
      id: 'new-drawing',
      name: 'New drawing',
      callback: async () => {
        try {
          const path = await this.createDrawingUseCase.execute(
            this.settings,
            this.settings.newFileLocation,
            this.app.workspace.getActiveFile()?.parent?.path ?? undefined,
          );
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
        } catch {
          return;
        }
      },
    });

    this.addCommand({
      id: 'insert-drawing',
      name: 'Insert drawing',
      callback: async () => {
        try {
          await insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore, this.textController);
        } catch {
          // Insertion is best-effort: no Markdown/Canvas host is a normal no-op, not an error.
        }
      },
    });

    this.addCommand({
      id: 'insert-existing-drawing',
      name: 'Insert existing drawing',
      callback: () => {
        try {
          insertExistingDrawing(this.app, this.repo, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.textController);
        } catch {
          // Best-effort like insert-drawing: absence of a host must not surface an error.
        }
      },
    });

    // Editor context-menu entry: with the no-surface pill gone from Markdown (issue #9), this
    // keeps "insert a new drawing here" discoverable right where you are typing.
    this.registerEvent(this.app.workspace.on('editor-menu', (menu) => {
      menu.addItem((item) => {
        item
          .setTitle('Insert drawing')
          .setIcon('pencil')
          .onClick(async () => {
            try {
              await insertDrawingAtCursor(this.app, this.settings, this.createDrawingUseCase, this.repo, this.surfaceManager, this.toolManager, this.documentStore, this.textController);
            } catch {
              // Best-effort: no host is a normal no-op.
            }
          });
      });
    }));

    this.addCommand({
      id: 'draw-drawing-area',
      name: 'Draw drawing area',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const available = !!(view && view.getMode() === 'source' && view.editor);
        if (!checking && available) {
          this.cancelAreaSelection?.();
          this.cancelAreaSelection = beginAreaSelection({
            app: this.app,
            settings: this.settings,
            createDrawing: this.createDrawingUseCase,
            repo: this.repo,
          });
        }
        return available;
      },
    });
    this.register(() => this.cancelAreaSelection?.());

    this.addSettingTab(new BlackboardSettingTab(this.app, this));

    // Paint any already-mounted surfaces with the saved board background (issue #13).
    this.applyBoardBackground();

    patchCanvas(this.app, this, this.settings, this.repo, this.createDrawingUseCase, this.surfaceManager, this.toolManager, this.documentStore, this.textController);

    const processEmbeds = () => {
      const embeds = activeDocument.querySelectorAll('.internal-embed.mod-generic.is-loaded');
      embeds.forEach((embedEl) => {
        const src = (embedEl as HTMLElement).getAttribute('src') || '';
        if (!src.endsWith('.' + FILE_EXTENSION)) return;
        if ((embedEl as HTMLElement).dataset.bbMounted === 'true') return;
        const file = this.app.metadataCache.getFirstLinkpathDest(src, '');
        if (!file) return;
        const sizeAlias = (embedEl as HTMLElement).getAttribute('width')
          || (embedEl as HTMLElement).getAttribute('alt')
          || '';
        const size = parseEmbedSize(sizeAlias);
        if (size) {
          // Explicit |WxH / |N% alias overrides the default.
          if (size.width !== null) (embedEl as HTMLElement).style.width = size.width;
          if (size.height !== null) (embedEl as HTMLElement).style.height = size.height;
          void mountBlackboardEmbed(this.repo, embedEl as HTMLElement, file.path, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.textController, this.app);
        } else {
          // No alias: render at the drawing's saved size, centred, capped to the note
          // width. Reading the file first keeps the embed image-like rather than
          // stretching to full width.
          void this.applySavedEmbedSize(embedEl as HTMLElement, file.path).then(() => {
            void mountBlackboardEmbed(this.repo, embedEl as HTMLElement, file.path, this.settings, this.surfaceManager, this.toolManager, this.documentStore, this.textController, this.app);
          });
        }
      });
    };

    // Startup heal: any bbMounted marker present NOW is stale (this instance has
    // mounted nothing yet) — left by a previous instance whose unload predates the
    // unmount fix. Clear marker + orphaned engine DOM so re-mount can happen.
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>('[data-bb-mounted="true"]'),
    )) {
      el.dataset.bbMounted = 'false';
      el.empty();
    }
    // Same heal for the retired card-menu pencil button (removed by design 2026-07-09):
    // older instances injected it into canvas menus that survive plugin reloads.
    for (const el of Array.from(activeDocument.querySelectorAll('#blackboard-add-drawing'))) {
      el.remove();
    }

    // Unmount every live embed when the plugin unloads (reload/update/disable):
    // leaves the DOM re-mountable for the next instance and removes doc listeners.
    this.register(() => unmountAllEmbeds());

    // The observer watches a whole Markdown view subtree, and CodeMirror rewrites that
    // subtree on every keystroke — so an uncoalesced callback ran a full-document embed
    // scan many times per frame while typing. Coalesced to at most one scan per frame.
    const processEmbedsSoon = rafCoalesce(processEmbeds);
    const embedObserver = new MutationObserver(processEmbedsSoon);

    // One layout-change subscription doing both jobs (scan + attach the observer to the newly
    // active view) instead of two that each fired for every burst of the event.
    this.registerEvent(this.app.workspace.on('layout-change', () => {
      const activeEl = activeDocument.querySelector('.workspace-leaf.mod-active .view-content');
      if (activeEl && !(activeEl as HTMLElement).dataset.bbObserved) {
        (activeEl as HTMLElement).dataset.bbObserved = 'true';
        embedObserver.observe(activeEl, { childList: true, subtree: true });
      }
      processEmbeds();
    }));
    this.register(() => { embedObserver.disconnect(); processEmbedsSoon.cancel(); });

    window.setTimeout(processEmbeds, 1000);

    const folder = this.settings.drawingFolder;
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch {
        // Folder may already exist (vault cache lag / re-enable); ignore.
      }
    }

    this.registerEvent(this.app.vault.on('modify', async (file) => {
      if (!(file instanceof TFile) || file.extension !== FILE_EXTENSION) return;
      // External-edit channel: reconcile the on-disk content into the shared document so
      // open surfaces refresh (another device, Obsidian Sync, manual edit). The store
      // ignores content equal to its own last write, so our own saves don't loop.
      try {
        const content = await this.app.vault.read(file);
        this.documentStore.reconcile(file.path, content);
      } catch {
        // File may be mid-rename or unreadable this tick; the next modify event reconciles.
      }
      if (this.settings.autoExportSvg) {
        try { await this.exportSvgUseCase.execute(file.path, this.settings.svgExportPath); } catch {
          // Auto-export must never block or fail the save that triggered it.
        }
      }
    }));

    this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
      // Transitional, and the ONLY sidecar bookkeeping left: a drawing whose labels have not
      // been imported yet (it has not been opened by this build) must keep its sidecar next to
      // it, or the import would never find it again. A drawing with no sidecar — i.e. every
      // migrated one, and every drawing made since — costs one synchronous map lookup here.
      if (file instanceof TFile && file.extension === FILE_EXTENSION) {
        try {
          const from = textSidecarPath(oldPath);
          if (this.sidecarRepo.exists(from)) {
            await this.sidecarRepo.rename(from, textSidecarPath(file.path));
          }
        } catch {
          // A stranded sidecar is recoverable by hand; a thrown rename handler is not.
        }
      }
      if (file instanceof TFile && file.extension === FILE_EXTENSION && this.settings.autoExportSvg) {
        const oldSvgPath = oldPath.replace(/\.[^.]+$/, '.svg');
        const newSvgPath = file.path.replace(/\.[^.]+$/, '.svg');
        await this.repo.rename(oldSvgPath, newSvgPath);
      }
    }));

    this.registerEvent(this.app.vault.on('delete', async (file) => {
      if (file instanceof TFile && file.extension === FILE_EXTENSION && this.settings.autoExportSvg) {
        const svgPath = file.path.replace(/\.[^.]+$/, '.svg');
        await this.repo.delete(svgPath);
      }
    }));
  }

  /**
   * Tool selection as real Obsidian commands: they appear in Settings → Hotkeys, are
   * rebindable, and Obsidian handles scoping and conflicts. Each is checkCallback-guarded so
   * it is inert (and hidden from the palette) with no live drawing surface.
   *
   * Deliberately registered WITHOUT default hotkeys (see `tool-commands.ts`): Obsidian's
   * hotkeys match the produced character, so a default binding would be dead on a Cyrillic
   * layout and would claim keys the user never asked for. The fork's Q/E/T survive through
   * the controller's physical-key fallback, which runs these same commands and stands down
   * for any command the user rebinds here.
   */
  private registerToolCommands(): void {
    for (const command of TOOL_COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        checkCallback: (checking) => {
          // The text tool needs a surface with a text layer; the drawing tools only need a
          // live surface for the selection to mean anything.
          const available = command.tool === 'text'
            ? this.textController.hasSurface()
            : this.surfaceManager.getActive() !== null;
          if (!checking && available) this.textController.selectTool(command.tool);
          return available;
        },
      });
    }

    const app = this.app as unknown as AppWithCommands;
    const fullId = (id: string) => `${this.manifest.id}:${id}`;
    this.textController.setHotkeyBridge({
      run: (id) => { app.commands?.executeCommandById(fullId(id)); },
      isRebound: (id) => isCommandRebound(app.hotkeyManager?.customKeys, fullId(id)),
    });
  }

  /** Persist the text tool's colour/font size after the toolbar changes them (debounced). */
  private syncToolSettings(): void {
    const state = this.toolManager.getState();
    if (state.textColor === this.settings.textColor &&
        state.textFontSize === this.settings.textFontSize) return;
    this.settings.textColor = state.textColor;
    this.settings.textFontSize = state.textFontSize;
    if (this.toolSettingsTimer !== null) window.clearTimeout(this.toolSettingsTimer);
    this.toolSettingsTimer = window.setTimeout(() => {
      this.toolSettingsTimer = null;
      void this.saveSettings();
    }, 500);
  }

  private routeToolbar(): void {
    const view = this.app.workspace.getActiveViewOfType(View) as unknown as
      | { contentEl?: HTMLElement; getViewType?: () => string }
      | null
      | undefined;
    const contentEl = view?.contentEl ?? null;
    // Persistent pill: only Canvas hosts the collapsed no-surface pill (issue #9). Set the host
    // before activating so the no-surface fallback anchors correctly; Markdown and every other
    // view type pass null — a Markdown note with an embed still shows the embed's own
    // auto-activated toolbar via activateForView below.
    const viewType = view?.getViewType?.();
    this.globalToolbar?.setHost(isPillHostViewType(viewType) ? contentEl : null);
    this.surfaceManager.activateForView(contentEl);
  }

  /**
   * Size a no-alias Markdown embed to the drawing's saved dimensions, centred, and
   * scaled down to fit the note's content width when wider. An explicit `|WxH` alias
   * skips this (handled by the caller).
   */
  private async applySavedEmbedSize(embedEl: HTMLElement, filePath: string): Promise<void> {
    try {
      const { file } = await this.repo.load(filePath);
      const avail = embedEl.parentElement?.clientWidth || embedEl.clientWidth || file.width || 0;
      const fit = fitSavedEmbedSize(file.width || 0, file.height || 0, avail);
      if (!fit) return;
      embedEl.setCssStyles({
        width: fit.width + 'px',
        height: fit.height + 'px',
        marginLeft: 'auto',
        marginRight: 'auto',
      });
    } catch {
      // Couldn't read the file; leave the embed at its default size.
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_PLUGIN_SETTINGS, await this.loadData() as Partial<PluginSettings>);
    this.validateSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Reflect the persistent-pill toggle immediately so a Markdown/Canvas host with no
    // active surface hides (or restores) the pill without needing a view switch.
    this.globalToolbar?.setPillEnabled(this.settings.showToolbarPill);
    // Re-paint every mounted surface so a board-background change is live (issue #13).
    this.applyBoardBackground();
  }

  /** Paint every mounted drawing surface with the configured board background (issue #13). */
  private applyBoardBackground(): void {
    const color = this.settings.boardBackground;
    for (const el of Array.from(
      activeDocument.querySelectorAll<HTMLElement>('.blackboard-drawing-container'),
    )) {
      el.style.backgroundColor = color;
    }
  }

  private validateSettings(): void {
    this.settings = validateSettings(this.settings);
  }
}
