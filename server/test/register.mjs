// Lets Node's built-in TypeScript support resolve "./x.js" imports to "./x.ts" in tests,
// so the core game and ledger tests run with no npm packages installed.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  import { existsSync } from "node:fs";
  import { fileURLToPath } from "node:url";
  export async function resolve(spec, ctx, next) {
    if (spec.endsWith(".js") && ctx.parentURL && ctx.parentURL.endsWith(".ts")) {
      const ts = new URL(spec.replace(/\\.js$/, ".ts"), ctx.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, ctx);
    }
    return next(spec, ctx);
  }
`));
