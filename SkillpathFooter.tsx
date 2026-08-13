import { useLayoutEffect, useEffect } from "react"
import { addPropertyControls, ControlType } from "framer"

/**
 * Skillpath — Footer.
 *
 * Three links and a copyright line, as asked. The year is read from the clock
 * rather than typed in, so the page does not quietly go stale in January.
 *
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 120
 */

const STYLE_ID = "skillpath-footer-styles"

const STYLES = `
.spf-root {
  --spf-ink: #12100E;
  --spf-muted: #6B6560;
  --spf-line: rgba(18, 16, 14, 0.10);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--spf-muted);
  width: 100%;
  box-sizing: border-box;
  border-top: 1px solid var(--spf-line);
  padding-top: 28px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px 32px;
  font-size: 14px;
}
.spf-root *, .spf-root *::before, .spf-root *::after { box-sizing: border-box; }

.spf-brand { font-weight: 650; color: var(--spf-ink); font-size: 15px; letter-spacing: -0.01em; }

.spf-links { display: flex; flex-wrap: wrap; gap: 8px 28px; list-style: none; margin: 0; padding: 0; }
.spf-link {
  color: var(--spf-muted); text-decoration: none;
  border-radius: 4px;
  transition: color 0.15s ease;
}
.spf-link:hover { color: var(--spf-ink); }
.spf-link:focus-visible { outline: 2px solid var(--spf-accent); outline-offset: 3px; color: var(--spf-ink); }

.spf-copy { margin: 0; }

/* Below ~600px the row stacks and centres rather than squeezing three links
   into a line that wraps mid-word. */
@media (max-width: 600px) {
  .spf-root { flex-direction: column; text-align: center; justify-content: center; }
  .spf-links { justify-content: center; }
}

@media (prefers-reduced-motion: reduce) {
  .spf-root * { transition: none !important; }
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

interface Props {
    brand?: string
    linkOneLabel?: string
    linkOneUrl?: string
    linkTwoLabel?: string
    linkTwoUrl?: string
    linkThreeLabel?: string
    linkThreeUrl?: string
    accentColor?: string
    style?: React.CSSProperties
}

// See the courses component: parameter defaults instead of defaultProps, which
// React 19 removes for function components.
export default function SkillpathFooter({
    brand = "Skillpath",
    linkOneLabel = "About",
    linkOneUrl = "#",
    linkTwoLabel = "Contact",
    linkTwoUrl = "#",
    linkThreeLabel = "Privacy",
    linkThreeUrl = "#",
    accentColor = "#4F3CE8",
    style,
}: Props) {
    useStyleSheet()

    // Built as an array so the markup is one map instead of three near-identical
    // blocks, and so an empty label simply drops its link.
    const links = [
        { label: linkOneLabel, url: linkOneUrl },
        { label: linkTwoLabel, url: linkTwoUrl },
        { label: linkThreeLabel, url: linkThreeUrl },
    ].filter((link) => link.label)

    const rootStyle = { ...style, ["--spf-accent" as string]: accentColor } as React.CSSProperties

    return (
        <footer className="spf-root" style={rootStyle}>
            <span className="spf-brand">{brand}</span>

            <nav aria-label="Footer">
                <ul className="spf-links">
                    {links.map((link) => (
                        <li key={link.label}>
                            <a className="spf-link" href={link.url || "#"}>
                                {link.label}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>

            <p className="spf-copy">
                © {new Date().getFullYear()} {brand}. All rights reserved.
            </p>
        </footer>
    )
}

addPropertyControls(SkillpathFooter, {
    accentColor: { type: ControlType.Color, title: "Accent", defaultValue: "#4F3CE8" },
    brand: { type: ControlType.String, title: "Brand", defaultValue: "Skillpath" },
    linkOneLabel: { type: ControlType.String, title: "Link 1", defaultValue: "About" },
    linkOneUrl: { type: ControlType.Link, title: "  ↳ URL" },
    linkTwoLabel: { type: ControlType.String, title: "Link 2", defaultValue: "Contact" },
    linkTwoUrl: { type: ControlType.Link, title: "  ↳ URL" },
    linkThreeLabel: { type: ControlType.String, title: "Link 3", defaultValue: "Privacy" },
    linkThreeUrl: { type: ControlType.Link, title: "  ↳ URL" },
})
