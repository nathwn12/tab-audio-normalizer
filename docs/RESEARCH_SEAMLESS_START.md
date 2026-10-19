# RESEARCH: Seamless start — muting until routed, session pre-warm, and the cold-start onset guard

Primary-source reference for the seamless-start work shipping in release 5.4.1 of this
extension: a silence-until-routed attach guard for managed media elements, an eager
AudioContext + AudioWorklet pre-warm before first playback, and a cold-start onset guard in
the worklet.

**Scope rule.** Every finding carries its source URL and a confidence tag:

- **confirmed** — the sources state it directly (spec text or first-party documentation).
- **likely** — the reading is supported but no source states it outright; never treated as
  settled.

Where a source was not pulled, that is said explicitly. Nothing here is a design proposal for
this repo beyond the implications stated at the end.

**No browser was launched.** Desk research only, per the repo's Audio Safety rule. Sources
fetched 2026-10-19.

---

## 1. An element's mute/volume state applies to the graph feed

**Claim.** After `createMediaElementSource` routes an element's audio into the graph, the
element's own mute and volume settings still apply to that feed: HTML defines the element's
"effective media volume" as 0 while muted, and Web Audio 1.1 §1.22 requires that once an
element's audio is routed into a graph, "pausing, seeking, volume, src attribute changes …
MUST behave as they normally would".

**Sources:** WHATWG HTML (media elements) — <https://html.spec.whatwg.org/multipage/media.html>;
W3C Web Audio API 1.1 (§1.22) — <https://www.w3.org/TR/webaudio-1.1/>.

**Confidence: confirmed (spec chain).** Stated caveat: the Chromium C++ tap point was not
pulled, so this rests on the spec chain rather than browser code.

## 2. AudioContext pre-gesture: 'suspended', and resume() is gesture-gated

**Claim.** A context created before a user gesture starts 'suspended'; `resume()` succeeds
once a user gesture has occurred. The documented pattern is create-early/resume-late:
construct the context (and load its worklet) early, resume on the gesture. Gestures are click
and tap; plain scrolling is not a gesture.

**Sources:** Chrome Developers autoplay policy —
<https://developer.chrome.com/blog/autoplay/>; Chromium autoplay policy —
<https://www.chromium.org/audio-video/autoplay/>; WHATWG HTML (tracking user activation) —
<https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation>.

**Confidence: confirmed** for the 'suspended' state, the gesture-gated `resume()`, and
click/tap as a gesture; **likely** for the keydown detail and the scroll exclusion.

## 3. createMediaElementSource on an already-playing element

**Claim.** The spec re-routes an already-playing element's playback into the graph with no
documented disruption. No Chromium text was found confirming a glitch-free handoff for a
playing element.

**Source:** W3C Web Audio API 1.1 (§1.22) — <https://www.w3.org/TR/webaudio-1.1/>.

**Confidence: likely — not claimed.** Whichever way an individual browser behaves during the
switch is exactly why the attach guard mutes first (finding 1): the handoff window is covered
by the mute rather than assumed glitch-free.

## 4. addModule() registration and its timing

**Claim.** `AudioWorklet.addModule()` returns a promise that resolves once the processor is
registered with that context; registration is per-AudioContext. No latency numbers for module
load or processor registration are published.

**Source:** W3C Web Audio API 1.1 (AudioWorklet) — <https://www.w3.org/TR/webaudio-1.1/>.

**Confidence: the pattern is blessed; the timing is unquantified.** There is no published
number for how long registration takes, so pre-warming is a timing play rather than a
guarantee.

## 5. Muted autoplay is always allowed

**Claim.** Muted autoplay is always allowed by the autoplay policies, and the spec's own
example mutes an element before playing it. Caveat: muted plays do not build the Media
Engagement Index, so this route cannot earn autoplay privileges by itself.

**Sources:** Chrome Developers autoplay policy —
<https://developer.chrome.com/blog/autoplay/>; WHATWG HTML (media elements) —
<https://html.spec.whatwg.org/multipage/media.html>.

**Confidence: confirmed**, with the Media Engagement Index caveat recorded.

## 6. Implications for this codebase

- **The attach guard (mute until routed) is sound by spec.** Finding 1 says the element's
  mute applies to the graph feed, so arming `muted = true` before routing and restoring the
  prior value after `connect` holds the element silent for exactly the attach window;
  finding 5 sanctions muted playback outright.
- **The pre-warm matches the documented pattern.** Finding 2's create-early/resume-late
  pattern is the eager session construction on activation, with `resume()` on the gesture;
  finding 4's unquantified registration latency is the reason to load the worklet before the
  first element plays rather than on attach.
- **Unmute only after routing is the safe order.** Findings 1 and 3: while the guard is
  armed the element is silent regardless of the handoff's behaviour; unmuting before routing
  would not be covered, which is why the restore runs after `source.connect(...)` and on
  every failure path (the 1.5 s fallback included).

## Sources (all fetched 2026-10-19)

- WHATWG HTML — media elements: <https://html.spec.whatwg.org/multipage/media.html>
- WHATWG HTML — tracking user activation:
  <https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation>
- W3C Web Audio API 1.1: <https://www.w3.org/TR/webaudio-1.1/>
- Chrome Developers — Autoplay policy: <https://developer.chrome.com/blog/autoplay/>
- Chromium — Autoplay: <https://www.chromium.org/audio-video/autoplay/>
