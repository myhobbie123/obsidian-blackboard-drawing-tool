import type { BlackboardFile } from './entities';

/** Repository port for drawing file persistence.
 *  Serialization is the repository's responsibility. */
export interface IDrawingRepository {
  load(path: string): Promise<{ file: BlackboardFile; warnings: string[]; readonly: boolean }>;
  save(path: string, file: BlackboardFile): Promise<void>;
  writeRaw(path: string, content: string): Promise<void>;
  create(folder: string, name: string, file: BlackboardFile): Promise<string>;
  exists(path: string): boolean;
  ensureFolder(path: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/**
 * Read/move-only port for the legacy `<drawing>.blackboard-text.json` sidecar. Text itself now
 * lives inside the `.blackboard` document, so nothing writes a sidecar any more: the only
 * remaining jobs are importing one exactly once (`application/text-migration`), moving it
 * aside afterwards, and keeping a not-yet-migrated one next to its drawing across a rename.
 * Deliberately raw-string based — parsing is pure application logic, and the adapter owns
 * nothing but vault I/O.
 */
export interface ITextSidecarRepository {
  /** File contents, or null when the sidecar does not exist. */
  read(path: string): Promise<string | null>;
  /** Rename the sidecar. A missing source, or an occupied destination, is a no-op. */
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): boolean;
}
