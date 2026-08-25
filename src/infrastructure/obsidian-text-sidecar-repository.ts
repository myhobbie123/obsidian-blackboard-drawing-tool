import { App, TFile } from 'obsidian';
import type { ITextSidecarRepository } from '../domain/ports';

/**
 * Vault-backed adapter for the legacy `<drawing>.blackboard-text.json` sidecar. Read and move
 * only — text is written into the `.blackboard` document now, never here.
 */
export class ObsidianTextSidecarRepository implements ITextSidecarRepository {
  constructor(private app: App) {}

  async read(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return this.app.vault.read(file);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) return;
    // Never clobber an existing sidecar at the destination.
    if (this.app.vault.getAbstractFileByPath(newPath)) return;
    // fileManager.renameFile (not vault.rename) so links and metadata are updated.
    await this.app.fileManager.renameFile(file, newPath);
  }

  exists(path: string): boolean {
    return !!this.app.vault.getAbstractFileByPath(path);
  }
}
