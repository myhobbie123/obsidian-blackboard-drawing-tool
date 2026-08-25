import type { BlackboardFile } from '../../domain/entities';
import type { IDrawingRepository, ITextSidecarRepository } from '../../domain/ports';
import { withTextItems } from '../file-format';
import { planTextMigration } from '../text-migration';
import { migratedSidecarPath, textSidecarPath } from '../text-sidecar';

/**
 * Fold a drawing's legacy `<drawing>.blackboard-text.json` sidecar into the drawing itself,
 * exactly once, on the first time that drawing is opened by this build.
 *
 * This touches text the user cannot get back, so the ordering is fixed and every step is
 * ordered to make a crash cost a leftover file rather than a label:
 *
 *   1. READ the sidecar. Failure here (unreadable file, vault hiccup) aborts with the
 *      document untouched — the next open retries.
 *   2. DECIDE (`planTextMigration`, pure). A document that already carries labels always
 *      wins: the sidecar is not even read into it. That is what makes this idempotent and
 *      what stops a stale sidecar resurrected by sync from clobbering newer in-file text.
 *   3. WRITE the drawing with the imported labels, and await it. A crash before this point
 *      leaves both files exactly as they were.
 *   4. Only after a SUCCESSFUL write, move the sidecar aside (rename, never delete). A crash
 *      between 3 and 4 leaves a drawing that has the text and a sidecar that will be skipped
 *      at step 2 forever — a stray file, no duplication, nothing lost.
 *
 * A sidecar we could not fully parse is imported as far as it was readable and then LEFT IN
 * PLACE, so the unreadable remainder stays on disk for a human to look at.
 */
export class MigrateTextSidecarUseCase {
  constructor(
    private drawings: IDrawingRepository,
    private sidecars: ITextSidecarRepository,
    private log: (message: string) => void = () => {},
  ) {}

  async execute(drawingPath: string, file: BlackboardFile): Promise<BlackboardFile> {
    const sidecar = textSidecarPath(drawingPath);
    // Cheap synchronous rejection for the overwhelmingly common case (no sidecar at all), so
    // opening a drawing costs no extra vault read.
    if (!this.sidecars.exists(sidecar)) return file;

    let raw: string | null;
    try {
      raw = await this.sidecars.read(sidecar);
    } catch {
      this.log(`Blackboard: could not read ${sidecar}; its labels stay in the sidecar.`);
      return file;
    }

    const plan = planTextMigration(file, raw);
    if (plan.action === 'skip') return file;
    if (plan.warning) this.log(`Blackboard: ${sidecar}: ${plan.warning}.`);

    const migrated = withTextItems(file, plan.items);
    try {
      await this.drawings.save(drawingPath, migrated);
    } catch {
      // The sidecar is untouched, so nothing is lost: the labels are live in this session and
      // the next open imports them again.
      this.log(`Blackboard: could not write ${drawingPath}; its labels stay in the sidecar.`);
      return migrated;
    }

    if (!plan.retire) return migrated;
    try {
      await this.sidecars.rename(sidecar, migratedSidecarPath(sidecar));
    } catch {
      // Worst case is a leftover file: the drawing now has the text, so the next open skips.
      this.log(`Blackboard: imported ${sidecar} but could not move it aside; it is now unused.`);
    }
    return migrated;
  }
}
