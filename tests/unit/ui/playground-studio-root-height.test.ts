import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Regression guard for the Playground Studio scroll bug.
//
// PlaygroundStudio previously hardcoded its root height as
// `h-[calc(100vh-4rem)]`, assuming it sits directly under a 4rem header. But it
// renders inside the dashboard content region (DashboardLayout), which is an
// already-sized `flex-1 min-h-0 overflow-y-auto` scroll container with padding
// (up to lg:p-10 = 5rem), a Breadcrumbs row and an optional MaintenanceBanner.
// The hardcoded calc therefore overshot the available space, and the studio's
// own `overflow-hidden` pushed the bottom controls (chat input / config pane)
// off-screen with no way to scroll to them.
//
// The fix is to fill the parent's sized flex region with `h-full min-h-0` — the
// same pattern every sibling full-height studio uses (ComboLiveStudio,
// CompressionCockpit). This test fails if the fragile viewport-calc height ever
// returns.
const STUDIO_PATH = path.join(
  process.cwd(),
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "playground",
  "PlaygroundStudio.tsx"
);

test("PlaygroundStudio root fills its parent instead of hardcoding a viewport height", () => {
  const src = fs.readFileSync(STUDIO_PATH, "utf-8");

  assert.ok(
    !src.includes("h-[calc(100vh-4rem)]"),
    "PlaygroundStudio must not hardcode h-[calc(100vh-4rem)] — it overshoots the padded dashboard scroll region and breaks scrolling"
  );

  // The root container must fill the parent's already-sized flex region so its
  // internal panes (config pane + tab content) own the scroll.
  assert.match(
    src,
    /className="flex flex-col h-full min-h-0 overflow-hidden"/,
    "PlaygroundStudio root should be `flex flex-col h-full min-h-0 overflow-hidden`"
  );
});
