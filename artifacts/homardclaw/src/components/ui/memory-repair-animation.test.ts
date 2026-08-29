import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import frameLayouts from "./lobster-frames.json";
import presets from "./lobster-presets.json";

function pngHeader(name: string) {
  const file = readFileSync(
    new URL(
      `../../../public/images/lobsters-memory-cables/${name}`,
      import.meta.url,
    ),
  );
  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
    colorType: file[25],
  };
}

describe("memory repair animation", () => {
  it("maps the repair pose to four distinct step-animation frames", () => {
    expect(frameLayouts["lobsters-memory-cables"]).toEqual([
      "rest",
      "stir",
      "nod",
      "turn",
    ]);
  });

  it("ships a transparent 512x128 strip for every shell preset", () => {
    for (const preset of presets) {
      expect(pngHeader(`${preset.id}-frames.png`)).toEqual({
        width: 512,
        height: 128,
        colorType: 6,
      });
    }
  });
});
