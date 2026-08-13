/**
 * Generates preview.html from the three Framer components.
 *
 * The components are the single source of truth — this script strips their
 * `react` and `framer` imports, compiles the TSX, and drops the result into a
 * page. Nothing here re-implements any component logic, so the preview cannot
 * drift away from what actually gets pasted into Framer.
 *
 * The page also wraps window.fetch so every failure state can be triggered on
 * demand instead of waiting for the API's 35% failure rate to produce one. That
 * interception lives here, in the harness — never in the shipped components.
 *
 * Run: node build-preview.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { transform } from "esbuild"

const COMPONENTS = [
    { file: "SkillpathHero.tsx", name: "SkillpathHero" },
    { file: "SkillpathCourses.tsx", name: "SkillpathCourses" },
    { file: "SkillpathFooter.tsx", name: "SkillpathFooter" },
]

/**
 * Each component is wrapped in its own IIFE. They independently define helpers
 * with the same names (withAlpha, useStyleSheet, STYLE_ID), which is fine in
 * Framer where each is a separate module, but would collide in one script.
 */
function prepare(source, name) {
    const body = source
        // Hooks come from the UMD global instead of a module import.
        .replace(/^import\s+\{([^}]*)\}\s+from\s+"react"\s*$/m, (_, names) => `const {${names}} = React;`)
        // addPropertyControls is a no-op outside Framer; ControlType just needs
        // to not throw when the property-control block runs.
        .replace(
            /^import\s+\{[^}]*\}\s+from\s+"framer"\s*$/m,
            `const addPropertyControls = () => {}, ControlType = new Proxy({}, { get: () => "stub" });`
        )
        .replace(/^export default function/m, "function")

    return `(function () {\n${body}\nwindow.${name} = ${name};\n})();`
}

const PAGE_SOURCE = `
const { useState } = React;

const MODES = [
  { id: "live",          label: "Live API",            hint: "Real responses, including its real ~35% failure rate." },
  { id: "slow",          label: "Slow network",        hint: "2.5s delay, so the skeleton loaders stay on screen." },
  { id: "courses-error", label: "Courses fail",        hint: "Course endpoint always 500s. Retries, then the error state." },
  { id: "country-error", label: "Country fails only",  hint: "Courses load, currency lookup does not. The judgement case." },
  { id: "both-error",    label: "Both fail",           hint: "Nothing loads at all." },
  { id: "empty",         label: "Empty catalogue",     hint: "A valid 200 with zero courses." },
];

function Preview() {
  const [mode, setMode] = useState("live");
  const [reloadKey, setReloadKey] = useState(0);
  const [accent, setAccent] = useState("#4F3CE8");

  function choose(next) {
    window.__setFaultMode(next);
    setMode(next);
    setReloadKey(k => k + 1); // Remount so the component refetches under the new mode.
  }

  const active = MODES.find(m => m.id === mode);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "panel" },
      React.createElement("div", { className: "panel-row" },
        React.createElement("span", { className: "panel-label" }, "Preview harness"),
        React.createElement("span", { className: "panel-note" }, "Not part of the component — this page wraps fetch to force each state.")
      ),
      React.createElement("div", { className: "panel-row" },
        MODES.map(m =>
          React.createElement("button", {
            key: m.id,
            className: "chip" + (m.id === mode ? " chip-on" : ""),
            onClick: () => choose(m.id),
          }, m.label)
        ),
        React.createElement("button", { className: "chip chip-reload", onClick: () => setReloadKey(k => k + 1) }, "↻ Reload"),
        React.createElement("label", { className: "swatch" },
          "Accent",
          React.createElement("input", {
            type: "color", value: accent, onChange: e => setAccent(e.target.value),
          })
        )
      ),
      React.createElement("p", { className: "panel-hint" }, active.hint)
    ),
    React.createElement("main", { className: "page" },
      React.createElement("section", { className: "band band-hero" },
        React.createElement(window.SkillpathHero, { accentColor: accent })
      ),
      React.createElement("section", { className: "band", id: "courses" },
        React.createElement(window.SkillpathCourses, { key: reloadKey, accentColor: accent })
      ),
      React.createElement("section", { className: "band band-footer" },
        React.createElement(window.SkillpathFooter, { accentColor: accent })
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Preview));
`

const FAULT_INJECTION = `
// Wraps fetch so each failure state can be demonstrated on demand. This is
// harness scaffolding for local review only; the components know nothing about it.
(function () {
  let mode = "live";
  window.__setFaultMode = next => { mode = next; };

  const realFetch = window.fetch.bind(window);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  const fail = status => new Response(JSON.stringify({ error: "Injected fault" }), {
    status, headers: { "Content-Type": "application/json" },
  });
  const emptyList = () => new Response("[]", {
    status: 200, headers: { "Content-Type": "application/json" },
  });

  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const isCourses = url.includes("/assignment/course-data");
    const isCountry = url.includes("/assignment/country-code");

    if (!isCourses && !isCountry) return realFetch(input, init);

    if (mode === "slow") await wait(2500);
    if (mode === "courses-error" && isCourses) return fail(500);
    if (mode === "country-error" && isCountry) return fail(500);
    if (mode === "both-error") return fail(500);
    if (mode === "empty" && isCourses) return emptyList();

    return realFetch(input, init);
  };
})();
`

const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #F7F6F3;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #12100E;
}

.panel {
  position: sticky; top: 0; z-index: 50;
  background: #12100E; color: #F7F6F3;
  padding: 12px clamp(16px, 4vw, 56px);
  display: flex; flex-direction: column; gap: 9px;
}
.panel-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.panel-label { font-size: 12px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; }
.panel-note { font-size: 12px; opacity: 0.55; }
.panel-hint { margin: 0; font-size: 12.5px; opacity: 0.68; }

.chip {
  font: inherit; font-size: 12.5px; font-weight: 550; cursor: pointer;
  padding: 6px 12px; border-radius: 999px;
  border: 1px solid rgba(247,246,243,0.22); background: transparent; color: #F7F6F3;
  transition: background 0.15s ease;
}
.chip:hover { background: rgba(247,246,243,0.10); }
.chip-on { background: #F7F6F3; color: #12100E; border-color: #F7F6F3; }
.chip-reload { margin-left: 4px; }

.swatch {
  display: inline-flex; align-items: center; gap: 7px; margin-left: auto;
  font-size: 12.5px; opacity: 0.8;
}
.swatch input { width: 30px; height: 24px; padding: 0; border: none; background: none; cursor: pointer; }

.page { max-width: 1240px; margin: 0 auto; }
.band { padding: 0 clamp(20px, 5vw, 56px); }
.band-hero { padding-top: clamp(56px, 9vw, 104px); padding-bottom: clamp(48px, 7vw, 88px); }
#courses { padding-bottom: clamp(56px, 8vw, 96px); scroll-margin-top: 90px; }
.band-footer { padding-bottom: 44px; }
`

async function main() {
    const compiled = []

    for (const { file, name } of COMPONENTS) {
        const prepared = prepare(readFileSync(file, "utf8"), name)
        const { code } = await transform(prepared, {
            loader: "tsx",
            jsx: "transform",
            jsxFactory: "React.createElement",
            jsxFragment: "React.Fragment",
            target: "es2020",
        })
        compiled.push(`/* ---- ${file} ---- */\n${code}`)
    }

    const { code: pageCode } = await transform(PAGE_SOURCE, { loader: "js", target: "es2020" })

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skillpath — local preview</title>
<link rel="preconnect" href="https://syncsphere-hiv6.onrender.com">
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script>${FAULT_INJECTION}</script>
<script>${compiled.join("\n\n")}</script>
<script>${pageCode}</script>
</body>
</html>
`

    // Written into docs/ so GitHub Pages can serve it straight from the repo
    // (Settings → Pages → main branch, /docs folder) without a build step.
    mkdirSync("docs", { recursive: true })
    writeFileSync("docs/index.html", html)
    console.log(`docs/index.html written (${(html.length / 1024).toFixed(1)} KB)`)
    console.log("Open it directly in a browser — no server needed.")
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
