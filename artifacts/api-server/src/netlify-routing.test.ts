import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("Netlify preserves API, public payslip, and SPA request paths", () => {
  const config = readFileSync(path.join(repositoryRoot, "netlify.toml"), "utf8");

  assert.match(config, /from = "\/api\/\*"\s+to = "\/.netlify\/functions\/api\/:splat"/s);
  assert.match(config, /from = "\/p\/\*"\s+to = "\/.netlify\/functions\/api\/p\/:splat"/s);
  assert.match(config, /from = "\/\*"\s+to = "\/index\.html"/s);
});
