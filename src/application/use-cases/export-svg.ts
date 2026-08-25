import type { IDrawingRepository } from '../../domain/ports';
import type { Background } from '../../domain/entities';
import { exportSvg } from '../export-service';
import { textItemsOf } from '../file-format';

export class ExportSvgUseCase {
  constructor(private repo: IDrawingRepository) {}

  async execute(drawingPath: string, svgExportFolder: string): Promise<void> {
    const { file } = await this.repo.load(drawingPath);
    const textItems = textItemsOf(file);
    // A drawing that is only labels is still worth exporting; only a wholly empty one is not.
    if (file.strokes.length === 0 && textItems.length === 0) return;

    // SVG exports use transparent background (intended as overlays)
    const bg: Background = { type: 'blank', color: 'transparent', grid: false, gridSize: 20 };
    const svg = exportSvg(file.strokes, bg, textItems);

    let svgPath: string;
    const basename = drawingPath.replace(/\.[^.]+$/, '');
    if (svgExportFolder) {
      await this.repo.ensureFolder(svgExportFolder);
      const name = basename.split('/').pop() || basename;
      svgPath = `${svgExportFolder}/${name}.svg`;
    } else {
      svgPath = `${basename}.svg`;
    }

    await this.repo.writeRaw(svgPath, svg);
  }
}
