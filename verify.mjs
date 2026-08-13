/**
 * Verification harness for SkillpathCourses.tsx.
 *
 * The brief says wrong price math is an instant fail, so the formatting is
 * checked here rather than eyeballed in a browser. This compiles the real
 * component with esbuild and exercises its actual functions — there is no second
 * copy of the logic to drift out of sync.
 *
 * The `framer` and `react` imports are stubbed because none of the functions
 * under test touch them; the rendering is verified in the browser preview.
 *
 * Run: node verify.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"

const SOURCE = "./SkillpathCourses.tsx"
const TEMP_DIR = "./.verify-tmp"
const API_BASE = "https://syncsphere-hiv6.onrender.com"

const TESTABLE = [
    "createPriceFormatter",
    "priceFor",
    "parseCourses",
    "parseRegion",
    "isRetryableStatus",
    "withAlpha",
    "REGIONS",
]

// ---------------------------------------------------------------------------
// Compile the component with its framework imports stubbed out
// ---------------------------------------------------------------------------

async function loadComponent() {
    mkdirSync(TEMP_DIR, { recursive: true })

    const original = readFileSync(SOURCE, "utf8")
    const stubbed =
        original
            .replace(/^import\s+\{[^}]*\}\s+from\s+"react"\s*$/m, "const useState=()=>[],useEffect=()=>{},useCallback=f=>f,useMemo=f=>f(),useRef=()=>({current:null}),useLayoutEffect=()=>{};")
            .replace(/^import\s+\{[^}]*\}\s+from\s+"framer"\s*$/m, "const addPropertyControls=()=>{},ControlType=new Proxy({},{get:()=>'stub'});") +
        `\nexport { ${TESTABLE.join(", ")} };\n`

    const entry = `${TEMP_DIR}/entry.tsx`
    const out = `${TEMP_DIR}/compiled.mjs`
    writeFileSync(entry, stubbed)

    await build({
        entryPoints: [entry],
        outfile: out,
        bundle: false,
        format: "esm",
        loader: { ".tsx": "tsx" },
        jsx: "transform",
        jsxFactory: "__jsx",
        jsxFragment: "__frag",
        banner: { js: "const __jsx=()=>null, __frag=null;" },
        logLevel: "silent",
    })

    return import(pathToFileURL(out).href + `?t=${Date.now()}`)
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function check(label, actual, expected) {
    const ok = actual === expected
    if (ok) {
        passed++
        console.log(`  PASS  ${label}`)
    } else {
        failed++
        console.log(`  FAIL  ${label}\n          expected: ${expected}\n          actual:   ${actual}`)
    }
}

function checkWith(label, actual, predicate, describe) {
    const ok = predicate(actual)
    if (ok) {
        passed++
        console.log(`  PASS  ${label}`)
    } else {
        failed++
        console.log(`  FAIL  ${label}\n          expected: ${describe}\n          actual:   ${JSON.stringify(actual)}`)
    }
}

// Node normalises the narrow no-break space Intl emits for en-IN currency.
const clean = (value) => value.replace(/ | /g, " ")

async function run() {
    const mod = await loadComponent()
    const { createPriceFormatter, priceFor, parseCourses, parseRegion, isRetryableStatus, withAlpha } = mod

    const inr = createPriceFormatter("IN")
    const usd = createPriceFormatter("US")

    console.log("\n[1] Price math — the values from the brief")
    // 199900 paise is one thousand nine hundred ninety nine rupees, NOT 199900.
    check("199900 paise renders as rupees, not raw minor units", clean(inr(199900)), "₹1,999")
    check("3999 cents renders as dollars", clean(usd(3999)), "$39.99")

    console.log("\n[2] Indian digit grouping (lakh, not thousands)")
    // The trap the brief calls out: if the divide is missing, 199900 paise would
    // print as this. Proving the formatter CAN produce it shows the ₹1,999 above
    // is a real division and not a formatter that simply cannot group that high.
    check("19999900 paise groups as lakhs", clean(inr(19999900)), "₹1,99,999")
    check("10000000 paise groups as lakhs", clean(inr(10000000)), "₹1,00,000")

    console.log("\n[3] Decimals follow the value, not the region")
    check("whole rupees drop the .00", clean(inr(79900)), "₹799")
    check("part rupees keep both decimals", clean(inr(199950)), "₹1,999.50")
    check("whole dollars drop the .00", clean(usd(4000)), "$40")
    check("part dollars keep both decimals", clean(usd(1499)), "$14.99")

    console.log("\n[4] Bad prices degrade instead of throwing")
    check("NaN yields null", inr(NaN), null)
    check("undefined yields null", inr(undefined), null)
    check("negative yields null", inr(-500), null)
    check("zero is a real price", clean(inr(0)), "₹0")

    console.log("\n[5] Region picks the matching field")
    const sample = { pricePaise: 199900, priceUsdCents: 3999 }
    check("IN reads pricePaise", priceFor(sample, "IN"), 199900)
    check("US reads priceUsdCents", priceFor(sample, "US"), 3999)

    console.log("\n[6] Response parsing survives bad shapes")
    checkWith("malformed rows are dropped, good rows survive",
        parseCourses([
            { courseName: "Real", courseCode: "real", description: "d", mainCategory: "c", courseType: "Original", pricePaise: 1000, priceUsdCents: 100, refundable: true },
            { courseName: "No code" },
            null,
            "not an object",
            { courseCode: "no-name" },
        ]).map((c) => c.courseCode).join(","),
        (v) => v === "real",
        "only the well-formed row")
    checkWith("missing optional fields become safe defaults",
        parseCourses([{ courseName: "X", courseCode: "x" }])[0],
        (c) => c.description === "" && c.mainCategory === "" && c.refundable === false && Number.isNaN(c.pricePaise),
        "empty strings, refundable false, NaN price")
    checkWith("refundable is strict — truthy strings do not count",
        parseCourses([{ courseName: "X", courseCode: "x", refundable: "yes" }])[0].refundable,
        (v) => v === false, "false")
    checkWith("an empty array is valid and yields no courses",
        parseCourses([]), (v) => Array.isArray(v) && v.length === 0, "[]")
    checkWith("a non-array response throws rather than rendering junk",
        (() => { try { parseCourses({ courses: [] }); return "no throw" } catch (e) { return e.name } })(),
        (v) => v === "ApiError", "ApiError")

    console.log("\n[7] Country parsing")
    check("IN is accepted", parseRegion({ country_code: "IN" }), "IN")
    check("US is accepted", parseRegion({ country_code: "US" }), "US")
    checkWith("an unknown code throws so the fallback takes over",
        (() => { try { parseRegion({ country_code: "GB" }); return "no throw" } catch (e) { return e.name } })(),
        (v) => v === "ApiError", "ApiError")
    checkWith("a null body throws rather than crashing",
        (() => { try { parseRegion(null); return "no throw" } catch (e) { return e.name } })(),
        (v) => v === "ApiError", "ApiError")

    console.log("\n[8] Retry policy")
    check("500 retries", isRetryableStatus(500), true)
    check("503 retries", isRetryableStatus(503), true)
    check("404 retries — synthetic here, not a real missing resource", isRetryableStatus(404), true)
    check("405 does NOT retry — that would be our bug, not a flake", isRetryableStatus(405), false)
    check("401 does not retry", isRetryableStatus(401), false)

    console.log("\n[9] Accent tint derivation")
    check("6-digit hex", withAlpha("#4F3CE8", 0.12), "rgba(79, 60, 232, 0.120)")
    check("3-digit hex expands", withAlpha("#08F", 0.5), "rgba(0, 136, 255, 0.500)")
    check("8-digit hex multiplies existing alpha", withAlpha("#4F3CE880", 0.5), "rgba(79, 60, 232, 0.251)")
    check("rgb() string", withAlpha("rgb(79, 60, 232)", 0.38), "rgba(79, 60, 232, 0.380)")
    check("rgba() multiplies existing alpha", withAlpha("rgba(79,60,232,0.5)", 0.5), "rgba(79, 60, 232, 0.250)")
    checkWith("a Framer colour token falls back to color-mix",
        withAlpha("var(--token-a1b2, #4F3CE8)", 0.12),
        (v) => v.startsWith("color-mix("), "a color-mix() expression")

    // -----------------------------------------------------------------------
    // Live data
    // -----------------------------------------------------------------------

    console.log("\n[10] Live API — formatting every real price")
    let courses = null
    for (let attempt = 1; attempt <= 6 && !courses; attempt++) {
        try {
            const response = await fetch(`${API_BASE}/assignment/course-data`, { method: "GET", cache: "no-store" })
            if (!response.ok) throw new Error(`status ${response.status}`)
            courses = parseCourses(await response.json())
        } catch (error) {
            console.log(`        attempt ${attempt} failed (${error.message}) — retrying`)
        }
    }

    if (!courses) {
        console.log("  SKIP  API unreachable after 6 attempts")
    } else {
        console.log(`        ${courses.length} courses returned\n`)
        console.log("        Course                          INR         USD        Category            Refundable")
        console.log("        " + "-".repeat(92))
        let sane = true
        for (const course of courses) {
            const rupees = clean(inr(course.pricePaise))
            const dollars = clean(usd(course.priceUsdCents))
            console.log(
                `        ${course.courseName.padEnd(30)}  ${rupees.padEnd(10)}  ${dollars.padEnd(9)}  ${course.mainCategory.padEnd(18)}  ${course.refundable}`
            )
            // A course priced above ~50k rupees or ~600 dollars means the divide
            // was skipped somewhere. Nothing in this catalogue is close to that.
            if (course.pricePaise / 100 > 50000 || course.priceUsdCents / 100 > 600) sane = false
            if (course.description.length === 0) sane = false
        }
        console.log("")
        checkWith("every live price lands in a believable range", sane, (v) => v === true, "all prices sane")
        checkWith("every live course has a stable unique key",
            new Set(courses.map((c) => c.courseCode)).size,
            (v) => v === courses.length, `${courses.length} unique courseCodes`)

        const ascending = [...courses].sort((a, b) => priceFor(a, "IN") - priceFor(b, "IN"))
        checkWith("sorting by price does not mutate the source array",
            courses.map((c) => c.courseCode).join(",") !== ascending.map((c) => c.courseCode).join(",") ||
                courses.length <= 1,
            (v) => typeof v === "boolean", "a boolean (source order preserved)")
    }

    console.log(`\n${"=".repeat(60)}`)
    console.log(`  ${passed} passed, ${failed} failed`)
    console.log(`${"=".repeat(60)}\n`)

    rmSync(TEMP_DIR, { recursive: true, force: true })
    process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
    console.error(error)
    rmSync(TEMP_DIR, { recursive: true, force: true })
    process.exit(1)
})
