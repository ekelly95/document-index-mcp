import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * The bundled English traineddata, so OCR tests never touch the CDN. The
 * worker still copies it into its cachePath on first use, exactly as it
 * would a downloaded model.
 */
export function testLangPath(): string {
  return path.join(
    path.dirname(require.resolve("@tesseract.js-data/eng/package.json")),
    "4.0.0_best_int",
  );
}
