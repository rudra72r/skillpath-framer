# Skillpath — Framer code components

[![Tests](https://github.com/rudra72r/skillpath-framer/actions/workflows/test.yml/badge.svg)](https://github.com/rudra72r/skillpath-framer/actions/workflows/test.yml)

### ▸ [Open the live demo](https://rudra72r.github.io/skillpath-framer/)

Same component the Framer page runs, with a bar across the top that forces each
failure state on demand — slow network, courses failing, **country failing while
courses succeed**, both failing, empty catalogue — instead of waiting for the API's
35% failure rate to produce one.

---

A landing page for a fictional learning platform. The courses section pulls live
data from a deliberately unreliable API; the hero and footer are the frame around it.

| File | What it is |
| --- | --- |
| `SkillpathCourses.tsx` | The courses section. This is the real work. |
| `SkillpathHero.tsx` | Headline, one supporting line, one button. |
| `SkillpathFooter.tsx` | Three links and a copyright line. |
| `verify.mjs` | 37 assertions on price math and response parsing. |
| `render-test.mjs` | 71 assertions on rendering, every state, and interaction. |
| `build-preview.mjs` | Generates `docs/index.html` — the live demo — from the components. |

---

## Installing into Framer

For each of the three files:

1. In your Framer project, open the **Assets** panel on the left.
2. Go to the **Code** tab → **+** → **New Code File**.
3. Name it (e.g. `SkillpathCourses`), delete the boilerplate, paste the file contents, save.
4. Drag the component from the Code tab onto the canvas.

Then set the layer sizing:

- **Width:** Fill
- **Height:** Fit

The components deliberately do **not** add their own outer padding or max-width.
That is Framer's job — a code component that hardcodes its own page margins fights
the layout system and cannot be reused at a different width. Put each one inside a
frame and set the padding there. For the page in the preview:

- Page frame: max width `1240`, centred
- Section padding: `56px` horizontal on desktop, `20px` on mobile

The API is public and needs no key, so the components work as soon as they are pasted.

---

## The courses section

### Two endpoints, two independent lifecycles

`/assignment/course-data` and `/assignment/country-code` are fetched at the same
time but never share a fate. `Promise.all` would have been shorter and wrong: it
rejects on the first failure, so a failed country lookup would take down a course
list that had arrived perfectly well.

They also retry and recover independently — the "Detect again" button on the
currency notice re-runs only the country call.

### What happens when the country call fails but the courses load

This is the case the brief singles out, and the reasoning behind the answer:

- **The grid stays up.** Withholding the courses would punish the visitor for a
  failure in the less important of the two calls.
- **Prices still show.** A course catalogue with the prices removed is close to
  useless, and blanking them is a worse failure than guessing.
- **The guess is stated, not hidden.** A price is a number a person may act on.
  Silently rendering ₹ to someone in Ohio — with no indication it was a guess — is
  the version of this I would not want to defend. So the section says which
  currency it fell back to and why.
- **The visitor can correct it.** The notice offers both a retry and a manual
  currency switch, so someone who knows where they are is not stuck waiting on an
  endpoint that may keep failing.

The default guess is a property control, because "which currency does a stranger
see" is a business decision about where the audience actually is, not a technical
one. It belongs to whoever owns the page.

### Retries

Measured over 60 calls while building this: **65% succeeded, 35% failed** (15×500,
6×404) — matching the ~1-in-3 the brief describes.

At p(fail) = 0.35, four attempts leave a **1.5%** chance the visitor ever sees the
error state, against **4.3%** for three. Across five page loads that is the
difference between hitting an error 7% of the time and 20% of the time. Attempts
stop at four because the failures arrive in bursts rather than evenly spaced, so a
fifth buys much less than the curve suggests, and every extra attempt is time
someone spends watching skeletons. The remainder goes to the Retry button, which
keeps a genuinely dead API failing fast instead of hanging the section for a minute.

Backoff is exponential with full jitter. The jitter matters because both endpoints
are called at once — without it their retries stay in lockstep and hit an already
struggling server in bursts.

**404 is retried, 405 is not.** A 404 is normally permanent and retrying it is
pointless, but this API injects synthetic 404s, so here it is transient. A 405
would mean the component sent a verb this API refuses — a bug in this file, not a
flake — and retrying would only repeat it. Only GET is ever sent.

### No custom headers, on purpose

Adding even one request header would make this a non-simple CORS request and put a
preflight `OPTIONS` in front of every call. When one request in three already
fails, doubling the number of requests is the wrong trade for headers that are not
needed.

### Responsive: 3 / 2 / 1

Column count comes from a `ResizeObserver` on the component's own element, not from
a viewport media query. A code component can be dropped into a narrow container on
a wide screen, and a viewport query would confidently render three columns into a
320px box. Measuring the container is the only thing that is actually true.

The grid uses `repeat(n, minmax(0, 1fr))` — `minmax(0, 1fr)` rather than plain
`1fr`, because a long unbroken string in a grid child otherwise forces its column
past its share and blows out the row.

Because the column count is explicit, a ragged final row (5, 7, or 9 courses) keeps
its cards at normal width instead of stretching one card across the grid. Cards are
flex columns with the price pinned by `margin-top: auto`, so prices line up across a
row regardless of how tall the text above them is.

### The extra field

`mainCategory`. Of everything the API returns it is the only field that helps a
learner answer "is this for me?" — `courseCode` and `mangoId` are internal
identifiers, and `shortCourse` just repeats the name. It is also matched by the
search box, so it does real work rather than sitting on the card as decoration.

`refundable` appears as a badge only when true, and `courseType` sits next to the
price as format information.

### Price

Both prices arrive in minor units. `199900` paise is **₹1,999**, not ₹1,99,900;
`3999` cents is **$39.99**. Dividing by 100 is the whole trick and `Intl.NumberFormat`
handles the rest, including Indian lakh grouping.

Decimals follow the value rather than the region: a price that is a whole number of
rupees or dollars drops the `.00`. In this catalogue that renders ₹1,999 and $39.99,
which is what each market expects — but a ₹1,999.50 would still be correct.

Formatters are built once per region, not once per card. Constructing an
`Intl.NumberFormat` is expensive and a ten-card grid would otherwise build ten of
them every render.

### Property controls

Seven, and the two that carry the most weight are the first two:

| Control | Why |
| --- | --- |
| **Accent** | Theming is the first thing a designer asks for, and it is the one thing they cannot reach from outside a code component. One colour drives the pills, buttons, focus rings and card hover. |
| **Fallback Region** | The business decision above — which currency a stranger sees when detection fails. |
| Heading / Subheading | Copy, without opening the code. |
| Max Cards | Density. `0` shows everything the API returns. |
| Search / Sort | Toggle the two optional controls. |

Values reach the stylesheet as CSS custom properties on the instance root, so the
sheet itself stays static and two instances can carry different accents.

### Extras

Search (name and category), sort by price, skeleton loaders, a retry button, and a
conditional refundable badge.

Search is **not** debounced. It filters at most ten items already in memory, so a
delay would only add lag to something that is already instant.

Sort uses the currency currently on screen. The paise and cents values are not
perfectly proportional, so sorting by one while displaying the other could put the
cards in an order that looks wrong.

---

## Running it locally

```bash
npm install
npm run preview   # writes docs/index.html — open it directly, no server needed
npm run verify    # 37 assertions: price math, parsing, retry policy
npm test          # 71 assertions: rendering, all states, interaction
```

`docs/index.html` is generated from the component files, so there is no second copy
of the logic to drift out of sync. It is the same file GitHub Pages serves as the
live demo.

It includes a harness that wraps `fetch` to force each state on demand — slow
network, courses failing, **country failing while courses succeed**, both failing,
and an empty catalogue — instead of waiting for the API's 35% failure rate to
produce one. That interception lives only in the harness; the components know
nothing about it.

## Tests

`verify.mjs` compiles the real component and exercises its actual functions — there
is no reimplementation to fall out of step. It covers the price math the brief calls
out as an instant fail, malformed and non-array payloads, the retry policy, and then
formats every price from a live API response.

`render-test.mjs` mounts the component in jsdom and checks that it server-renders
without throwing (Framer pre-renders published pages), moves correctly through all
four states, discloses an assumed currency, recovers on retry, filters and sorts,
survives a malformed payload, and never leaves a raw error string or a blank box on
screen.

One bug these caught: keying the currency notice off `status === "error"` made it
vanish the moment someone pressed "Detect again", and — worse — choosing the manual
currency override removed the notice entirely, stranding the visitor in a currency
they could not switch back from. Fixed by tracking whether a lookup has *finished*
separately from whether one is *in flight*. Test 13 guards it.

## Known limitations

- Prices are formatted for display only. A real checkout would confirm currency
  server-side rather than trusting a client-side geo lookup.
- The manual currency override lasts for the page visit. Persisting it would need a
  storage decision that belongs to the product, not the component.
- `preview.html` loads React from a CDN, so it needs a network connection. The
  Framer components themselves have no dependencies beyond React and `framer`.
