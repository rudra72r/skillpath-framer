import { useLayoutEffect, useEffect } from "react"
import { addPropertyControls, ControlType } from "framer"

/**
 * Skillpath — Hero.
 *
 * Headline, one supporting line, one button. The brief asks for exactly that,
 * so this stays deliberately small; the courses section is where the work is.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 520
 */

const STYLE_ID = "skillpath-hero-styles"

const STYLES = `
.sph-root {
  --sph-ink: #12100E;
  --sph-muted: #6B6560;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--sph-ink);
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 22px;
  -webkit-font-smoothing: antialiased;
}
.sph-root *, .sph-root *::before, .sph-root *::after { box-sizing: border-box; }

.sph-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--sph-accent); background: var(--sph-accent-soft);
  padding: 7px 14px; border-radius: 999px;
}
.sph-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* clamp() keeps the headline readable from 320px to 1600px with no breakpoints
   and nothing to break in between. */
.sph-headline {
  font-size: clamp(34px, 6vw, 68px);
  line-height: 1.04;
  letter-spacing: -0.035em;
  font-weight: 700;
  margin: 0;
  max-width: 18ch;
  text-wrap: balance;
}
.sph-sub {
  font-size: clamp(16px, 1.7vw, 19px);
  line-height: 1.55;
  color: var(--sph-muted);
  margin: 0;
  max-width: 54ch;
  text-wrap: pretty;
}

.sph-cta {
  font: inherit; font-size: 15.5px; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; gap: 9px;
  height: 52px; padding: 0 28px; border-radius: 12px; margin-top: 6px;
  border: 1px solid var(--sph-accent); background: var(--sph-accent); color: #fff;
  text-decoration: none;
  transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
  box-shadow: 0 10px 24px -10px var(--sph-accent-shadow);
}
.sph-cta:hover { transform: translateY(-2px); opacity: 0.94; }
.sph-cta:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--sph-accent-soft); }
.sph-arrow { transition: transform 0.16s ease; }
.sph-cta:hover .sph-arrow { transform: translateX(3px); }

@media (prefers-reduced-motion: reduce) {
  .sph-root *, .sph-root *::before, .sph-root *::after { transition: none !important; }
  .sph-cta:hover { transform: none; }
  .sph-cta:hover .sph-arrow { transform: none; }
}
`

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

function useStyleSheet() {
    useIsomorphicLayoutEffect(() => {
        if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return
        const tag = document.createElement("style")
        tag.id = STYLE_ID
        tag.textContent = STYLES
        document.head.appendChild(tag)
    }, [])
}

/** Shared with the courses component — see the note there on why not color-mix. */
function withAlpha(color: string, alpha: number): string {
    const value = color.trim()

    const hex = value.match(/^#([0-9a-f]{3,8})$/i)?.[1]
    if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
        const full = hex.length === 3 ? hex.replace(/./g, (char) => char + char) : hex
        const red = parseInt(full.slice(0, 2), 16)
        const green = parseInt(full.slice(2, 4), 16)
        const blue = parseInt(full.slice(4, 6), 16)
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

interface Props {
    eyebrow?: string
    headline?: string
    subheadline?: string
    buttonLabel?: string
    buttonLink?: string
    accentColor?: string
    style?: React.CSSProperties
}

// See the courses component: parameter defaults instead of defaultProps, which
// React 19 removes for function components.
export default function SkillpathHero({
    eyebrow = "Now enrolling",
    headline = "Learn the skill. Then actually use it.",
    subheadline = "Short, practical courses that end with something you have built — not a certificate you file away and forget.",
    buttonLabel = "Browse courses",
    buttonLink = "#courses",
    accentColor = "#4F3CE8",
    style,
}: Props) {
    useStyleSheet()

    const rootStyle = {
        ...style,
        ["--sph-accent" as string]: accentColor,
        ["--sph-accent-soft" as string]: withAlpha(accentColor, 0.12),
        ["--sph-accent-shadow" as string]: withAlpha(accentColor, 0.55),
    } as React.CSSProperties

    return (
        <section className="sph-root" style={rootStyle}>
            {eyebrow && (
                <span className="sph-eyebrow">
                    <span className="sph-dot" />
                    {eyebrow}
                </span>
            )}

            <h1 className="sph-headline">{headline}</h1>
            <p className="sph-sub">{subheadline}</p>

            {/* An anchor rather than a button: this navigates, so it should be
                middle-clickable and keyboard-navigable like any other link. */}
            <a className="sph-cta" href={buttonLink || "#courses"}>
                {buttonLabel}
                <svg className="sph-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
            </a>
        </section>
    )
}

addPropertyControls(SkillpathHero, {
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#4F3CE8" },
    eyebrow: { type: ControlType.String, title: "Eyebrow", defaultValue: "Now enrolling" },
    headline: {
        type: ControlType.String,
        title: "Headline",
        displayTextArea: true,
        defaultValue: "Learn the skill. Then actually use it.",
    },
    subheadline: {
        type: ControlType.String,
        title: "Subheadline",
        displayTextArea: true,
        defaultValue:
            "Short, practical courses that end with something you have built — not a certificate you file away and forget.",
    },
    buttonLabel: { type: ControlType.String, title: "Button", defaultValue: "Browse courses" },
    buttonLink: { type: ControlType.Link, title: "Button Link" },
})
