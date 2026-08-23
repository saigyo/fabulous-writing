import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The chrome-ext-v* release workflow gates the tag against manifest.json's
// version; this test pins package.json to the same value so the pair cannot
// drift apart silently between releases.
describe("extension version", () => {
  it("matches between package.json and public/manifest.json", () => {
    const root = resolve(__dirname, "..");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const manifest = JSON.parse(
      readFileSync(resolve(root, "public/manifest.json"), "utf8"),
    );
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
