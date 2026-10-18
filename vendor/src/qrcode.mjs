// Entry for vendor/qrcode.mjs — browser build of qrcode (its package.json
// "browser" field swaps lib/index.js -> lib/browser.js, so pngjs/yargs are
// never imported). Named re-exports keep ESM surface independent of CJS
// static-analysis detection.
import QRCode from "qrcode";

export default QRCode;
export const { create, toCanvas, toDataURL, toString } = QRCode;
