/**
 * Render tests for SkillpathCourses.
 *
 * verify.mjs covers the pure logic; this covers the part that actually reaches a
 * visitor — that the component mounts, moves through each of its four states,
 * and never renders a blank box or a raw error string.
 *
 * fetch is stubbed per scenario so failures happen on demand rather than waiting
 * for the API's real ~35% failure rate.
 *
 * Run: node render-test.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { JSDOM } from "jsdom"

const TEMP_DIR = "./.render-tmp"

let passed = 0
let failed = 0

function check(label, condition, detail = "") {
    if (condition) {
        passed++
        console.log(`  PASS  ${label}`)
    } else {
        failed++
        console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`)
    }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true })

// jsdom has no ResizeObserver. The component guards for exactly this and falls
// back to its default column count, so leaving it undefined tests that guard.
// Everything else React needs is copied onto the Node global.
for (const key of ["window", "document", "HTMLElement", "Node", "Event", "CustomEvent", "getComputedStyle"]) {
    globalThis[key] = dom.window[key]
}
// Node 22 defines globalThis.navigator as a getter, so a plain assignment throws.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import("react")).default
const { createRoot } = await import("react-dom/client")
const { act } = await import("react")
const { renderToString } = await import("react-dom/server")

// ---------------------------------------------------------------------------
// Compile the component
// ---------------------------------------------------------------------------

async function loadComponent() {
    mkdirSync(TEMP_DIR, { recursive: true })

    const source = readFileSync("./SkillpathCourses.tsx", "utf8").replace(
        /^import\s+\{[^}]*\}\s+from\s+"framer"\s*$/m,
        `const addPropertyControls = () => {}, ControlType = new Proxy({}, { get: () => "stub" });`
    )

    const entry = `${TEMP_DIR}/entry.tsx`
    const out = `${TEMP_DIR}/compiled.mjs`
    writeFileSync(entry, source)

    await build({
        entryPoints: [entry],
        outfile: out,
        bundle: true,
        format: "esm",
        packages: "external", // Keep react as a real import so it shares our instance.
        loader: { ".tsx": "tsx" },
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        inject: [],
        banner: { js: `import * as React from "react";` },
        logLevel: "silent",
    })

    return (await import(pathToFileURL(out).href + `?t=${Date.now()}`)).default
}

// ---------------------------------------------------------------------------
// fetch stubs
// ---------------------------------------------------------------------------

const COURSES = [
    { courseName: "How To YouTube", courseCode: "how-to-youtube", description: "From concept to creation, learn how to build and grow a channel.", mainCategory: "Content Creation", shortCourse: "YouTube", courseType: "Original", pricePaise: 199900, priceUsdCents: 3999, mangoId: "a1", refundable: true },
    { courseName: "Notion Second Brain", courseCode: "notion-second-brain", description: "Build a personal knowledge system that stays usable past week one.", mainCategory: "Productivity", shortCourse: "Notion", courseType: "Workshop", pricePaise: 79900, priceUsdCents: 1499, mangoId: "b2", refundable: false },
]

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    }
}

/** @param plan {{courses: 'ok'|'fail'|'empty', country: 'IN'|'US'|'fail', hang?: boolean}} */
function stubFetch(plan) {
    globalThis.fetch = async (url) => {
        if (plan.hang) await new Promise(() => {}) // Never resolves — holds the loading state.

        if (String(url).includes("course-data")) {
            if (plan.courses === "fail") return jsonResponse({ error: "boom" }, 500)
            return jsonResponse(plan.courses === "empty" ? [] : COURSES)
        }
        if (plan.country === "fail") return jsonResponse({ error: "boom" }, 500)
        return jsonResponse({ country_code: plan.country })
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SkillpathCourses = await loadComponent()

/**
 * Mounts the component and lets its promises settle.
 *
 * The component retries up to four times with backoff, so failure scenarios need
 * real elapsed time before the error state appears — hence the generous settle.
 */
async function render(props, { settleMs = 60 } = {}) {
    const host = dom.window.document.createElement("div")
    dom.window.document.body.appendChild(host)

    let root
    await act(async () => {
        root = createRoot(host)
        root.render(React.createElement(SkillpathCourses, props))
    })
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, settleMs))
    })

    return {
        html: host.innerHTML,
        text: host.textContent,
        host,
        unmount: () => act(() => root.unmount()),
    }
}

const NO_RAW_ERRORS = /\b(TypeError|ReferenceError|undefined is not|\[object Object\]|NaN|Internal Server Error|status 500)\b/

console.log("\n[1] Server rendering (Framer pre-renders published pages)")
{
    let markup = ""
    let threw = null
    try {
        markup = renderToString(React.createElement(SkillpathCourses, {}))
    } catch (error) {
        threw = error
    }
    check("renders on the server without throwing", threw === null, threw && String(threw.message))
    check("server markup is not blank", markup.length > 200, `length ${markup.length}`)
    check("server markup shows the loading state, not an error", markup.includes("sp-skeleton"))
}

console.log("\n[2] Loading state")
{
    stubFetch({ courses: "ok", country: "IN", hang: true })
    const view = await render({}, { settleMs: 30 })
    check("skeleton cards are on screen", view.html.includes("sp-skeleton"))
    check("no spinner-only blank box — the grid is laid out", view.html.includes("sp-grid"))
    check("marked busy for assistive tech", view.html.includes('aria-busy="true"'))
    check("nothing renders raw error text", !NO_RAW_ERRORS.test(view.text))
    view.unmount()
}

console.log("\n[3] Working state — India")
{
    stubFetch({ courses: "ok", country: "IN" })
    const view = await render({})
    check("course names render", view.text.includes("How To YouTube"))
    check("199900 paise renders as ₹1,999", view.text.includes("₹1,999"), view.text.slice(0, 400))
    check("79900 paise renders as ₹799", view.text.includes("₹799"))
    check("does NOT render the un-divided ₹1,99,900", !view.text.includes("1,99,900"))
    check("no dollar prices leak in", !view.text.includes("$39.99"))
    check("the extra field (category) is shown", view.text.includes("Content Creation"))
    check("refundable badge shows on the refundable course", view.html.includes("sp-pill-refund"))
    check("exactly one refundable badge — the other course is false",
        (view.html.match(/sp-pill-refund/g) || []).length === 1)
    check("course count is announced", view.text.includes("Showing 2 courses"))
    check("no region-guess notice when detection worked", !view.text.includes("couldn't confirm"))
    check("skeletons are gone", !view.html.includes("sp-skeleton"))
    view.unmount()
}

console.log("\n[4] Working state — United States")
{
    stubFetch({ courses: "ok", country: "US" })
    const view = await render({})
    check("3999 cents renders as $39.99", view.text.includes("$39.99"))
    check("1499 cents renders as $14.99", view.text.includes("$14.99"))
    check("no rupee prices leak in", !view.text.includes("₹"))
    view.unmount()
}

console.log("\n[5] Error state — course endpoint down")
{
    stubFetch({ courses: "fail", country: "IN" })
    const view = await render({}, { settleMs: 4000 })
    check("a human-readable message is shown", view.text.includes("We couldn't load the courses"))
    check("a retry control exists", view.text.includes("Try again"))
    check("the raw status code is not dumped on screen", !NO_RAW_ERRORS.test(view.text))
    check("the section is not blank", view.text.trim().length > 60)
    check("the heading still renders around the failure", view.text.includes("Courses built to be finished"))
    view.unmount()
}

console.log("\n[6] Empty state — a valid response with zero courses")
{
    stubFetch({ courses: "empty", country: "IN" })
    const view = await render({})
    check("empty is worded differently from an error", view.text.includes("No courses yet"))
    check("not mistaken for a failure", !view.text.includes("We couldn't load"))
    check("offers a refresh", view.text.includes("Refresh"))
    view.unmount()
}

console.log("\n[7] The judgement case — country fails, courses succeed")
{
    stubFetch({ courses: "ok", country: "fail" })
    const view = await render({ fallbackRegion: "IN" }, { settleMs: 4000 })
    check("the course grid still renders", view.text.includes("How To YouTube"))
    check("prices are still shown", view.text.includes("₹1,999"))
    check("the guess is disclosed rather than hidden", view.text.includes("couldn't confirm your location"))
    check("the assumed currency is named", view.text.includes("INR"))
    check("detection can be retried", view.text.includes("Detect again"))
    check("the visitor can override the currency", view.text.includes("Show in $ USD"))
    check("no raw error text", !NO_RAW_ERRORS.test(view.text))
    view.unmount()
}

console.log("\n[8] Fallback region property control drives the guess")
{
    stubFetch({ courses: "ok", country: "fail" })
    const view = await render({ fallbackRegion: "US" }, { settleMs: 4000 })
    check("fallback US prices in dollars", view.text.includes("$39.99"))
    check("names USD as the assumption", view.text.includes("USD"))
    check("offers the rupee override", view.text.includes("Show in ₹ INR"))
    view.unmount()
}

console.log("\n[9] Property controls change the output")
{
    stubFetch({ courses: "ok", country: "IN" })
    const view = await render({ title: "Custom Heading", subtitle: "Custom sub", maxCourses: 1, showSearch: false, showSort: false })
    check("heading control applies", view.text.includes("Custom Heading"))
    check("subheading control applies", view.text.includes("Custom sub"))
    check("max cards caps the grid", view.text.includes("Showing 1 course") && !view.text.includes("Notion Second Brain"))
    check("singular wording at one course", view.text.includes("Showing 1 course") && !view.text.includes("1 courses"))
    check("search hidden when toggled off", !view.html.includes("sp-search-input"))
    check("sort hidden when toggled off", !view.html.includes("sp-sort-select"))
    view.unmount()
}

console.log("\n[10] Accent control reaches the DOM")
{
    stubFetch({ courses: "ok", country: "IN" })
    const view = await render({ accentColor: "#FF0000" })
    check("accent is applied as a CSS variable", view.html.includes("#FF0000") || view.html.includes("255, 0, 0"))
    check("derived tint is a real rgba, not a broken color-mix", view.html.includes("rgba(255, 0, 0"))
    view.unmount()
}

console.log("\n[11] Malformed payload does not blank the section")
{
    globalThis.fetch = async (url) => {
        if (String(url).includes("course-data")) {
            // One good row, three unusable ones, and a null.
            return jsonResponse([COURSES[0], { courseName: "No code" }, null, "garbage", { nope: 1 }])
        }
        return jsonResponse({ country_code: "IN" })
    }
    const view = await render({})
    check("the good course still renders", view.text.includes("How To YouTube"))
    check("bad rows are dropped silently", view.text.includes("Showing 1 course"))
    check("no crash, no raw error", !NO_RAW_ERRORS.test(view.text))
    view.unmount()
}

console.log("\n[12] Non-array payload is treated as an error, not as empty")
{
    globalThis.fetch = async (url) => {
        if (String(url).includes("course-data")) return jsonResponse({ courses: [] })
        return jsonResponse({ country_code: "IN" })
    }
    const view = await render({}, { settleMs: 500 })
    check("shows the error state", view.text.includes("We couldn't load the courses"))
    check("does not claim the catalogue is empty", !view.text.includes("No courses yet"))
    view.unmount()
}

console.log("\n[13] Currency override stays reversible")
{
    stubFetch({ courses: "ok", country: "fail" })
    const view = await render({ fallbackRegion: "IN" }, { settleMs: 4000 })

    const toUsd = [...view.host.querySelectorAll("button")].find((b) => b.textContent.includes("Show in $ USD"))
    check("the override button is present", Boolean(toUsd))

    await act(async () => {
        toUsd.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })

    check("prices switch to dollars", view.host.textContent.includes("$39.99"))
    check("rupee prices are gone", !view.host.textContent.includes("₹1,999"))
    // The regression this guards: the notice used to unmount once a manual
    // choice was made, stranding the visitor in a currency they could not undo.
    check("the notice stays on screen after choosing", view.host.textContent.includes("couldn't confirm your location"))
    check("the reverse toggle is offered", view.host.textContent.includes("Show in ₹ INR"))

    const backToInr = [...view.host.querySelectorAll("button")].find((b) => b.textContent.includes("Show in ₹ INR"))
    await act(async () => {
        backToInr.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })
    check("switching back to rupees works", view.host.textContent.includes("₹1,999"))
    view.unmount()
}

console.log("\n[14] Retry recovers when the API comes back")
{
    let attempts = 0
    globalThis.fetch = async (url) => {
        if (String(url).includes("course-data")) {
            attempts++
            // Fail past the automatic retry budget, so the error state is real,
            // then succeed for the manual retry.
            return attempts <= 4 ? jsonResponse({ error: "boom" }, 500) : jsonResponse(COURSES)
        }
        return jsonResponse({ country_code: "IN" })
    }

    const view = await render({}, { settleMs: 4000 })
    check("error state reached after the retry budget", view.host.textContent.includes("We couldn't load the courses"))

    const retry = [...view.host.querySelectorAll("button")].find((b) => b.textContent.includes("Try again"))
    await act(async () => {
        retry.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
    })

    check("courses render after a successful retry", view.host.textContent.includes("How To YouTube"))
    check("the error message is cleared", !view.host.textContent.includes("We couldn't load the courses"))
    view.unmount()
}

console.log("\n[15] Search filters by name and by category")
{
    stubFetch({ courses: "ok", country: "IN" })
    const view = await render({})
    const input = view.host.querySelector("#sp-search-input")
    check("search input exists", Boolean(input))

    async function type(value) {
        await act(async () => {
            // React overrides the value setter, so set through the prototype and
            // then fire input, the way React's own test utils do.
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set
            setter.call(input, value)
            input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
        })
    }

    await type("notion")
    check("filters by course name, case-insensitively", view.host.textContent.includes("Notion Second Brain") && !view.host.textContent.includes("How To YouTube"))

    await type("Productivity")
    check("filters by category too", view.host.textContent.includes("Notion Second Brain"))

    await type("zzzz")
    check("no matches shows the filter-specific empty state", view.host.textContent.includes("No matches for"))
    check("filter-empty is worded differently from catalogue-empty", !view.host.textContent.includes("No courses yet"))
    check("offers to clear the search", view.host.textContent.includes("Clear search"))
    view.unmount()
}

console.log("\n[16] Sort orders by the currency on screen")
{
    stubFetch({ courses: "ok", country: "IN" })
    const view = await render({})
    const select = view.host.querySelector("#sp-sort-select")
    check("sort control exists", Boolean(select))

    async function choose(value) {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value").set
            setter.call(select, value)
            select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))
        })
    }

    const order = () => [...view.host.querySelectorAll(".sp-name")].map((n) => n.textContent)

    await choose("price-asc")
    check("ascending puts ₹799 before ₹1,999", order()[0] === "Notion Second Brain", order().join(" | "))

    await choose("price-desc")
    check("descending reverses it", order()[0] === "How To YouTube", order().join(" | "))
    view.unmount()
}

console.log("\n[17] Unmount mid-flight does not warn or leak")
{
    stubFetch({ courses: "ok", country: "IN", hang: true })
    const warnings = []
    const realError = console.error
    console.error = (...args) => warnings.push(args.join(" "))

    const view = await render({}, { settleMs: 10 })
    view.unmount()
    await new Promise((resolve) => setTimeout(resolve, 120))

    console.error = realError
    check("no React state-update-after-unmount warnings", warnings.length === 0, warnings.join("\n"))
}

console.log(`\n${"=".repeat(60)}`)
console.log(`  ${passed} passed, ${failed} failed`)
console.log(`${"=".repeat(60)}\n`)

rmSync(TEMP_DIR, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
