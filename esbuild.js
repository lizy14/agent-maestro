import esbuild from "esbuild";
import fs from "fs";
import path from "path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.cjs",
    metafile: !production,
    // esbuild replaces `import.meta` with `{}` in CJS output, which breaks
    // dependencies that call `createRequire(import.meta.url)` (e.g. mcp-proxy
    // via fastmcp) — `import.meta.url` becomes `undefined` and activation
    // throws. Map it to `__filename`, which `createRequire` accepts as an
    // absolute path string.
    define: { "import.meta.url": "__filename" },
    external: ["vscode", "@valibot/to-json-schema", "effect", "sury"],
    logLevel: "info",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild().then((result) => {
      if (result.metafile) {
        fs.writeFileSync(
          path.join("dist", "meta.json"),
          JSON.stringify(result.metafile, null, 2),
        );
      }
      console.log("[build] build completed");
    });
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
