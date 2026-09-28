import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontSource = readFileSync("src/components/CategoryIcon.tsx", "utf8");
const backSource = readFileSync("src-tauri/src/lib.rs", "utf8");
const frontBlock = frontSource.match(/CATEGORY_ICONS: Record<string, JSX\.Element> = \{([\s\S]*?)\n\};/)?.[1];
const backBlock = backSource.match(/const CATEGORY_ICONS: &\[&str\] = &\[([\s\S]*?)\n\];/)?.[1];
assert.ok(frontBlock && backBlock, "Category icon registries were not found");

const front = [...frontBlock.matchAll(/^  "([^"]+)":/gm)].map((match) => match[1]);
const back = [...backBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(front, back, "Frontend and backend category icons differ");
console.log(`Category icon registries match: ${front.join(", ")}`);
