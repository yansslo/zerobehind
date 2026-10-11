import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/action.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { alwaysBundle: [/./], onlyBundle: false }, // the Action runs from dist/ with no node_modules
  outputOptions: { codeSplitting: false },
  report: false,
  plugins: [
    {
      // Bundled third-party code must ship with its license text (ai and @ai-sdk/* are Apache-2.0).
      name: "licenses",
      generateBundle(_, bundle) {
        const roots = new Set<string>();
        for (const chunk of Object.values(bundle))
          if (chunk.type === "chunk")
            for (const id of Object.keys(chunk.modules)) {
              const m = id.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
              if (m) roots.add(m[1]);
            }
        const text = [...roots]
          .map((dir) => {
            const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
            const file = existsSync(dir) && readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
            return { name: pkg.name, body: `${pkg.name}@${pkg.version}\n${pkg.license ?? ""}\n\n${file ? readFileSync(path.join(dir, file), "utf8").trim() : ""}` };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => p.body)
          .join("\n\n----\n\n");
        this.emitFile({ type: "asset", fileName: "licenses.txt", source: text + "\n" });
      },
    },
  ],
});
