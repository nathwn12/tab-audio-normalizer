# RESEARCH: MV3 state, storage and messaging — what the platform actually guarantees

Primary-source technical reference for the shared-state design of this extension (MV3, Chromium/Brave
only): a popup, a service worker, and content scripts injected into **all frames**, sharing per-site
settings through `chrome.storage.local`.

**Scope rule for this document.** Every claim carries a URL and the sentence that carries it, quoted
verbatim. Claims are tagged by kind:

- **[normative]** — stated by the official Chrome extension documentation, the API/schema reference,
  MDN, or the Chromium JSON schema. This is the contract.
- **[empirical]** — an observed behaviour reported by a source (none are used as authority here).
- **[reading]** — my own interpretation of quoted text. Never a substitute for a normative statement.

Where the documentation is silent I write **"the documentation does not state this"** and stop. No
inference is dressed as documentation. No fix is proposed: only platform facts and, where the docs give
a recommendation, that recommendation.

**Wiki check (done first).** `scripts\wiki.ps1 query` on `chrome extension storage`, `service worker`,
`MV3` and `extension` returned no answer to any of the questions below. The only hits were unrelated
(`browser-mcp-owned-chromium`, `harness-formatter-trap`, `harness-lessons`, two aside pages). Nothing
here was reused from the wiki.

**No browser was launched.** This is desk research only, per the repo's Audio Safety rule.

**Method.** All pages fetched live on 2026-10-18. Each Chrome page states its own "Last updated" date,
recorded in the source list (§9). Nothing is quoted from memory.

---

## 0. Answers at a glance

| # | Question | Short answer | Bugs |
|---|----------|--------------|------|
| 1 | Service worker lifetime | Terminated after 30 s idle (or a >5 min request, or a >30 s `fetch`); "Normally"; revoked by an incoming event; durable state must go to storage, not globals. | 2 |
| 2 | `chrome.storage` concurrency / atomicity | No transaction, no documented cross-key atomicity, no documented ordering between concurrent read-modify-write sequences from different contexts. | 2, 4, 5 |
| 3 | Write/read ordering & `onChanged` | Docs silent on same-context `set` ordering, on `onChanged` ordering, and on whether an awaited `set` then `get` sees the write. | 3, 4 |
| 4 | `chrome.storage.session` | Exists in MV3 (Chrome 102+), in-memory, 10 MB, cleared on extension reload/disable/update and browser restart. The docs recommend it for service workers, but never discuss counters. | 2, 4 |
| 5 | Messaging to frames | With no `frameId`, the message goes to **all frames**; each frame's `onMessage` fires; if several respond, the sender gets **one of the answers** (Chrome docs do not say which). `frameId: 0` targets the top frame; `webNavigation.getAllFrames` enumerates frames. | 1 |
| 6 | Popup lifecycle | The popup document is loaded when shown and **unloaded when closed**; no documented teardown/flush facility; docs say async work during SW teardown is not guaranteed to complete. | 3 |
| 7 | Official guidance for this shape | The docs' recommended pattern is: persist to storage (not globals) and propagate across contexts with `storage.onChanged`. No official sample documents per-site settings across popup + SW + content scripts, and none documents whole-map-clobber avoidance. | 4, 5 |

---

## 1. Service worker lifetime in MV3

**Primary source:** *The extension service worker lifecycle* —
<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle> (page
"Last updated 2023-05-02"), supported by *About extension service workers* —
<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers> (Last updated
2023-05-03).

**How long may an idle worker live before termination?** 30 seconds idle. Verbatim **[normative]**:

> "Normally, Chrome terminates a service worker when one of the following conditions is met:
> - After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer.
> - When a single request, such as an event or API call, takes longer than 5 minutes to process.
> - When a `fetch()` response takes more than 30 seconds to arrive."

**Is termination guaranteed?** The page says "**Normally**", not "always", and then instructs the
developer to assume it can happen at any time **[normative]**:

> "Events and calls to extension APIs reset these timers, and if the service worker has gone dormant, an
> incoming event will revive them. Nevertheless, you should design your service worker to be resilient
> against unexpected termination."

And on the introduction page **[normative]**:

> "An extension service worker is loaded when it is needed, and unloaded when it goes dormant. Once
> loaded, an extension service worker generally runs as long as it is actively receiving events, though
> it [can shut down]."

So: the docs treat termination as the normal case and require resilience to it, but do not phrase it as
an unconditional guarantee of a fixed 30 s wall. **[reading]** The practical contract is "assume lost,
without notice".

**The documented event-based revival model [normative]:** events are dispatched to the worker by the
browser, and events *are* what revive a dormant worker — "if the service worker has gone dormant, an
incoming event will revive them." The *Events in service workers* page adds the registration rule —
<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events>:

> "Event handlers in service workers need to be declared in the global scope, meaning they should be at
> the top level of the script and not be nested inside functions. This ensures that they are registered
> synchronously on initial script execution, which enables Chrome to dispatch events to the service
> worker as soon as it starts."

**Where must durable state live? [normative]** — verbatim from the lifecycle page, section "Persist data
rather than using global variables":

> "Any global variables you set will be lost if the service worker shuts down. Instead of using global
> variables, save values to storage."

> "**Note:** The Web Storage API is not available for extension service workers."

The page then lists the storage options: `browser.storage` ("An extension API that offers multiple types
of storage; local, session, managed (domain), and sync… This type of storage isn't removed when a user
clears the web cache."), IndexedDB ("This API provides primitives for creating transactional data
storage and retrieval."), and CacheStorage.

**Bears on the bugs.** Directly on **bug 2**: a per-site sequence counter held in an in-memory `Map` in
the service worker is exactly the "global variables … will be lost if the service worker shuts down"
case. It also touches **bug 4**, because any durable marker the design relies on must survive the same
shutdown. It does **not** by itself answer whether the counter should be in `storage.local`,
`storage.session`, or elsewhere (§4).

---

## 2. `chrome.storage` concurrency and atomicity

**Primary sources:** *browser.storage* —
<https://developer.chrome.com/docs/extensions/reference/api/storage> (page Last updated 2026-09-11);
*StorageArea* — <https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea>
(Last updated 2026-09-11); the surface and wording originate in the Chromium API schema —
<https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/storage.json>.

### 2.1 What the API is

**[normative]** The Storage API overview page, "Concepts and usage":

> "The Storage API is asynchronous with bulk read and write operations."

`StorageArea.set` **[normative]**, verbatim (also verbatim in the Chromium schema):

> "Sets multiple items."

> "An object which gives each key/value pair to update storage with. **Any other key/value pairs in
> storage will not be affected.** Primitive values such as numbers will serialize as expected. Values
> with a `typeof` `"object"` and `"function"` will typically serialize to `{}`, with the exception of
> `Array` (serializes as expected), `Date`, and `Regex` (serialize using their `String`
> representation)."

**[reading]** "Any other key/value pairs in storage will not be affected" is a statement about the
*top-level keys of the storage area*: `set({a:1})` leaves key `b` alone. It is **not** a claim that a
nested object value is deep-merged — passing `set({ siteSettings: <whole map> })` replaces the entire
`siteSettings` value with the map you passed. The docs do not describe nested-merge behaviour at all.

### 2.2 Transaction / atomicity across keys — the docs are silent; the API has none

There is **no** transaction, batch, compare-and-swap, version, or "conditional set" method anywhere in
the API. The complete `StorageArea` method surface, per the Chromium schema and the `StorageArea`
reference page, is:

`get()`, `getKeys()`, `getBytesInUse()`, `set()`, `remove()`, `clear()`, `setAccessLevel()` — plus the
`onChanged` event.

**The documentation does not state** that `chrome.storage.local.set` is atomic across multiple keys,
nor that two concurrent read-modify-write sequences issued by different contexts are serialized or
isolated. Neither the overview page, the `StorageArea` page, nor the Chromium schema contains the words
"atomic", "transaction", or "isolation". **[reading]** The absence is structural, not a documentation
gap: the checked `StorageArea` surface is `get`, `getKeys`, `getBytesInUse`, `set`, `remove`, `clear`,
`setAccessLevel`, plus the `onChanged` event (Chromium schema `storage.json` and the `StorageArea`
reference page, §2.1), and the schema describes none of those entries as providing a transaction,
compare-and-swap, or version, so the checked surface offers the caller nothing with which to express one.

**The documented pattern for avoiding lost updates:** **the documentation does not state one.** The
overview page's two worked examples are the closest it comes, and neither addresses concurrent writers:

- "Respond to storage updates": an options page writes a value and the service worker reacts via
  `onChanged`. Verbatim excerpt (comments are from the docs):

  > "options.js: … `optionsForm.debug.addEventListener("change", (event) => { options.debug = event.target.checked; browser.storage.sync.set({ options }); });`"

  > "background.js: `// Watch for changes to the user's options & apply them` `browser.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && changes.options?.newValue) { … } });`"

  > "The options page immediately saves the new settings to `storage.sync`, and the service worker uses
  `storage.onChanged` to apply the setting as soon as possible."

- "Asynchronous preload from storage": the service worker caches storage into a global, then writes it
  back. Verbatim:

  > "Because service workers don't run all the time, Manifest V3 extensions sometimes need to
  > asynchronously load data from storage before they execute their event handlers."

  > "`storageCache.count++; storageCache.lastTabId = tab.id; browser.storage.sync.set(storageCache);`"

  **[reading]** This example itself is a read-modify-write of the cached object with no guard; it is
  illustrative of *how to wait for storage before handling events*, not a lost-update pattern.

**Bears on the bugs.** Bugs **2, 4 and 5** all rest on a concurrency contract that **does not exist**:
no in-API transaction (§2.2), no documented ordering across concurrent writers (§3), and a `set` whose
only documented granularity is the top-level key. Any design that assumes a read-then-write pair is
isolated, or that two writes land in a defined order, is assuming something the docs never state.

---

## 3. Write/read ordering and the `onChanged` event

**Primary sources:** *browser.storage* and *StorageArea* (URLs in §2); *Events in service workers* —
<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events>.

- **Are `set` calls from the same context executed in order?** **The documentation does not state
  this.** No page, and not the Chromium schema, describes the ordering in which two `set` calls from the
  same context are applied.

- **Is `onChanged` delivered in order?** **The documentation does not state this.** The only wording is
  **[normative]**:

  > "Fired when one or more items change." (both the overview page and `StorageArea.onChanged`)

  and on the events page:

  > "Fired whenever any `StorageArea` object is cleared or when the value of a key is changed or set.
  > Note that the each `StorageArea` instance has its own `onChanged` event."

  Nothing about ordering, batching, coalescing, or whether two changes may be merged into one event.

- **Does a `get` issued immediately after an awaited `set` always observe it?** **The documentation
  does not state this.** The overview page's own examples *show* the pattern —

  > "`await browser.storage.local.set({ key: value }); … const result = await browser.storage.local.get(["key"]);`"

  — but an example is not a stated guarantee. There is no normative sentence saying a subsequent read is
  guaranteed to observe a preceding write, from either the same or another context.

**The two `onChanged` shapes [normative].** The whole-area event
(`chrome.storage.onChanged`) delivers `(changes, areaName)`; the per-area event
(`StorageArea.onChanged`, Chrome 73+) delivers `(changes)` only. The `StorageChange` object carries
`oldValue` and `newValue` (both optional). This is the documented channel by which one context learns
another context wrote.

**Bears on the bugs.** **Bug 3** (a queued write whose timer fires after the popup closes; a two-step
"reset") and **bug 4** (settings, mirror and marker written separately, or read back immediately) both
depend on ordering that the docs do not provide. Because there is no documented ordering guarantee and
no transaction, the docs do not let a design infer that a marker written after a value will be observed
after it, or that a read-back sees a just-issued write.

---

## 4. `chrome.storage.session`

**Primary sources:** *browser.storage* (§2) and *StorageArea* (§2); the Chromium schema
`storage.json` (§2).

**Does it exist in MV3? [normative]** Yes. The overview page marks it "Chrome 102+ MV3+", and the
`session` property is typed as a `StorageArea`.

**What is it for? [normative]** Verbatim (overview page, "Session"):

> "Session storage holds data in memory while an extension is loaded. The storage is cleared if the
> extension is disabled, reloaded, updated, and when the browser restarts. By default, it's not exposed
> to content scripts, but this behavior can be changed by calling
> `browser.storage.session.setAccessLevel()`. The storage limit is 10 MB (1 MB in Chrome 111 and
> earlier)."

> "The `storage.session` interface is one of several [we recommend for service workers]."

And, verbatim from the `session` property:

> "Items in the `session` storage area are stored in-memory and will not be persisted to disk."

**Documented quota [normative]:** `QUOTA_BYTES = 10485760` (10 MB), "measured by estimating the
dynamically allocated memory usage of every value and key" — i.e. not the JSON-string length used for
`local`. Also **[normative]** from `setAccessLevel`: "By default, `session` storage is restricted to
trusted contexts (extension pages and service workers), while `managed`, `local`, and `sync` storage
allow access from both trusted and untrusted contexts."

**Is it persisted across a worker restart within one browser session?** **The documentation does not
state this explicitly.** The docs list exactly four clearing conditions — extension disabled, reloaded,
updated, browser restarted — and a service-worker restart is none of them. **[reading]** By the letter
of that list, session storage survives a service-worker shutdown (same extension load, same browser
session), which is the property that makes it useful for a worker that gets terminated and revived.
This reading is not backed by a sentence that says "session storage survives service worker
termination", so treat it as inference, not contract.

**Is it the right home for a sequence counter?** **The documentation does not state this.** The docs
never discuss sequence counters, monotonicity, or ordering tokens. The only documented guidance about
session storage is the clearing list, the quota, the default access level, and that it is "one of
several we recommend for service workers" (§, quoted above). Whether a counter belongs there is a
library-design decision the docs do not answer.

**Bears on the bugs.** **Bug 2** (a counter that is lost on worker restart and collides between two
popups) is exactly the class of state session storage is documented to hold in memory across a worker's
life, and exactly the class the docs deliberately do **not** claim survives a browser restart or an
extension reload. **Bug 4**'s reconcile marker is a related question — the docs give no guidance that a
marker belongs in session rather than local, or vice versa; note only that session storage is **not**
persisted to disk and is **not** visible to content scripts by default (which is a real constraint for a
marker that the content script must observe).

---

## 5. Messaging to frames

**Primary sources:** *browser.tabs* (the `sendMessage`/`connect` reference) —
<https://developer.chrome.com/docs/extensions/reference/api/tabs>; *Message passing* —
<https://developer.chrome.com/docs/extensions/develop/concepts/messaging> (Last updated 2025-12-03);
*browser.webNavigation* — <https://developer.chrome.com/docs/extensions/reference/api/webNavigation>
(Last updated 2026-10-04); *browser.runtime* —
<https://developer.chrome.com/docs/extensions/reference/api/runtime>; MDN *tabs.sendMessage()* —
<https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/sendMessage> (Chrome
`tabs.json`-derived); MDN *webNavigation.getAllFrames()*.

### 5.1 What `chrome.tabs.sendMessage(tabId, msg)` does with no `frameId`

Verbatim from the `tabs.sendMessage` reference **[normative]**:

> "Sends a single message to the content script(s) in the specified tab. The `runtime.onMessage` event
> is fired in **each content script running in the specified tab** for the current extension."

The `frameId` option is documented as the narrowing control **[normative]**:

> "`frameId` … Send a message to a specific frame identified by `frameId` **instead of all frames in the
> tab**."

> "`documentId` … Chrome 106+ … Send a message to a specific document identified by `documentId` instead
> of all frames in the tab."

**[reading]** The default (no `frameId`) is therefore: deliver to **every frame in the tab that the
extension has a content script in**, and fire `onMessage` in each. That is the mechanism behind bug 1 —
an embedded cross-origin iframe is one of those frames, and it answers.

`runtime.sendMessage` is documented similarly for its own direction **[normative]**: "If sending to
your extension, the `runtime.onMessage` event will be fired in every frame of your extension (except for
the sender's frame)".

### 5.2 How responses are arbitrated when more than one frame listens

- **Chrome's own docs:** the `tabs.sendMessage` return value is described only as **[normative]**:

  > "Promise<any> … Chrome 99+ … Promise that resolves with the response from the content script. If an
  > error occurs while connecting to the specified tab, the promise will be rejected."

  **The Chrome documentation does not state which frame's response the sender receives when several
  frames respond.** It does not state that the response is the first, the last, the top frame's, or
  frame 0's.

- **MDN** (the WebExtensions documentation derived from Chromium's `tabs.json`) states the limit
  explicitly **[normative for the WebExtensions API]**:

  > "If several frames respond to the message, the promise is resolved to **one of answers**."

  > "A `Promise` that will be fulfilled with the response object sent by the handler of the message in
  > the content script, or with no arguments if the content script did not send a response."

  "one of answers" is precisely the point: the docs guarantee *a* response, not *whose*.

- **Within one context**, the arbitration is documented: **[normative]** from *Message passing*, "Error
  handling":

  > "If multiple listeners are registered for `onMessage`, only the first listener to respond, reject,
  > or throw an error will affect the sender; all other listeners will run, but their results will be
  > ignored."

  Note this governs multiple *listeners*, not multiple *frames*; it is the closest normative rule and it
  still does not name a winning frame. The same page also documents the async-listener trap that turns
  an accidental `undefined` into `null` for the sender ("If an `async` listener does not return a value
  its promise implicitly resolves to `undefined`, and `null` is sent as the response to the sender.").

- **Does the sender learn which frame answered?** **The documentation does not state that it does.**
  The *receiver* of a message gets a `runtime.MessageSender` with frame identity — **[normative]**:
  "`frameId` … The frame that opened the connection. 0 for top-level frames, positive for child frames.
  This will only be set when `tab` is set." and "`url` … The URL of the page or frame that opened the
  connection. **If the sender is in an iframe, it will be iframe's URL not the URL of the page which
  hosts it.**" The popup that *sent* `tabs.sendMessage` receives only the response payload; the docs do
  not describe any field identifying the responding frame.

### 5.3 Targeting the top frame and enumerating frames

**Frame id of the top frame is 0** — from *browser.webNavigation*, "Frame IDs" **[normative]**:

> "Frames within a tab can be identified by a frame ID. **The frame ID of the main frame is always 0**,
> the ID of child frames is a positive number. Once a document is constructed in a frame, its frame ID
> remains constant during the lifetime of the document. As of Chrome 49, this ID is also constant for
> the lifetime of the frame (across multiple navigations)."

So the top frame is targeted with `chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })`, and a specific
document with `{ documentId }` (Chrome 106+).

**Enumerating frames** — `chrome.webNavigation.getAllFrames(details)` **[normative]**: "Retrieves
information about all frames of a given tab." Requires the `"webNavigation"` permission: "All
`browser.webNavigation` methods and events require you to declare the `"webNavigation"` permission in
the extension manifest." The Chrome reference types the result as `Promise<object[] | undefined>`; MDN
(schema-derived) lists the per-frame fields **[normative for the WebExtensions API]**: `errorOccurred`,
`url`, `frameId` ("If this is the main frame, then `frameId` is zero"), `frameType`
(`"outermost_frame"`, `"fenced_frame"`, `"sub_frame"`), `parentFrameId` ("This is -1 if there is no
parent frame…"), `documentId` (UUID of the frame's document), `parentDocumentId`, `documentLifecycle`
(`"prerender"`, `"active"`, `"cached"`, `"pending_deletion"`). MDN adds: "If the tab is discarded, the
promise will instead resolve with a `null` value."

A long-lived connection has the same targeting control — `chrome.tabs.connect(tabId, connectInfo)`:
**[normative]** "`frameId` … Open a port to a specific frame identified by `frameId` instead of all
frames in the tab." and "`documentId` … Chrome 106+ … Open a port to a specific document identified by
`documentId` instead of all frames in the tab." And *Message passing* notes the fan-out: "If there are
multiple frames in a tab, calling `tabs.connect()` invokes the `runtime.onConnect` event **once for each
frame in the tab**."

**Bears on the bugs.** Directly on **bug 1**. The platform fact is that the untargeted call reaches
every frame, that each frame answers independently, and that the sender is handed one arbitrary answer
with no documented way to tell which frame produced it. `frameId: 0` is the documented way to address
the top frame; `webNavigation.getAllFrames` is the documented way to enumerate frames when a caller
needs to know which frames exist.

---

## 6. Popup lifecycle

**Primary sources:** *Add a popup* —
<https://developer.chrome.com/docs/extensions/develop/ui/add-popup> (Last updated 2023-12-12); *browser.runtime*
(the `onSuspend` event and its caveat) — <https://developer.chrome.com/docs/extensions/reference/api/runtime>;
MDN *Popups* — <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups>
(Last updated 2025-07-17).

**When is the popup document destroyed?** "Unloaded every time the popup is closed" **[normative]**
(MDN, Popups):

> "The popup's **document is loaded every time the popup is shown, and unloaded every time the popup is
> closed**."

Chrome's own page states the closing trigger **[normative]** (Add a popup) — paraphrase, not a
verbatim quotation, of that page's closing paragraph: the page documents that a popup closes
automatically when the user focuses on some portion of the browser outside of the popup, and describes
that closing as the expected result once the user has clicked away.

**[reading]** Together these say the popup's JavaScript runs in a document whose lifetime is exactly the
popup's visible lifetime; closing it ends that document.

**Is asynchronous work after the popup closes reliable?** **The documentation does not state this** for
the popup. The nearest normative statement about asynchronous work across a teardown is about the
worker, not the popup, and it is cautionary **[normative]** (`runtime.onSuspend`):

> "Sent to the event page just before it is unloaded. This gives the extension opportunity to do some
> clean up. **Note that since the page is unloading, any asynchronous operations started while handling
> this event are not guaranteed to complete.** If more activity for the event page occurs before it gets
> unloaded the `onSuspendCanceled` event will be sent and the page won't be unloaded."

**[reading]** The docs establish a general principle — asynchronous work started during teardown is not
guaranteed to complete — but they state it for the event page, not the popup. Whether a write the popup
dispatched just before closing lands is **not** documented either way. The bug-3 scenario (a debounced
save's timer fires, queues a write, and the popup document closes before the write is delivered) is
governed by silence, and the only normative instruction in the neighbourhood is the worker's: persist
state to storage rather than relying on in-memory scheduling.

**Where should state a popup must not lose live? [normative]** The lifecycle page's rule and the
storage page's recommendations apply verbatim: "Instead of using global variables, save values to
storage" (§1), and **[normative]** from the storage overview: "We recommend using `storage.sync` to
preserve user settings across synced browsers." / "We recommend using `storage.local` to store larger
amounts of data."

**Is there any documented flush-on-teardown facility?** **The documentation does not state one.** There
is no documented popup "unloaded", "beforeunload" or "onClosed"-equivalent extension event, and no
documented flush call. The only teardown-adjacent extension event in the docs is `runtime.onSuspend`
(quoted above), which is described as "Sent to the event page", explicitly warns that async work may not
complete, and appears on the worker's event surface — **the documentation does not state** whether
`onSuspend` fires for an MV3 extension service worker at all, nor for a popup.

**Bears on the bugs.** Directly on **bug 3**: the popup's document ends with the popup, no documented
teardown hook exists to flush pending work, and the docs' only instruction is to keep durable state in
storage rather than in globals or in scheduled in-memory work.

---

## 7. Official guidance for this exact shape

**Question.** Does any official Chrome sample or doc describe per-site settings shared between a popup,
a service worker, and content scripts — including how to avoid whole-map clobber and how to keep popup
and content script consistent?

**Findings.**

1. **No official sample covers this shape.** The Chrome samples index —
   <https://developer.chrome.com/docs/extensions/samples> — lists samples tagged `storage.local`,
   `storage.onChanged`, `storage.session`, `storage.sync`, `tabs.sendMessage`, and `webNavigation`. The
   only sample described as demonstrating the Storage API is **`api-samples/storage/stylizr`**
   (<https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/storage/stylizr>),
   whose README says **[normative for the sample]**:

   > "In this sample, the `chrome.storage` API stores a custom style string that will be applied to the
   > active page when the extension's action icon is clicked."

   Its files are `manifest.json`, `popup.html`, `popup.js`, `options.html`, `options.js`. It stores a
   single style string, is **not** per-site, and is **not** a popup + worker + all-frames content-script
   design. There is no `functional-samples` or `api-samples` entry for per-site settings
   (<https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples> lists none
   matching this shape).

2. **The documented pattern that does exist** is the storage overview's "Respond to storage updates"
   example (§2.2) — the closest thing to official guidance for keeping contexts consistent
   **[normative]**: one context writes to storage, and "the service worker uses `storage.onChanged` to
   apply the setting as soon as possible." It demonstrates change propagation, **not** clobber
   avoidance: the write in that example is a whole-object write (`browser.storage.sync.set({ options })`)
   with no merge guard.

3. **No doc documents whole-map clobber avoidance.** The words for a guard — transaction, compare-and-
   swap, version, merge — **do not appear** in the storage overview, the `StorageArea` reference, or the
   Chromium `storage.json` schema. **The documentation does not state** how to avoid one writer
   replacing a whole settings map out from under another writer. This is the gap behind bugs **4** and
   **5**.

4. **Content-script exposure is documented, and is a relevant constraint [normative]**: from the
   storage overview, `local` is "By default … exposed to content scripts, but this behavior can be
   changed by calling `browser.storage.local.setAccessLevel()`", whereas `session` is "By default …
   not exposed to content scripts". So the popup/worker-facing and all-frames-content-script-facing
   areas do not share the same default access level.

**Bears on the bugs.** Bugs **4 and 5**: the official docs supply a change-propagation pattern
(`onChanged`) and a persistence rule (don't use globals), and nothing more — no transaction, no
per-site schema, no clobber-avoidance pattern, and no sample of the popup + worker + all-frames shape.

---

## 8. Explicitly NOT stated by the documentation

Collected so no reader mistakes silence for a contract. Each item is a thing a fix must *design*, not
*read off* the platform.

1. That `chrome.storage.local.set` is atomic across multiple keys. (§2.2)
2. That two concurrent read-modify-write sequences from different contexts are serialized, isolated, or
   lost-update-free. (§2.2)
3. Any documented pattern for avoiding a lost update in `chrome.storage`. (§2.2)
4. The order in which two `set` calls from the same context are applied. (§3)
5. The order in which `onChanged` events are delivered, or whether changes are coalesced. (§3)
6. That a `get` issued after an awaited `set` is guaranteed to observe that `set`. (§3)
7. Which frame's response a `tabs.sendMessage` sender receives when several frames respond. (Chrome
   docs; MDN says only "one of answers".) (§5.2)
8. Any field by which the sender learns which frame produced a response. (§5.2)
9. That `storage.session` survives a service-worker restart within one browser session — stated only by
   omission from the clearing list, not by a sentence. (§4)
10. Any recommendation that a sequence counter belongs in `storage.session` (or anywhere). (§4)
11. Whether async work dispatched in a popup continues or completes after the popup closes. (§6)
12. Whether `runtime.onSuspend` fires for an MV3 extension service worker, or for a popup. (§6)
13. Any popup teardown / flush-on-close event or facility. (§6)
14. Any per-site settings data shape, key-naming scheme, or cross-context consistency pattern. (§7)
15. Any guidance for a popup + worker + all-frames content-script design. (§7)
16. Whether nested object values are merged by `set` (only top-level keys are documented as untouched).
   (§2.1)

## 8a. UNVERIFIED claims

None of the *answers* above are UNVERIFIED: every one is backed by a quoted sentence from a primary
source, or is an explicit "the documentation does not state this". The following are flagged because
they are inferences I made and are labelled **[reading]** at their point of use, not because a source
contradicts them:

- **§4**: that `storage.session` survives a service-worker-only restart (inferred from the enumerated
  clearing conditions; no sentence states it).
- **§5.1**: that "all frames in the tab" means every frame with a content script (composed from the
  `tabs.sendMessage` description plus the `content_scripts`/`all_frames` behaviour, which MDN states:
  "Whether the content script is executed in all frames depends on the `all_frames` setting in the
  `content_scripts` section of `manifest.json`").
- **§6**: that the popup's document lifetime equals its visible lifetime (composed from MDN's "loaded
  every time the popup is shown, and unloaded every time the popup is closed" plus the *Add a popup*
  paraphrase above — the documented automatic close on outside focus).

No blog, forum, or Stack Overflow answer is used as authority anywhere in this document. A web search
was used only to *locate* the official pages and the samples-repository directories, each of which was
then read at its primary URL.

---

## 9. Sources

Chrome extension docs (developer.chrome.com), each with the page's own "Last updated" as shown:

1. *The extension service worker lifecycle* — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle — Last updated 2023-05-02.
2. *About extension service workers* — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers — Last updated 2023-05-03.
3. *Extension service worker basics* — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics — Last updated 2023-05-02.
4. *Events in service workers* — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events — Last updated 2023-05-02.
5. *browser.storage* — https://developer.chrome.com/docs/extensions/reference/api/storage — Last updated 2026-09-11.
6. *StorageArea* — https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea — Last updated 2026-09-11.
7. *browser.tabs* — https://developer.chrome.com/docs/extensions/reference/api/tabs (page rendered without a single tail "Last updated" in the fetched extract; reference content current at fetch).
8. *Message passing* — https://developer.chrome.com/docs/extensions/develop/concepts/messaging — Last updated 2025-12-03.
9. *browser.runtime* — https://developer.chrome.com/docs/extensions/reference/api/runtime.
10. *browser.webNavigation* — https://developer.chrome.com/docs/extensions/reference/api/webNavigation — Last updated 2026-10-04.
11. *Add a popup* — https://developer.chrome.com/docs/extensions/develop/ui/add-popup — Last updated 2023-12-12.
12. *Storage and cookies* — https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies — Last updated 2023-09-28.
13. *browser.sidePanel* — https://developer.chrome.com/docs/extensions/reference/api/sidePanel — Last updated 2026-09-11 (consulted for the popup-vs-panel lifecycle contrast; the side panel is documented to persist across tab navigation, unlike a popup).
14. *Samples* — https://developer.chrome.com/docs/extensions/samples.

MDN WebExtensions (developer.mozilla.org), each page's own "last modified":

15. *tabs.sendMessage()* — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/sendMessage — last modified 2026-06-23.
16. *webNavigation.getAllFrames()* — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webNavigation/getAllFrames — last modified 2026-06-23.
17. *storage* — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage — last modified 2025-07-17.
18. *manifest.json/action* — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action — last modified 2026-08-21.
19. *user_interface/Popups* — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups — last modified 2025-07-17.

Chromium source / schema:

20. `extensions/common/api/storage.json` — https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/storage.json (fetched as base64 by the Gitiles `?format=TEXT` default; the full `StorageArea` method list and the `set` description quoted above are read from it).

Samples repository:

21. `api-samples/storage/stylizr` — https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples/storage/stylizr.
22. `functional-samples` and `api-samples` directory listings — https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples and https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/api-samples.

---

## 10. Does `set` deep-merge a nested object, or replace the value under the key?

**Follow-on to §2.1, item 16 of §8, and §7 item 3.** §2.1 recorded as a **[reading]** that
"Any other key/value pairs in storage will not be affected" speaks to *top-level keys* and that a
partial nested object `replace`s the value rather than merging into it, but flagged that the docs never
describe nested behaviour. This section settles that question against the sources: the API reference and
schema, MDN, and the Chromium implementation that performs the write.

**Primary sources for this section:**

- *StorageArea* (the `set` reference) —
  <https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea> (Last updated
  2026-09-11).
- *browser.storage* —
  <https://developer.chrome.com/docs/extensions/reference/api/storage> (Last updated 2026-09-11).
- The Chromium API schema `extensions/common/api/storage.json` —
  <https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/storage.json>
  (fetched via Gitiles `?format=TEXT`, base64-decoded).
- MDN *StorageArea.set()* —
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/StorageArea/set>
  (last modified 2026-05-01).
- Chromium implementation, `components/value_store/leveldb_value_store.cc` —
  <https://chromium.googlesource.com/chromium/src/+/main/components/value_store/leveldb_value_store.cc>
  (fetched as base64 via `?format=TEXT`; line numbers below are from the decoded file).
- Chromium implementation, `extensions/browser/api/storage/storage_api.cc` and
  `extensions/browser/api/storage/storage_frontend.cc`, and
  `extensions/browser/api/storage/settings_storage_quota_enforcer.cc` — same Gitiles base64 method.

### 10.1 Merge or replace? — the documentation is silent; the implementation replaces

**What `set` is documented to do [normative].** The `StorageArea` reference, `set()`:

> "Sets multiple items."

> "An object which gives each key/value pair to update storage with. **Any other key/value pairs in
> storage will not be affected.**"

The Chromium schema `storage.json` carries the same sentence in the `set` parameter description:

> "<p>An object which gives each key/value pair to update storage with. Any other key/value pairs in
> storage will not be affected.</p><p>Primitive values such as numbers will serialize as expected.
> Values with a <code>typeof</code> <code>\"object\"</code> and <code>\"function\"</code> will typically
> serialize to <code>{}</code>, with the exception of <code>Array</code> (serializes as expected),
> <code>Date</code>, and <code>Regex</code> (serialize using their <code>String</code>
> representation).</p>"

The schema types the `set` parameter exactly as an opaque map, with no per-field structure:

> `"items": { "type": "object", "additionalProperties": { "type": "any", "preserveNull": true }, … }`

**The documentation does not state whether a nested object value is merged or replaced.** Neither page
uses the words "merge", "deep", "nested", "overwrite", "replace", or "partial" in connection with `set`.
MDN's `StorageArea.set()` is the closest, and it says only **[normative]**:

> "An object containing one or more key/value pairs to be stored. **If an item is in storage, its value
> is updated.**"

**[reading]** "its value is updated" is consistent with replacement of the item's whole value, but MDN
does not say whether the update is a merge or a clobber. The question is not answered by documentation.

**The actual behaviour — [source-derived, not documented].** In the Chromium write path, `set` is
handed the incoming object as a `base::DictValue` and writes **one leveldb entry per top-level key**,
where the entry's bytes are the JSON serialization of that key's value in full. Nothing reads, walks,
or merges into the previously stored value.

`extensions/browser/api/storage/storage_api.cc`, `StorageStorageAreaSetFunction::Run()`:

> `base::Value input = std::move(mutable_args[0]);`
> `…`
> `frontend->Set(extension(), storage_area(), std::move(input).TakeDict(), …)`

`extensions/browser/api/storage/storage_frontend.cc` passes that same map straight through:

> `ValueStore::WriteResult result = store->Set(ValueStore::DEFAULTS, values);`

and, for the session area, `StorageFrontend::Set(… base::DictValue values …)` copies each top-level entry
without combining it with anything already stored.

The store itself, `components/value_store/leveldb_value_store.cc`,
`LeveldbValueStore::Set(WriteOptions options, const base::DictValue& settings)`:

> `for (const auto [key, value] : settings) {`
> `  status.Merge(AddToBatch(options, key, value, &batch, &changes));`

and `LeveldbValueStore::AddToBatch(...)`:

> `if (write_new_value) {`
> `  std::string value_as_json;`
> `  if (!base::JSONWriter::Write(value, &value_as_json))`
> `    return Status(OTHER_ERROR, kCannotSerialize);`
> `  batch->Put(key, value_as_json);`
> `}`

**Reading of the implementation.** The unit of a write is the **top-level key**. For each key present in
the argument, the whole value is serialized with `base::JSONWriter::Write` and stored with
`batch->Put(key, value_as_json)`, overwriting whatever bytes were there. There is no read of the old
value except to compute the `oldValue`/`newValue` change record (`Status status = Read(key, &old_value);`)
and to decide whether the new value differs; there is no field-wise walk of the old and new objects and
no `merge`. Therefore a `set` whose value for a key is a partial object **replaces that key's entire
value** — the fields not present in the partial object are gone, not preserved.

**Verdict.** Answered as **[source-derived, not documented]**: `chrome.storage.local.set({site: {
gainDb: 6}})` replaces the whole `site` value with `{gainDb: 6}`. It does **not** deep-merge, so any other
field previously stored under `site` is dropped. This is an implementation fact read from the Chromium
source, not a documented contract; no page promises either behaviour.

### 10.2 Scope of the "will not be affected" guarantee — top-level keys only

The guarantee documented in §10.1 is **[normative]** and reads:

> "Any other key/value pairs in storage will not be affected."

The schema names the argument "each key/value pair to update storage with", and the implementation
(§10.1) writes exactly `batch->Put(key, value_as_json)` for each *top-level* `key`. So the sentence's
scope is the **keys of the storage area**: `set({A: …})` cannot read, write, or remove key `B`.

**Is a *field inside* key `A` covered?** **The documentation does not state this.** No page extends the
guarantee from keys to the fields of a value. In the implementation **[source-derived, not documented]**
the guarantee applies **only** at the top level: because the value for `A` is serialized and `Put` as one
unit, every field of `A` other than the ones in the argument is overwritten by their absence. The
"not affected" language is therefore a statement about **sibling top-level keys**, never about sibling
fields inside a replaced value.

**[reading]** The precise platform contract is:

- Setting key `A` leaves key `B` untouched — **documented** ("Any other key/value pairs in storage will
  not be affected"; confirmed per-key by `batch->Put(key, …)`).
- Setting a field inside `A` (which the API only expresses by passing a new value for `A`) clobbers the
  other fields of `A` — **source-derived, not documented**; no sentence covers field granularity at all.

### 10.3 Is there a documented pattern for changing one field safely?

**The documentation does not state one.** Neither the *browser.storage* overview, the *StorageArea*
`set()` reference, the Chromium schema, nor MDN's `set()` page describes a read-modify-write, a merge
helper, or any procedure for updating one field of a stored record without replacing the rest. §7 item 3
already recorded the absence of any clobber-avoidance pattern; the field-level case adds no documented
guidance. The only worked examples the docs give are the two in §2.2, and both write a whole object
(`browser.storage.sync.set({ options })`, `browser.storage.sync.set(storageCache)`).

What the implementation semantics actually permit **[source-derived, not documented]**, stated without
proposing a design:

1. **Within one context**, because the API is asynchronous and JavaScript runs to completion before the
   next task, a sequence of `await get(key)` then `await set({key: updated})` executes in order *for
   that context* — the read and the write are not interleaved with that context's own later statements.
   This is the ordering property §3 records as **not documented** for same-context `set` calls; the
   implementation does not add a lock around the pair.
2. **Across contexts**, there is no serialization primitive: §2.2 establishes that the API has no
   transaction, compare-and-swap, or version method, and the write path in §10.1 performs a plain
   per-key `Put` with no conditional check against a value read earlier. Two contexts each doing
   `get(key)` → modify in memory → `set({key})` can therefore have the later `Put` overwrite the
   earlier one's field change, because each `set` replaces the whole value for the key.
3. A single `set` call's keys are written inside one `leveldb::WriteBatch` applied by one
   `db()->Write(...)` (`LeveldbValueStore::WriteToDb`), so the *keys given to one call* are applied
   together at the storage layer — but the docs state no atomicity across keys (§2.2), and this
   batching does nothing to merge or preserve fields the caller did not send.

**The field-level point, isolated.** Because §10.1 makes the top-level key the unit of replacement, a
write that sends only `{gainDb: 6}` for key `site` discards every other field of `site`; the only way
the platform allows a field to be changed without discarding its siblings is for the writer to send the
whole value for `site` as it should end up, which requires reading the current value first. The
documentation does not state this; it is what the source-derived semantics force.

### 10.4 Additions to the "documentation does not state" list

Extends item 16 of §8 (which flagged nested-merge behaviour as unstated) with the specific findings of
this section. Kept here rather than edited into §8 so the earlier section is untouched.

17. Whether `set` merges or replaces a nested object value — **documented: neither**; the behaviour is
    replacement, **[source-derived, not documented]** from `LeveldbValueStore::Set`/`AddToBatch`.
    (§10.1)
18. Any guarantee about the granularity of a value's *fields* — the "will not be affected" sentence
    covers top-level keys only. (§10.2)
19. Any documented pattern for changing one field of a stored record without clobbering concurrent
    changes to other fields. (§10.3)
20. Any documented ordering or isolation for a `get` → modify → `set` pair performed by one context,
    beyond the per-context ordering already noted as unstated in §3. (§10.3)

**Effect on the earlier sections.** Nothing above contradicts a quoted sentence; §2.1's **[reading]** that
`set` replaces the whole value for a key is here upgraded from a reading of the docs to a
**[source-derived]** fact backed by the Chromium write path, and §8 item 16 is given its concrete answer.
No existing section is altered by this addition.

---

*Document status: research, first pass. Every normative claim is quoted with its URL; every gap is
stated as a gap. No code and no fix is proposed here by design.*
