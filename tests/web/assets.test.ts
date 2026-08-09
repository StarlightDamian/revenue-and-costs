import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const expected: Record<string, string> = {
  "portal-comfort.webp": "7E72C3066BF22DFA2EE27586FFAF2D980EDB6B4CB10F061C0EF04E2B1CACF6A5",
  "portal-tech.webp": "35F9132CBCFC710C696E7434AB98A76ACF34EBE9D23507B03E0A95B11999BDBA",
  "portal-light.webp": "6D9BBD99334C86341458297D3152CCB5F598CDADF82B639480134E1B32A5A79D",
  "portal-dark.webp": "2A64EA9619985D8ECE1F668F837CEB01774BCAED6D4154B6B465E2F990C25772",
};

describe("authorized theme assets", () => {
  for (const [name, hash] of Object.entries(expected)) {
    it(`keeps ${name} byte-identical to the approved reference`, async () => {
      const bytes = await readFile(resolve("src/web/assets", name));
      expect(createHash("sha256").update(bytes).digest("hex").toUpperCase()).toBe(hash);
    });
  }

  it("keeps the approved 59-avatar set complete and byte-identical", async () => {
    const root = resolve("src/web/assets/avatars");
    const names = (await readdir(root)).sort();
    expect(names).toEqual(Array.from({ length: 59 }, (_, index) => `watercolor-avatar-${String(index + 1).padStart(2, "0")}.webp`));
    const manifestLines: string[] = [];
    for (const name of names) {
      const hash = createHash("sha256").update(await readFile(resolve(root, name))).digest("hex").toUpperCase();
      manifestLines.push(`${name}:${hash}`);
    }
    expect(createHash("sha256").update(manifestLines.join("\n")).digest("hex").toUpperCase()).toBe(
      "2ADF85B1F8B762F7FA09CE681C212B700FE2B9240FCA453754519E9D5D8F560F",
    );
  });
});
