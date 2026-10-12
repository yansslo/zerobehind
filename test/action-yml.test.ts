import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

// GitHub fails every run at "Set up job" if action.yml is not valid YAML.
it("action.yml parses", () => {
  const action = parse(readFileSync(new URL("../action.yml", import.meta.url), "utf8"));
  expect(action.runs.main).toBe("dist/index.mjs");
  expect(Object.keys(action.inputs)).toContain("upstream-branch");
});
