# The note

200 words, as asked.

---

**What I'd fix with two more days**

The manual currency override does not survive a reload. I would also pull the
retry and backoff logic into its own module — it is the most reusable part here
and it currently sits inside the component file.

**Where I got stuck**

What to show when the country call fails but the courses load. Blocking the grid
punishes the visitor for the less important failure. Silently picking a currency
shows someone a price that may be wrong. I went with rendering the prices,
labelling the guess, and letting the visitor correct it — the default being a
property control, since which currency a stranger sees is a business call.

**What I'm not happy with**

886 lines in one file. And the currency notice shipped with a bug caught late:
choosing the manual override removed the notice, stranding you in that currency
with no way back.

**AI**

Both chats linked on the submission form. I worked the problem out in ChatGPT
first — minor units, why two independent calls should not share a `Promise.all`,
what a CORS preflight costs on an API that already fails a third of the time.
Claude then wrote the implementation against those decisions. I directed and
reviewed rather than typed, and the API was measured before the retry count was
picked.

---

*197 words.*
