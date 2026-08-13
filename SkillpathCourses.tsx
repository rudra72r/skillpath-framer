import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from "react"
import { addPropertyControls, ControlType } from "framer"

/**
 * Skillpath — Courses section.
 *
 * Pulls live data from two independent endpoints and renders a responsive grid.
 * The API is deliberately unreliable (~1 in 3 requests returns 404 or 500), so
 * most of the thinking here is about failure, not about the happy path.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 900
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "https://syncsphere-hiv6.onrender.com"

/**
 * Per-request ceiling. The API normally answers in ~250ms, but it is hosted on
 * a platform that cold-starts after idle, so a first request can be slow.
 * 15s is generous enough to ride out a cold start and short enough that a truly
 * dead endpoint surfaces an error instead of hanging the section forever.
 */
const REQUEST_TIMEOUT_MS = 15000

/**
 * The API fails on purpose, so retrying is not optional.
 *
 * Measured over 60 calls while building this: 65% succeeded, 35% failed (15x500,
 * 6x404). At p(fail) = 0.35, four attempts put the odds of the visitor actually
 * seeing an error at 0.35^4 ~= 1.5%, against 4.3% for three. That gap sounds
 * small until you load the page repeatedly — across five visits it is the
 * difference between hitting an error 7% of the time and 20% of the time.
 *
 * Stopping at four is deliberate. The failures come in bursts rather than evenly
 * spaced, so the fifth attempt buys much less than the curve suggests, and every
 * extra attempt is time a visitor spends watching skeletons. What is left over
 * goes to the Retry button, which keeps a genuinely dead API failing fast
 * instead of hanging the section for a minute.
 */
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 400

/**
 * Column counts are chosen from the component's own width, not the viewport.
 * A code component can be dropped into a narrow container on a wide screen, and
 * a viewport media query would confidently render 3 columns into a 320px box.
 */
const BREAKPOINT_3_COL = 1024
const BREAKPOINT_2_COL = 680

const REGIONS = {
    IN: { locale: "en-IN", currency: "INR", minorField: "pricePaise", label: "India", symbol: "₹" },
    US: { locale: "en-US", currency: "USD", minorField: "priceUsdCents", label: "United States", symbol: "$" },
} as const

type RegionCode = keyof typeof REGIONS

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Carries the HTTP status so the UI can say something specific and truthful. */
class ApiError extends Error {
    status: number
    retryable: boolean
    constructor(message: string, status: number, retryable: boolean) {
        super(message)
        this.name = "ApiError"
        this.status = status
        this.retryable = retryable
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError"
}

/**
 * A 404 would normally be permanent — retrying a missing resource is pointless.
 * This API is documented to inject synthetic 404s alongside its 500s, so here it
 * is a transient fault and worth retrying.
 *
 * 405 is deliberately excluded. It means we sent a verb this API refuses, which
 * would be a bug in this file rather than a flake, and retrying would only
 * repeat it. We only ever send GET, so it should never appear.
 */
function isRetryableStatus(status: number): boolean {
    if (status === 404) return true
    if (status >= 500) return true
    return false
}

function backoffDelay(attempt: number): number {
    // Exponential with full jitter. The jitter matters because both endpoints
    // are called at once — without it their retries stay in lockstep and hit
    // the struggling server in bursts.
    const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1)
    return Math.random() * ceiling
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(new DOMException("Aborted", "AbortError"))
            },
            { once: true }
        )
    })
}

/** One GET, with its own timeout, chained to the caller's abort signal. */
async function getJsonOnce(path: string, signal: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort()
    signal.addEventListener("abort", abortFromCaller, { once: true })

    // A timeout and a real cancellation both surface as AbortError, but only one
    // of them is worth retrying. This flag keeps them apart.
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, REQUEST_TIMEOUT_MS)

    try {
        const response = await fetch(`${API_BASE}${path}`, {
            method: "GET", // Every other verb returns 405. Nothing here mutates anything.
            // No custom headers, on purpose. Adding even one would make this a
            // non-simple CORS request and put a preflight OPTIONS in front of
            // every call. When one request in three already fails, doubling the
            // number of requests is the wrong trade for headers we do not need.
            cache: "no-store", // /country-code flips per call; a cached copy would freeze it.
            signal: controller.signal,
        })

        if (!response.ok) {
            throw new ApiError(
                `Request failed with status ${response.status}`,
                response.status,
                isRetryableStatus(response.status)
            )
        }

        return await response.json()
    } catch (error) {
        if (isAbortError(error) && timedOut) {
            throw new ApiError("Request timed out", 0, true)
        }
        if (isAbortError(error)) throw error
        if (error instanceof ApiError) throw error
        // Network drop, DNS failure, or a malformed body from a flaky server.
        // All plausibly transient, so all retryable.
        throw new ApiError("Could not reach the server", 0, true)
    } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", abortFromCaller)
    }
}

/** GET with bounded retries. Throws the last error once attempts run out. */
async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await getJsonOnce(path, signal)
        } catch (error) {
            if (isAbortError(error)) throw error
            if (error instanceof ApiError && !error.retryable) throw error

            lastError = error
            if (attempt < MAX_ATTEMPTS) {
                await sleep(backoffDelay(attempt), signal)
            }
        }
    }

    throw lastError
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Course {
    courseName: string
    courseCode: string
    description: string
    mainCategory: string
    courseType: string
    pricePaise: number
    priceUsdCents: number
    refundable: boolean
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

/**
 * courseCode is required because it is this component's React key — it is unique
 * and stable across responses, unlike an array index, which would reshuffle card
 * state every time the API returns a different subset.
 */
function isRenderableCourse(value: unknown): value is Course {
    if (typeof value !== "object" || value === null) return false
    const course = value as Record<string, unknown>
    return isNonEmptyString(course.courseName) && isNonEmptyString(course.courseCode)
}

/**
 * Trusts nothing about the response shape. One malformed row gets dropped rather
 * than being allowed to throw and blank out the whole section.
 */
function parseCourses(raw: unknown): Course[] {
    if (!Array.isArray(raw)) {
        throw new ApiError("The server sent data in an unexpected format", 0, false)
    }

    return raw.filter(isRenderableCourse).map((course) => ({
        courseName: course.courseName,
        courseCode: course.courseCode,
        description: isNonEmptyString(course.description) ? course.description : "",
        mainCategory: isNonEmptyString(course.mainCategory) ? course.mainCategory : "",
        courseType: isNonEmptyString(course.courseType) ? course.courseType : "",
        pricePaise: typeof course.pricePaise === "number" ? course.pricePaise : NaN,
        priceUsdCents: typeof course.priceUsdCents === "number" ? course.priceUsdCents : NaN,
        refundable: course.refundable === true,
    }))
}

function parseRegion(raw: unknown): RegionCode {
    const code = (raw as { country_code?: unknown } | null)?.country_code
    if (code === "IN" || code === "US") return code
    throw new ApiError("The server sent an unrecognised country code", 0, false)
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/**
 * Both prices arrive in minor units: 199900 paise is ₹1,999 and 3999 cents is
 * $39.99. Dividing by 100 is the entire trick, and skipping it is what produces
 * the ₹1,99,900 that this assignment explicitly warns about.
 *
 * Intl.NumberFormat is built once per region rather than per card — constructing
 * one is expensive, and a 10-card grid would otherwise build 10 of them a render.
 */
function createPriceFormatter(region: RegionCode) {
    const { locale, currency } = REGIONS[region]

    const whole = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    })
    const fractional = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })

    return (minorUnits: number): string | null => {
        if (typeof minorUnits !== "number" || !Number.isFinite(minorUnits) || minorUnits < 0) {
            return null
        }
        // Decimals are decided by the value, not by the region. Every USD price
        // here ends in .99 and every INR price is whole rupees, so this happens
        // to render $39.99 and ₹1,999 — but a ₹1,999.50 would still be correct.
        const formatter = minorUnits % 100 === 0 ? whole : fractional
        return formatter.format(minorUnits / 100)
    }
}

function priceFor(course: Course, region: RegionCode): number {
    return region === "IN" ? course.pricePaise : course.priceUsdCents
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Derives the translucent tints (pill backgrounds, focus rings, hover borders)
 * from the single accent the designer picks.
 *
 * This is done in JavaScript rather than with CSS color-mix() because color-mix
 * fails silently on older browsers — the tint would simply not paint, and the
 * pills would lose their background with nothing in the console to explain why.
 *
 * Framer's colour control usually hands over a hex or rgb() string, but a colour
 * *style* from the project arrives as `var(--token-xyz, #4F3CE8)`, which cannot
 * be parsed. That case falls back to color-mix, which handles the token fine on
 * any browser new enough to be running a Framer site with design tokens in it.
 */
function withAlpha(color: string, alpha: number): string {
    const value = color.trim()

    const hex = value.match(/^#([0-9a-f]{3,8})$/i)?.[1]
    if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
        const full = hex.length === 3 ? hex.replace(/./g, (char) => char + char) : hex
        const red = parseInt(full.slice(0, 2), 16)
        const green = parseInt(full.slice(2, 4), 16)
        const blue = parseInt(full.slice(4, 6), 16)
        // An 8-digit hex carries its own alpha; multiply rather than discard it.
        const baseAlpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
        return `rgba(${red}, ${green}, ${blue}, ${(alpha * baseAlpha).toFixed(3)})`
    }

    const channels = value.match(/^rgba?\(([^)]+)\)$/i)?.[1]
    if (channels) {
        const parts = channels.split(/[\s,/]+/).filter(Boolean)
        if (parts.length >= 3) {
            const baseAlpha = parts.length > 3 ? parseFloat(parts[3]) : 1
            return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${(alpha * baseAlpha).toFixed(3)})`
        }
    }

    return `color-mix(in srgb, ${value} ${Math.round(alpha * 100)}%, transparent)`
}

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

type Status = "loading" | "ready" | "error"

interface CoursesState {
    status: Status
    items: Course[]
    error: ApiError | null
}

interface RegionState {
    status: Status
    code: RegionCode | null
    /**
     * True once a lookup has finished, win or lose.
     *
     * Tracked separately from `status` so the "we couldn't confirm your location"
     * notice stays put while a retry is in flight. Keying the notice off
     * `status === "error"` alone made it disappear the moment someone pressed
     * Detect again, and flash back when that attempt also failed.
     */
    attempted: boolean
}

/**
 * The two endpoints are fetched on separate lifecycles, and that is the whole
 * point of this hook.
 *
 * Promise.all would tie them together, so a failed country lookup — the less
 * important of the two — would take down a course list that arrived perfectly
 * well. Keeping them apart means each one loads, fails, and retries on its own.
 */
function useSkillpathData() {
    const [courses, setCourses] = useState<CoursesState>({ status: "loading", items: [], error: null })
    const [region, setRegion] = useState<RegionState>({ status: "loading", code: null, attempted: false })

    const coursesAbort = useRef<AbortController | null>(null)
    const regionAbort = useRef<AbortController | null>(null)

    const loadCourses = useCallback(async () => {
        coursesAbort.current?.abort() // Cancel any in-flight load before starting another.
        const controller = new AbortController()
        coursesAbort.current = controller

        setCourses((previous) => ({ ...previous, status: "loading", error: null }))
        try {
            const items = parseCourses(await getJson("/assignment/course-data", controller.signal))
            setCourses({ status: "ready", items, error: null })
        } catch (error) {
            if (isAbortError(error)) return // Unmounted or superseded; nothing to report.
            setCourses({
                status: "error",
                items: [],
                error: error instanceof ApiError ? error : new ApiError("Something went wrong", 0, true),
            })
        }
    }, [])

    const loadRegion = useCallback(async () => {
        regionAbort.current?.abort()
        const controller = new AbortController()
        regionAbort.current = controller

        setRegion((previous) => ({ ...previous, status: "loading" }))
        try {
            const code = parseRegion(await getJson("/assignment/country-code", controller.signal))
            setRegion({ status: "ready", code, attempted: true })
        } catch (error) {
            if (isAbortError(error)) return
            setRegion({ status: "error", code: null, attempted: true })
        }
    }, [])

    useEffect(() => {
        loadCourses()
        loadRegion()
        return () => {
            coursesAbort.current?.abort()
            regionAbort.current?.abort()
        }
    }, [loadCourses, loadRegion])

    return { courses, region, loadCourses, loadRegion }
}

// ---------------------------------------------------------------------------
// Layout hook
// ---------------------------------------------------------------------------

// useLayoutEffect measures before paint, which avoids a visible flash of the
// wrong column count. It warns during server rendering, where there is nothing
// to measure, so fall back to useEffect there.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

function useColumnCount(ref: React.RefObject<HTMLElement>): number {
    const [columns, setColumns] = useState(3)

    useIsomorphicLayoutEffect(() => {
        const element = ref.current
        if (!element || typeof ResizeObserver === "undefined") return

        const observer = new ResizeObserver(([entry]) => {
            const width = entry.contentRect.width
            const next = width >= BREAKPOINT_3_COL ? 3 : width >= BREAKPOINT_2_COL ? 2 : 1
            // Only set state on an actual change; ResizeObserver fires on every
            // sub-pixel nudge and this would otherwise re-render constantly.
            setColumns((current) => (current === next ? current : next))
        })

        observer.observe(element)
        return () => observer.disconnect()
    }, [ref])

    return columns
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Hover, focus rings, keyframes and line clamping cannot be expressed as inline
// styles, so one stylesheet is injected once per page. Everything that a
// property control can change is a CSS variable set on the instance root, which
// keeps the sheet static and still lets two instances carry different accents.
const STYLE_ID = "skillpath-courses-styles"

const STYLES = `
.sp-root {
  --sp-ink: #12100E;
  --sp-muted: #6B6560;
  --sp-line: rgba(18, 16, 14, 0.10);
  --sp-surface: #FFFFFF;
  --sp-radius: 16px;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--sp-ink);
  width: 100%;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
.sp-root *, .sp-root *::before, .sp-root *::after { box-sizing: border-box; }

.sp-head { display: flex; flex-direction: column; gap: 10px; margin-bottom: 28px; }
.sp-title { font-size: clamp(28px, 3.4vw, 42px); line-height: 1.12; letter-spacing: -0.028em; font-weight: 700; margin: 0; }
.sp-subtitle { font-size: clamp(15px, 1.3vw, 17px); line-height: 1.55; color: var(--sp-muted); margin: 0; max-width: 60ch; }

.sp-toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 24px; }
.sp-search { position: relative; flex: 1 1 260px; min-width: 0; }
.sp-search-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--sp-muted); pointer-events: none; display: flex; }
.sp-input, .sp-select {
  width: 100%; height: 44px; border-radius: 10px; border: 1px solid var(--sp-line);
  background: var(--sp-surface); color: var(--sp-ink); font: inherit; font-size: 15px;
  padding: 0 14px; outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.sp-input { padding-left: 42px; }
.sp-select { width: auto; min-width: 168px; cursor: pointer; padding-right: 32px;
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 18px) 19px, calc(100% - 13px) 19px;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.sp-input:focus-visible, .sp-select:focus-visible { border-color: var(--sp-accent); box-shadow: 0 0 0 3px var(--sp-accent-soft); }
.sp-input::placeholder { color: var(--sp-muted); }

.sp-grid { display: grid; gap: 20px; align-items: stretch; }

.sp-card {
  display: flex; flex-direction: column; height: 100%;
  background: var(--sp-surface); border: 1px solid var(--sp-line);
  border-radius: var(--sp-radius); padding: 22px;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.sp-card:hover { transform: translateY(-3px); border-color: var(--sp-accent-line); box-shadow: 0 12px 28px -12px rgba(18, 16, 14, 0.18); }

.sp-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.sp-pill {
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.02em; line-height: 1;
  padding: 6px 10px; border-radius: 999px; white-space: nowrap;
  color: var(--sp-accent); background: var(--sp-accent-soft);
}
.sp-pill-refund { color: #0F7B4F; background: rgba(15, 123, 79, 0.10); display: inline-flex; align-items: center; gap: 4px; }

.sp-name { font-size: 18px; line-height: 1.3; letter-spacing: -0.015em; font-weight: 650; margin: 0 0 8px; }

/* Two lines, then a real ellipsis. min-height reserves the second line so a
   short description does not shift the price row out of alignment. */
.sp-desc {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; font-size: 14.5px; line-height: 1.55; color: var(--sp-muted);
  margin: 0 0 20px; min-height: calc(2 * 1.55 * 14.5px);
}

/* margin-top:auto pins the price to the bottom, so prices line up across a row
   no matter how tall the text above them is. */
.sp-foot { margin-top: auto; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-top: 16px; border-top: 1px solid var(--sp-line); }
.sp-price { font-size: 21px; font-weight: 700; letter-spacing: -0.02em; }
.sp-price-missing { font-size: 14px; font-weight: 500; color: var(--sp-muted); }
.sp-type { font-size: 12px; font-weight: 550; color: var(--sp-muted); white-space: nowrap; }

.sp-btn {
  font: inherit; font-size: 14.5px; font-weight: 600; cursor: pointer;
  height: 42px; padding: 0 18px; border-radius: 10px;
  border: 1px solid var(--sp-accent); background: var(--sp-accent); color: #fff;
  transition: opacity 0.15s ease, box-shadow 0.15s ease;
}
.sp-btn:hover { opacity: 0.88; }
.sp-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--sp-accent-soft); }
.sp-btn-ghost { background: transparent; color: var(--sp-ink); border-color: var(--sp-line); }
.sp-btn-sm { height: 34px; padding: 0 13px; font-size: 13px; border-radius: 8px; }
.sp-btn[disabled] { opacity: 0.55; cursor: default; }

.sp-panel {
  border: 1px solid var(--sp-line); border-radius: var(--sp-radius);
  background: var(--sp-surface); padding: 44px 28px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
.sp-panel-title { font-size: 18px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
.sp-panel-body { font-size: 14.5px; line-height: 1.55; color: var(--sp-muted); margin: 0; max-width: 44ch; }
.sp-panel-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }

.sp-notice {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  border: 1px solid var(--sp-line); border-left: 3px solid #C2822A;
  background: rgba(194, 130, 42, 0.055);
  border-radius: 10px; padding: 12px 16px; margin-bottom: 20px;
}
.sp-notice-text { font-size: 13.5px; line-height: 1.5; color: var(--sp-ink); margin: 0; flex: 1 1 260px; }
.sp-notice-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.sp-count { font-size: 13px; color: var(--sp-muted); margin: 0 0 16px; }

/* Skeletons mirror the real card's geometry so the grid does not jump when the
   data lands. */
.sp-skeleton { pointer-events: none; }
.sp-bone { border-radius: 6px; background: linear-gradient(90deg, rgba(18,16,14,0.055) 25%, rgba(18,16,14,0.10) 37%, rgba(18,16,14,0.055) 63%); background-size: 400% 100%; animation: sp-shimmer 1.35s ease-in-out infinite; }

@keyframes sp-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

@media (prefers-reduced-motion: reduce) {
  .sp-root *, .sp-root *::before, .sp-root *::after { animation: none !important; transition: none !important; }
  .sp-card:hover { transform: none; }
}

.sp-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`

function useStyleSheet() {
    useIsomorphicLayoutEffect(() => {
        if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return
        const tag = document.createElement("style")
        tag.id = STYLE_ID
        tag.textContent = STYLES
        document.head.appendChild(tag)
        // Deliberately not removed on unmount: other instances may still be
        // using it, and re-injecting on every mount would cause a flash.
    }, [])
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function SearchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
        </svg>
    )
}

function CheckIcon() {
    return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" />
        </svg>
    )
}

function SkeletonCard() {
    return (
        <div className="sp-card sp-skeleton" aria-hidden="true">
            <div className="sp-tags">
                <div className="sp-bone" style={{ width: 92, height: 22, borderRadius: 999 }} />
            </div>
            <div className="sp-bone" style={{ width: "72%", height: 18, marginBottom: 12 }} />
            <div className="sp-bone" style={{ width: "100%", height: 12, marginBottom: 8 }} />
            <div className="sp-bone" style={{ width: "84%", height: 12, marginBottom: 28 }} />
            <div className="sp-foot">
                <div className="sp-bone" style={{ width: 78, height: 22 }} />
                <div className="sp-bone" style={{ width: 54, height: 13 }} />
            </div>
        </div>
    )
}

interface CourseCardProps {
    course: Course
    region: RegionCode
    formatPrice: (minorUnits: number) => string | null
}

function CourseCard({ course, region, formatPrice }: CourseCardProps) {
    const price = formatPrice(priceFor(course, region))

    return (
        <article className="sp-card">
            <div className="sp-tags">
                {/* mainCategory is the extra field. Of everything the API returns it
                    is the only one that helps a learner answer "is this for me?" —
                    courseCode and mangoId are internal identifiers and shortCourse
                    just repeats the name. It is also searchable below, so it does
                    real work rather than sitting there as decoration. */}
                {course.mainCategory && <span className="sp-pill">{course.mainCategory}</span>}
                {course.refundable && (
                    <span className="sp-pill sp-pill-refund">
                        <CheckIcon />
                        Refundable
                    </span>
                )}
            </div>

            <h3 className="sp-name">{course.courseName}</h3>
            <p className="sp-desc">{course.description}</p>

            <div className="sp-foot">
                {price ? (
                    <span className="sp-price">{price}</span>
                ) : (
                    // A single broken price should not take out the card.
                    <span className="sp-price-missing">Price unavailable</span>
                )}
                {course.courseType && <span className="sp-type">{course.courseType}</span>}
            </div>
        </article>
    )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SortMode = "default" | "price-asc" | "price-desc"

interface Props {
    title?: string
    subtitle?: string
    accentColor?: string
    fallbackRegion?: RegionCode
    maxCourses?: number
    showSearch?: boolean
    showSort?: boolean
    style?: React.CSSProperties
}

// Defaults live in the parameter list rather than in a defaultProps object.
// defaultProps is deprecated for function components in React 18.3 and removed
// outright in React 19, so this is the version that will still work later.
export default function SkillpathCourses({
    title = "Courses built to be finished",
    subtitle = "Practical, self-paced programmes taught by people who do the work. Live pricing, updated for your region.",
    accentColor = "#4F3CE8",
    fallbackRegion = "IN",
    maxCourses = 0,
    showSearch = true,
    showSort = true,
    style,
}: Props) {
    useStyleSheet()

    const rootRef = useRef<HTMLElement>(null)
    const columns = useColumnCount(rootRef)
    const { courses, region, loadCourses, loadRegion } = useSkillpathData()

    const [query, setQuery] = useState("")
    const [sortMode, setSortMode] = useState<SortMode>("default")
    // Only used when detection fails — it lets the visitor correct the currency
    // themselves instead of waiting on an endpoint that may keep failing.
    const [manualRegion, setManualRegion] = useState<RegionCode | null>(null)

    /**
     * Precedence: an explicit choice by the visitor, then whatever the API
     * reported, then the region the designer picked in the panel.
     *
     * Keeping the fallback out of the fetch state and applying it here means
     * changing the property control re-prices the grid instantly, with no refetch.
     */
    const activeRegion: RegionCode = manualRegion ?? region.code ?? fallbackRegion

    // "Assumed" means the API never told us — not that the visitor has not
    // chosen. A manual override still leaves the location unconfirmed, so the
    // notice has to stay on screen, otherwise picking one currency would remove
    // the only control for picking the other one back.
    const regionIsAssumed = region.attempted && region.code === null

    const formatPrice = useMemo(() => createPriceFormatter(activeRegion), [activeRegion])

    const visibleCourses = useMemo(() => {
        const term = query.trim().toLowerCase()

        // Searching name and category together means the category pill on each
        // card doubles as a filter, without another dropdown in the toolbar.
        let result = term
            ? courses.items.filter(
                  (course) =>
                      course.courseName.toLowerCase().includes(term) ||
                      course.mainCategory.toLowerCase().includes(term)
              )
            : courses.items

        if (sortMode !== "default") {
            // Sort by the currency actually on screen. The paise and cents values
            // are not perfectly proportional, so sorting by one while displaying
            // the other could put the cards in an order that looks wrong.
            // Copied first — sorting in place would mutate the state array.
            const direction = sortMode === "price-asc" ? 1 : -1
            result = [...result].sort((a, b) => (priceFor(a, activeRegion) - priceFor(b, activeRegion)) * direction)
        }

        // 0 means "show everything", which is also what happens if the API sends
        // fewer courses than the cap.
        return maxCourses > 0 ? result.slice(0, maxCourses) : result
    }, [courses.items, query, sortMode, activeRegion, maxCourses])

    const gridStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
    // minmax(0, 1fr) rather than 1fr: a long unbroken string in a grid child
    // otherwise forces the column past its share and blows out the row.

    const rootStyle = {
        ...style,
        // Property-control values reach the stylesheet as variables, so the sheet
        // itself never has to be rebuilt.
        ["--sp-accent" as string]: accentColor,
        ["--sp-accent-soft" as string]: withAlpha(accentColor, 0.12),
        ["--sp-accent-line" as string]: withAlpha(accentColor, 0.38),
    } as React.CSSProperties

    function renderBody() {
        if (courses.status === "loading") {
            // Card-shaped skeletons rather than a spinner. The real count is not
            // known yet, so 6 fills a 3-column grid evenly without guessing high.
            return (
                <div className="sp-grid" style={gridStyle}>
                    {Array.from({ length: 6 }, (_, index) => (
                        <SkeletonCard key={index} />
                    ))}
                </div>
            )
        }

        if (courses.status === "error") {
            const status = courses.error?.status ?? 0
            return (
                <div className="sp-panel">
                    <h3 className="sp-panel-title">We couldn't load the courses</h3>
                    <p className="sp-panel-body">
                        {status >= 500 || status === 0
                            ? "The course service isn't responding right now. This usually clears up on a retry."
                            : "The course service couldn't find the catalogue just now. This usually clears up on a retry."}
                    </p>
                    <div className="sp-panel-actions">
                        <button type="button" className="sp-btn" onClick={loadCourses}>
                            Try again
                        </button>
                    </div>
                </div>
            )
        }

        // Nothing came back from the API at all.
        if (courses.items.length === 0) {
            return (
                <div className="sp-panel">
                    <h3 className="sp-panel-title">No courses yet</h3>
                    <p className="sp-panel-body">
                        The catalogue is empty at the moment. New courses are added regularly — check back soon.
                    </p>
                    <div className="sp-panel-actions">
                        <button type="button" className="sp-btn sp-btn-ghost" onClick={loadCourses}>
                            Refresh
                        </button>
                    </div>
                </div>
            )
        }

        // Courses exist, but the search matched none of them. A different problem
        // from the one above, so it gets different wording and a different fix.
        if (visibleCourses.length === 0) {
            return (
                <div className="sp-panel">
                    <h3 className="sp-panel-title">No matches for "{query.trim()}"</h3>
                    <p className="sp-panel-body">
                        Try a different course name, or search by category — "Marketing" or "Productivity", for example.
                    </p>
                    <div className="sp-panel-actions">
                        <button type="button" className="sp-btn sp-btn-ghost" onClick={() => setQuery("")}>
                            Clear search
                        </button>
                    </div>
                </div>
            )
        }

        return (
            <div className="sp-grid" style={gridStyle}>
                {visibleCourses.map((course) => (
                    <CourseCard key={course.courseCode} course={course} region={activeRegion} formatPrice={formatPrice} />
                ))}
            </div>
        )
    }

    return (
        <section ref={rootRef} className="sp-root" style={rootStyle} aria-label="Courses">
            <header className="sp-head">
                <h2 className="sp-title">{title}</h2>
                {subtitle && <p className="sp-subtitle">{subtitle}</p>}
            </header>

            {/* Courses loaded but the country lookup did not. The grid stays up —
                withholding it would punish the visitor for a failure in the less
                important of the two calls. Prices still show, because a catalogue
                without them is close to useless, but the guess is stated plainly
                and can be corrected here rather than silently presented as fact.
                Money is the one thing on this page worth being honest about. */}
            {courses.status === "ready" && regionIsAssumed && (
                <div className="sp-notice" role="status">
                    <p className="sp-notice-text">
                        We couldn't confirm your location, so prices are shown in{" "}
                        <strong>
                            {REGIONS[activeRegion].symbol} {REGIONS[activeRegion].currency}
                        </strong>{" "}
                        ({REGIONS[activeRegion].label}).
                    </p>
                    <div className="sp-notice-actions">
                        <button type="button" className="sp-btn sp-btn-ghost sp-btn-sm" onClick={loadRegion} disabled={region.status === "loading"}>
                            {region.status === "loading" ? "Checking…" : "Detect again"}
                        </button>
                        <button
                            type="button"
                            className="sp-btn sp-btn-ghost sp-btn-sm"
                            onClick={() => setManualRegion(activeRegion === "IN" ? "US" : "IN")}
                        >
                            Show in {activeRegion === "IN" ? "$ USD" : "₹ INR"}
                        </button>
                    </div>
                </div>
            )}

            {(showSearch || showSort) && courses.status === "ready" && courses.items.length > 0 && (
                <div className="sp-toolbar">
                    {showSearch && (
                        <div className="sp-search">
                            <span className="sp-search-icon">
                                <SearchIcon />
                            </span>
                            <label className="sp-sr" htmlFor="sp-search-input">
                                Search courses
                            </label>
                            {/* Not debounced, on purpose. This filters at most ten
                                items already in memory, so a delay would only add
                                lag to something that is already instant. */}
                            <input
                                id="sp-search-input"
                                className="sp-input"
                                type="search"
                                placeholder="Search courses or categories…"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </div>
                    )}
                    {showSort && (
                        <>
                            <label className="sp-sr" htmlFor="sp-sort-select">
                                Sort courses
                            </label>
                            <select
                                id="sp-sort-select"
                                className="sp-select"
                                value={sortMode}
                                onChange={(event) => setSortMode(event.target.value as SortMode)}
                            >
                                <option value="default">Featured</option>
                                <option value="price-asc">Price: low to high</option>
                                <option value="price-desc">Price: high to low</option>
                            </select>
                        </>
                    )}
                </div>
            )}

            {/* The count is announced because it genuinely varies between loads. */}
            {courses.status === "ready" && visibleCourses.length > 0 && (
                <p className="sp-count" role="status" aria-live="polite">
                    Showing {visibleCourses.length} {visibleCourses.length === 1 ? "course" : "courses"}
                </p>
            )}

            <div aria-busy={courses.status === "loading"}>{renderBody()}</div>
        </section>
    )
}

addPropertyControls(SkillpathCourses, {
    // The two that carry real weight:
    //
    // accentColor, because theming is the first thing a designer asks for and it
    // is the one thing they cannot reach from outside a code component — it
    // drives the pills, buttons, focus rings and card hover in one move.
    //
    // fallbackRegion, because it is a business decision rather than a technical
    // one. When the country lookup fails, somebody has to decide which currency
    // a stranger sees, and that answer depends on where the audience actually is.
    // It belongs to whoever owns the page, not to whoever wrote the component.
    accentColor: {
        type: ControlType.Color,
        title: "Accent",
        defaultValue: "#4F3CE8",
    },
    fallbackRegion: {
        type: ControlType.Enum,
        title: "Fallback Region",
        options: ["IN", "US"],
        optionTitles: ["India (₹)", "United States ($)"],
        defaultValue: "IN",
        description: "Currency to assume when the country lookup fails.",
    },
    title: {
        type: ControlType.String,
        title: "Heading",
        defaultValue: "Courses built to be finished",
    },
    subtitle: {
        type: ControlType.String,
        title: "Subheading",
        displayTextArea: true,
        defaultValue:
            "Practical, self-paced programmes taught by people who do the work. Live pricing, updated for your region.",
    },
    maxCourses: {
        type: ControlType.Number,
        title: "Max Cards",
        min: 0,
        max: 12,
        step: 1,
        displayStepper: true,
        defaultValue: 0,
        description: "0 shows every course the API returns.",
    },
    showSearch: {
        type: ControlType.Boolean,
        title: "Search",
        defaultValue: true,
    },
    showSort: {
        type: ControlType.Boolean,
        title: "Sort",
        defaultValue: true,
    },
})
