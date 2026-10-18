# RESEARCH: Comfort loudness normalisation — the correct design for "a HUMAN COMFORT loudness, always, and consistent"

Companion to `docs/RESEARCH_LOUDNESS.md`. That file already establishes, from primary sources: the
BS.1770-4 gating chain and its coefficients, the true-peak under-read bound, the EBU R 128 / ATSC A/85
targets, the streaming targets, ReplayGain 2.0, the **Dolby Film Standard** DRC profile, the Web Audio
real-time contract, and the verified worklet implementation. **This file does not restate any of it.**
It cites `RESEARCH_LOUDNESS.md` by section and adds only what that file does not contain: the
delivery-versus-listening-comfort distinction, the *other* published DRC profiles with their numbers,
the published two-loop structure, the anti-maximiser bounds, the frequency-domain verdict, and the
instant-slider distinction.

**Why a companion and not a new section of `RESEARCH_LOUDNESS.md`.** `RESEARCH_LOUDNESS.md` is a
measurement-and-browser-runtime reference (how to *measure* loudness and *implement* the meter). This
document is a **design** reference (what the correct comfort chain is, and what numbers the standards
put on it). The repo already uses the `RESEARCH_*.md` companion pattern (`RESEARCH_MV3_STATE.md`), so
this follows both the `docs/` UPPER_SNAKE convention and the existing research-note convention.

**Scope rule.** Every number carries a URL and a verbatim quote. Where a standard is not free, that is
stated. Where a platform publishes nothing, this file says so rather than repeating a blog. Where the
documentation is silent, it says **"the documentation does not state this"**. Nothing here is a design
proposal or code; it is the facts the design must be built on.

**Context fixed by the brief.** The owner's three complaints are the symptoms of a single mistake:
integrated loudness is a whole-program average, so (a) a program with quiet dialogue and loud
transients barely moves the average ("loud videos stay loud"), and (b) a mostly-quiet program sits
against the +12 dB boost clamp, raising its quiet parts ("the quiet parts are even enhanced for it"),
and the result is that it "does not do what he wants" ("my ears are equally fucked"). The mechanism is
understood and is not re-derived here. What follows is what the published material says the correct
design is.

---

## 1. The comfort target — and the delivery-versus-listening distinction

### 1.1 The two families are not the same thing

Two different jobs produce two different numbers, and conflating them is the error this section exists
to prevent:

- **Delivery loudness** is the level a *producer or distributor* is told to hand content to a channel.
  It is chosen for that channel's gain budget, headroom, and peak ceiling. `RESEARCH_LOUDNESS.md` §3.1
  and §3.2 already tabulate these (EBU R 128 −23.0 LUFS; ATSC A/85 −24 LKFS; AES TD1008; Spotify −14;
  the platform figures).
- **Listening / playback comfort** is the level a *consumer device* is told to reproduce at, or the
  level a home mix is monitored at. It is a different family. Its primary sources in this file are
  Dolby's Line/RF-mode normalized dialogue levels, the xHE-AAC/MPEG-D "Target Loudness" setting, and
  Netflix's near-field monitoring level.

A **consumer normalizer running as the last stage before the ear is a playback stage, so it belongs to
the second family** — but see §1.5, because the content it receives has already been through the first
family at the platform.

### 1.2 Delivery targets (the first family) — every number, sourced

| Standard / channel | Integrated target | Tolerance | Max true peak | Source |
|---|---|---|---|---|
| **EBU R 128** (broadcast) | **−23.0 LUFS** | ±1.0 LU (live), ±0.2 LU (QC) | **−1 dBTP** (linear audio), ±0.3 dB | `RESEARCH_LOUDNESS.md` §3.1; <https://tech.ebu.ch/docs/r/r128.pdf> |
| **ATSC A/85** (US TV) | **−24 LKFS** (dialogue anchor) | ±2 LKFS | **−2 dBTP** | AES TD1006 Table 1 (quotes A/85); <https://aes.org/wp-content/uploads/2024/01/AESTD1006_1_17_10.pdf> |
| **EBU R 128 s2** (streaming) | **−23.0 LUFS** streamed unchanged; **−20.0 to −16.0 LUFS** interim *only where metadata is not employed* | — | −1 dBTP (device limiting per Tech 3344) | <https://tech.ebu.ch/docs/r/r128s2.pdf> |
| **AES TD1008** (audio streaming / on-demand) | speech/assorted and interstitial **−18 LUFS**; track-normalised music **−16 LUFS**; album-loudest track **−14 LUFS** | +1 / +2 / +0.2 LU | **−1 dBTP**; and "keep the Integrated Loudness of content above **−20 LUFS**" | <https://aes.org/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf> |
| **AES TD1006** (OTT/OVD) | *maximum* loudness: short-form and long-form **−16 ±1 LKFS/LUFS** | — | **−1 dBTP** | <https://aes.org/wp-content/uploads/2024/01/AESTD1006_1_17_10.pdf>, Table 3 |

EBU R 128 s2's own words on why the louder window exists, and that it is a *fallback*:

> "g) that, unless metadata is employed to manage device gain and the dynamic properties of content,
> the Distribution Loudness Level may be higher than −23.0 LUFS prior to streaming if the broadcaster
> wants to be in control of the quality of the potential dynamic treatment … In this case, the interim
> value for the Distribution Loudness Level should be in the range of −20.0 to −16.0 LUFS"

and it names the two listening situations the value must serve:

> "situations with sufficiently high playback gain and headroom as well as low background noise to
> faithfully reproduce dynamic programmes (for example, devices such as TV receivers, Smart Speakers
> and Home Theatre Equipment); situations with limited playback gain and headroom and/or higher
> background noise (for example, devices such as smartphones or Personal Music Players)"

AES TD1008 states its target's *purpose* and its planned direction, which is the load-bearing quote for
§1.5's headroom argument:

> "Table 1 recommends that speech within streams be normalized to −18 LUFS **to accommodate the gain of
> current player devices**."

> "It is recommended that as the audio capabilities of devices advance … industry experts and
> stakeholders reconvene to further revise this document by **lowering its Distribution Loudness
> recommendations by 6 LU**."

> "To prevent vulnerable players from sounding too quiet even at maximum gain, it is recommended to keep
> the Integrated Loudness of content above **−20 LUFS**."

### 1.3 Listening / playback-comfort anchors (the second family) — every number, sourced

| Source | Number | What it is, verbatim |
|---|---|---|
| **Dolby Line mode** (AC-3 decoder) | **−31 dBFS Leq(A)** | "The normalized dialogue level is reproduced from the decoder at a constant loudness level of **−31 dBFS** ITU-R Rec. BS.1770, assuming the Dialogue Level parameter is set correctly." (<https://www.manualsdir.com/manuals/78560/dolby-laboratories-multichannel-audio-tool-dp570.html?page=104>) |
| **Dolby RF mode** (the "heavy attack" home mode) | **−20 dBFS Leq(A)** | "In RF mode, the overall program level is raised **11 dB**, this results in dialogue being reproduced at a level of **−20 dBFS**, while the peaks are limited to prevent signal overload in the D/A converter." (same source) |
| **MPEG-D DRC / xHE-AAC "Target Loudness"** | default **−24 LKFS**; AVR **−31 LKFS**; mobile max **−16 LKFS** | "In media streaming applications, the target loudness is usually set to a value of **−24 LKFS**. When decoding for a multi-channel playback system such as an AVR, the target loudness should be set to a lower level such as **−31 LKFS** for alignment to other audio decoder sources. For playback on mobile devices, it is recommended to limit the target loudness setting to a maximum of **−16 LKFS** if a larger output loudness than −24 LKFS is desired." (<https://www.digitalmedia.fraunhofer.de/content/dam/dcinema/en/documents/FraunhoferIIS_xHE-AAC_Whitepaper.pdf>) |
| **Netflix near-field mix** | monitored at **79 or 82 dB SPL**; delivered at **−27 LKFS ±2, dialogue-gated** | Third-party summaries of Netflix's Partner Help Center spec (see §7). Netflix's own page: <https://partnerhelp.netflixstudios.com/hc/en-us/articles/360001794307-Netflix-Loudness-and-Dynamic-Range> — **labelled secondary in this file** because the page did not render to a plain client. |
| **Apple Video and Audio Asset Guide** (Dolby Atmos / 5.1 / 7.1) | dialogue **ideally between −30 and −18 LKFS** (must be within −31 to −10 LKFS) | "The average loudness of dialogue or speech in the Dolby Atmos file must be within the range of −31 LKFS to −10 LKFS, and should ideally be between **−30 LKFS and −18 LKFS**." (<https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html>) |
| **WHO / ITU-T H.870** (safe-listening, an *upper* bound not a comfort target) | **80 dBA** for 40 h/week (Mode 1); **75 dBA** (Mode 2) | "Mode 1: (WHO) standard level for adults: this will apply 1.6 Pa²h per 7 days as the reference exposure. … the value of 100% calculated sound dose (CSD) corresponds to **80 dB(A) for 40 hours**." (<https://www.itu.int/rec/T-REC-H.870-202203-I/en>) |

Note the shape: **the home-comfort family clusters lower than the delivery family.** Dolby normalizes
home dialogue at −31 dBFS; xHE-AAC's device default is −24 LKFS; Netflix's home mix is −27 LKFS
dialogue-gated. Broadcast delivery sits at −23/−24; streaming delivery at −14 to −18.

### 1.4 The content profiles this design must survive (the owner's sites)

The owner's sites are YouTube, YouTube Music, TikTok, Facebook, X, Reddit. What each *publishes* about
loudness is listed exactly, with the kind of source named. **This table is the input to §1.5.**

| Platform | Published target? | Attenuate-only or bidirectional? | Uploads / short-form / ads | Own DRC? | Source type |
|---|---|---|---|---|---|
| **YouTube** | **No numeric target published.** | **Not documented.** The "only turns loud content down" behaviour is community measurement, not a YouTube statement → `UNVERIFIED` as to a published rule. | Documents "Stable volume" — "balances the range between quiet and loud, continuously adjusting volume levels to reduce variations in sound"; and "Voice boost … reducing background sound and highlighting speech". "**Music is not affected by this feature**"; "**turned off for YouTube Music and official music videos**". Enhancement settings "does not affect ads". | Yes — and it labels Stable volume/Voice boost as *audio enhancements* it "may automatically apply", i.e. **dynamic-range processing, described as on/off, with no parameters published**. | Vendor help pages: <https://support.google.com/youtube/answer/14106294>, <https://support.google.com/youtube/answer/16619284> |
| **YouTube Music** | **No target published.** | Unknown. | Stable volume explicitly off (§ above). | The same page states music is not affected by Stable volume. | Vendor help page (as above) |
| **TikTok** | **No specification published.** Every fixed number (commonly ≈−14 LUFS) is third-party measurement and the measurements disagree → `UNVERIFIED`. | Not documented. | Not documented. | Not documented; platforms re-encode. | No primary source located |
| **Facebook / Instagram (Meta)** | **No numeric target published.** | **Not stated** whether it boosts or only attenuates. | "we receive audio tracks with loudness levels ranging from silence to full scale"; "**bringing the average loudness of all sessions to the same target level** and managing the dynamic range of each session to fit the playback environment". | **Yes, by design.** Reels and Stories use xHE-AAC loudness management: "delegate loudness management processing to the client via loudness metadata"; two-pass encoding "allows us to use loudness range control (LRAC) DRC, which mitigates pumping artifacts otherwise introduced by single-pass DRC algorithms". | **Engineering material** (not a spec): Meta engineering blog <https://engineering.fb.com/2023/04/11/video-engineering/high-quality-audio-xhe-aac-codec-meta/> |
| **X (Twitter)** | **Publishes nothing** that I could locate. | Not documented. | Not documented. | Not documented. | No primary source located |
| **Reddit** | **Publishes nothing.** (Reddit-hosted video is platform-level; Reddit's public help does not state a loudness target.) | Not documented. | Not documented. | Not documented. | No primary source located |
| **Spotify** (for contrast — the one fully published music platform) | **−14 LUFS** published; user levels Loud −11 / Normal −14 / Quiet −19. | **Bidirectional** — "Positive gain is applied to softer masters … We consider the headroom of the track, and leave **1 dB headroom** for lossy encodings". | Applies to track uploads; the Loud mode "**We apply a limiter** … engage at **−1 dB (sample values), with a 5 ms attack time and a 100 ms decay time**". | Yes (the Loud-mode limiter). | Vendor doc, quoted in full in `RESEARCH_LOUDNESS.md` §3.2: <https://support.spotify.com/us/artists/article/loudness-normalization/> |
| **Apple Music / HLS** | Apple's HLS authoring spec publishes **no single LUFS target**; it requires loudness *metadata*. Apple's Asset Guide caps immersive/5.1 at **−18 LKFS**; Apple Podcasts publishes **−16 LKFS ±1**. | Apple's podcast/Audio-requirements text is quoted at "playback levels at −16 dB" for Sound Check; treat an Apple Music *music* target as `UNVERIFIED` against Apple (the −16 LUFS figure is not in the docs I could verify). | — | Apple HLS: "Loudness management or Dynamic range control SHOULD be present unless all content (including ads) has been encoded at the same audio levels." | Apple developer docs: <https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html>, <https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html>, <https://podcasters.apple.com/support/893-audio-requirements> |

**Plainly, from this table:** YouTube, YouTube Music, TikTok, X and Reddit **publish no loudness target
at all**; Meta publishes the *mechanism* (normalise to a target + DRC by metadata) but no number; only
Spotify publishes a full bidirectionally-applied target. Everything else — including the widely repeated
"−14 LUFS" — is measurement by third parties and is `UNVERIFIED` as a published platform rule.

### 1.5 The comfort target for this extension, and why it sits *below* the platforms

Reasoning that the sources above support, stated as such (not as a standard's own recommendation):

1. **A consumer normalizer is a playback stage**, so it should use a **playback/comfort** target, not a
   broadcast delivery target. The published playback anchors (§1.3) sit at −24 to −31 LKFS/LUFS, well
   below the −23/−24 delivery numbers and far below the ≈−14 the platforms use.
2. **Most of the content this extension sees has already been platform-normalised** to about **−14 LUFS**
   (Spotify publishes −14; YouTube/TikTok land there by measurement; Meta normalises to its own
   unpublished target). Where that platform processing is **attenuate-only** (Spotify is bidirectional,
   but the widely-observed YouTube/TikTok behaviour is down-only → `UNVERIFIED`), a video mastered
   quietly arrives **quiet and is never lifted** by the platform. That is precisely the case that a
   consumer normalizer must fix, and it is the case where there is no headroom left if the extension's
   own target is *at* the platform's number.
3. Therefore the extension's program target must sit **below** the platforms' ≈−14 LUFS, so that the
   **level-equalization stage has headroom to bring quiet dialogue up without hitting the true-peak
   ceiling** (§4). At the extension's target, the slow integrated gain on already-normalised content is
   a **small attenuation of a few LU**, not a boost — so **the audible "quiet dialogue" fix has to come
   from the levelling stage, not from the integrated gain.** This is the design consequence the owner's
   complaint points at.

**The number.** The extension implements **−20 LUFS** as its program target — a judgment inside the
published **−20.0 to −16.0 LUFS** window (EBU R 128 s2 interim, where metadata is not employed; AES
TD1008 track-music −16, with a floor of keeping content above −20 LUFS), at the window's bottom,
dynamics-preserving end: below the platforms' ≈−14 so the levelling stage keeps headroom to lift
quiet dialogue before the true-peak ceiling, and below AES's −18 speech/assorted anchor. EBU R 128
s4's own cinematic remedy lands adapted program loudness at −21 LUFS, corroborating −20 within
1 dB. For a **music-only** path (YouTube Music), AES TD1008's **−16 LUFS** track-normalisation
figure applies. If the target is chosen for headphone listening with maximum preservation of
dynamics, **−23 LUFS** (EBU R 128) is the broadcast-aligned alternative.

**No standard publishes a single "human comfort" number.** What is published is this family of targets
with stated purposes; the choice of one is a deliver-versus-play judgment, and the sources' own words in
§1.2/§1.3 are what a defensible choice must rest on. The single most important qualitative finding:
**the fix for the owner's complaints is not a different integrated target — it is the within-program
levelling stage (§2, §3), which the sources publish as a separate, first-class operation.**

---

## 2. Within-program level equalisation — the published profiles, verbatim

The owner wants "quiet up, loud down" *within* a program. That is a published operation with published
parameters. This section gives each profile's numbers.

### 2.1 Dolby's six AC-3 DRC profiles (the canonical set) — verbatim

Primary source: **A Guide to Dolby Metadata** (Dolby Laboratories), Appendix D of the *Dolby DP570
Multichannel Audio Tool User Manual*; the same text is mirrored, and is quoted identically on Dolby's
own Hybrik product page. Quotes below are from the guide as mirrored at
<http://www.aesnashville.org/PDFs/Technical/Dolby/Dolby%20Metadata.pdf> (Dolby's document, third-party
host) and cross-checked against <https://docs.hybrik.com/tutorials/dolby_audio>.

Dolby's own summary of the operation:

> "Six preset DRC profiles are available to content producers: Film Light, Film Standard, Music Light,
> Music Standard, Speech, and None. … In each case, **the center of the null band is assigned to the
> dialogue level parameter setting**, and the DRC profile is applied in relation to that level."

Verbatim profile parameters (all six):

| Profile | Max boost | Boost range (ratio) | Null band | Early cut range (ratio) | Cut range (ratio) |
|---|---|---|---|---|---|
| **Film Light** | 6 dB (below −53 dB) | −53 to −41 dB (2:1) | **20 dB** (−41 to −21 dB) | −26 to −11 dB (2:1) | −11 to +4 dB (20:1) |
| **Film Standard** | 6 dB (below −43 dB) | −43 to −31 dB (2:1) | **5 dB** (−31 to −26 dB) | −26 to −16 dB (2:1) | −16 to +4 dB (20:1) |
| **Music Light** | 12 dB (below −65 dB) | −65 to −41 dB (2:1) | **20 dB** (−41 to −21 dB) | *(none — "No early cut range")* | −21 to +9 dB (2:1) |
| **Music Standard** | 12 dB (below −55 dB) | −55 to −31 dB (2:1) | **5 dB** (−31 to −26 dB) | −26 to −16 dB (2:1) | −16 to +4 dB (20:1) |
| **Speech** | 15 dB (below −50 dB) | −50 to −31 dB (5:1) | **5 dB** (−31 to −26 dB) | −26 to −16 dB (2:1) | −16 to +4 dB (20:1) |
| **None** | — | — | — | — | — (dialnorm still applied) |

Dolby's stated design intent, verbatim (Dolby Hybrik product page, <https://docs.hybrik.com/tutorials/dolby_audio>):

> "**low level signals are boosted, mid level signals are left untouched, and high level signals are
> compressed** — thus reducing the overall dynamic range."

Dolby's separate *Dolby Digital Professional Encoding Guidelines* describes the profiles in prose
(mirror: <https://www.yumpu.com/en/document/view/18800037/dolby-digital-professional-encoding-guidelines-educypedia-the->):

> "Below the null band, both profiles offer up to **12 dB of boost with a 2:1 compression ratio**. Above
> the null band, a standard profile gives **20:1** compression and light 2:1." (Music profiles)

> "The speech profile uses a **10 dB null band** for average speech. … outside this region fairly heavy
> compression is applied: **5:1 ratio up to 15 dB boost** for low levels and **20:1 (near limiting)**
> for high levels."

**Discrepancy recorded:** the profile table above (from *A Guide to Dolby Metadata*) gives the Speech
null band as **5 dB** and the Film profiles' null bands as 5 dB (standard) / 20 dB (light), while the
*Encoding Guidelines* prose says Speech uses "10 dB" and describes the film null bands as "10 and 20 dB
wide respectively". Dolby's own two documents disagree; the **table in §2.1 is taken from *A Guide to
Dolby Metadata* and is the one to use**, because its thresholds are explicit and it matches the Hybrik
page's Film Standard numbers exactly.

This is the shape the owner is asking for: quiet boosted with a bounded max, a null band around the
anchor left untouched, loud peaks compressed near 20:1. The bounds are inherent (§4).

### 2.2 Dolby's "Night mode" — what is and is not documented

"Dolby's Night mode" is not a separate published curve; it is a **consumer-facing name for the RF-mode /
Line-mode DRC** and the profile chosen for it. The guide's words:

> "Full-featured decoders allow the consumer to select whether to use DRC … The consumer sees options
> such as **Off, Light Compression, and Heavy Compression** instead of None, Line mode, and RF mode."

> "RF mode is designed for products (such as set-top boxes) … however, it is also useful in situations
> where heavy DRC is required — for example, when small PC speakers are used for DVD playback. In RF
> mode, the **overall program level is raised 11 dB**, this results in dialogue being reproduced at a
> level of **−20 dBFS**, while the peaks are limited to prevent signal overload in the D/A converter."

Dolby's Hybrik page explicitly ties the consumer label to the mechanism:
`"applied selectively by the consumer i.e. 'late night mode'"`.

**The documentation does not state** a distinct "Night" profile with its own threshold/ratio numbers.
"Night"/"Late Night"/"Midnight" are consumer labels for RF-mode DRC (or Line mode with a profile); the
numbers are the profile numbers in §2.1.

### 2.3 Windows "Loudness Equalization" — as documented

Microsoft Learn, *Loudness Equalization DSP*: <https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/loudness-equalization-dsp>.

> "Loudness equalization simulates human hearing to accurately measure the loudness—as opposed to
> intensity—of an audio source. It then uses **dynamic gain adjustment** to keep the loudness of
> different sources more nearly constant. Loudness equalization can thus affect both dynamic range and
> peak loudness. Windows Vista uses single-pass loudness equalization, which calculates loudness on a
> block-by-block basis. A block corresponds to the critical band resolution of a human [ear]. …
> loudness equalization adjusts the gain with a **fast attack and slow decay—just as many wideband
> compressors do**—to tightly control the peak loudness of a signal while maintaining the local
> dynamics."

**The documentation does not state numeric thresholds, ratios, null band, or a max boost/cut.** It
states the *structure* (block-based critical-band loudness measurement; wideband dynamic gain; fast
attack / slow decay) and no more.

### 2.4 Apple TV "Reduce Loud Sounds" — as documented

Apple Support, *Change audio settings on Apple TV 4K*:
<https://support.apple.com/guide/tv/change-audio-settings-atvba773c3c9/tvos>.

> "Reduce Loud Sounds: Lower the overall sound level by reducing the dynamic range so that loud music
> and sound effects aren't as loud as other sounds."

**Apple publishes no algorithm, no parameters, and no LUFS target for this feature.** Any claim about
its internals is non-primary.

### 2.5 EBU on controlling loudness range — the published ratio target (R 128 s4)

This is the strongest published *within-program* target that matches the owner's request. **EBU R 128
s4** (2023), *Loudness normalisation of Cinematic Content*: <https://tech.ebu.ch/docs/r/r128s4.pdf>.

> "b) that the main criterion for qualifying Cinematic Content as challenging is a large
> Loudness-to-Dialogue Ratio (LDR), sometimes reaching **15 LU or more**;"

> "j) that the **Loudness-to-Dialogue Ratio of Cinematic Content should not exceed 5 LU.** Dynamic
> adaptation of the programme should mainly target this parameter (see Fig.1 case b);"

> "k) that, if the Loudness-to-Dialogue Ratio of Cinematic Content is **within 5 LU, no dynamic
> adaptation needs to be performed**, thus keeping the quality of the original mix. Particularly,
> increasing Dialogue Loudness to match Programme Loudness (LDR = 0) should be avoided;"

Worked example, verbatim from the document ("Case a"): *"PL = −17 LUFS, DL = −29 LUFS (thus, LDR = 12
LU)"* — i.e. an action movie's dialogue sits 12 LU below its effects. The remedy is *"dynamic adaptation
of the whole programme to bring the Loudness-to-Dialogue Ratio (LDR) to 5 LU"*, after which *"the value
of DL is −26 LUFS and PL is −21 LUFS"*.

EBU Tech 3343 §9.4.2 explains the adaptation methods and gives a hard preference:

> "Manual processing relies on experienced audio engineers, using tools such as compression, limiting
> and gain riding …; Automatic processing again relies on the processing algorithm. **Offline and
> iterative algorithms can leave deliberate loudness jumps intact** and can therefore provide a more
> unobtrusive adaptation result with fewer artefacts. Although sophisticated methods are available to
> fine tune the dynamics processing on the fly, **algorithms in iterative offline workflows are
> preferred over real-time or 'live' processors** which typically react without knowledge of the coming
> audio signal or its characteristics so far."
> (<https://tech.ebu.ch/docs/tech/tech3343.pdf>)

**Note (fidelity):** LDR is a *dialogue-to-program* ratio and requires dialogue measurement. EBU's own
measure is Programme Loudness vs Dialogue Loudness; it is not the same as the Short-term-vs-Integrated
ratio a monocular extension can compute. Recorded so no claim is made that a dialogue-free implementation
reproduces LDR.

### 2.6 ITU material on dynamic-range control

**The documentation does not state a DRC profile.** ITU-R BS.1770-4/-5 is *measurement only* — its
`recommends` clauses cover the loudness algorithm, true peak, advanced/object systems, and metering
(`RESEARCH_LOUDNESS.md` §1, §2). BS.1770 does **not** specify a dynamic-range-control profile or a
target. The relevant ITU document for *normal* dialogue is cited by EBU Tech 3343 as **ITU-R BS.1864**:
*"One of the few documents which give a hint is ITU-R BS.1864 [24] where 'normal' dialogue is that which
is spoken in a normal level of speaking voice, that is, not shouting or whispering."* (BS.1864 is
access-restricted; quoted via EBU Tech 3343.) The codec-level DRC in ITU's world is carried by the
codec metadata standards referenced by CTA-2075 (§3).

### 2.7 The codec-standard DRC effect types (the modern profile set)

**ISO/IEC 23003-4 (MPEG-D DRC)** is the codec-agnostic, standardised DRC tool and is named by EBU R 128
s2, AES TD1006, and Apple's HLS spec. Its own abstract:

> "This document specifies technology for loudness and dynamic range control (DRC). … It offers flexible
> solutions to efficiently support the widespread demand for technologies such as **loudness
> normalization and dynamic range compression** for various playback scenarios."
> (<https://www.iso.org/standard/89036.html>)

The Fraunhofer xHE-AAC whitepaper documents the four **DRC Effect Types** the standard's decoder
exposes (<https://www.digitalmedia.fraunhofer.de/content/dam/dcinema/en/documents/FraunhoferIIS_xHE-AAC_Whitepaper.pdf>):

> "**Noisy Environment**: DRC processing for conditions adversely affected by environmental noise.
> **Late Night**: DRC processing for scenarios in which e.g. neighbors or kids should not be disturbed by
> loud parts above the average. **Limited Playback Range**: DRC processing for listening on mobile
> devices at high target loudness and limited transducer capabilities. **Off**: No DRC processing
> except for peak limiting."

Two documented structural facts that matter for §3 and §4:

> "Loudness normalization is fully integrated with DRC and peak control to avoid clipping." (ISO/IEC
> 23003-4 Introduction)

> "An advanced peak and clipping control are fully integrated." (<https://www.mpeg.org/standards/MPEG-D/4/>)

**The standard does not publish numeric thresholds/ratios for these effect types** — they are
encoder-generated gain sequences (see §3.1), not fixed curves.

---

## 3. The two-loop structure: slow absolute gain + faster within-program equalisation + limiter

### 3.1 The received design, and who documents the split

The correct structure is documented as **two separate operations, in a fixed order**, by several primary
sources. They agree on the shape.

1. **EBU R 128 s4 — the clearest statement of the split and its ordering.** The document labels the
   within-program step a *"preliminary step"* and the absolute gain a *subsequent* step:
   > "**Case b:** Example of dynamic adaptation of the whole programme to bring the Loudness-to-Dialogue
   > Ratio (LDR) to 5 LU: after adaptation the value of DL is −26 LUFS and PL is −21 LUFS. **This is a
   > preliminary step** which can result in higher peaks than in the original signal …"
   > "**Case c:** The adapted programme is **normalised to PL = −23 LUFS** (−2 dB gain) which is the
   > default normalisation scheme according to EBU R 128."
   So: **level-equalise first (bounded by LDR ≤ 5 LU), then apply the slow absolute gain to the target.**

2. **Dolby / ATSC A/85 — the slow level is `dialnorm`, the fast level is DRC, the ceiling is overload
   protection.** The guide:
   > "Dialnorm ensures all audio content is output at the same reference dialog level. DRC reduces the
   > dynamic range of the content, with the dialog reference level as the 'null' point. … **Dialnorm is
   > the threshold for DRC**."
   ATSC A/85 §9.1.3 adds the ordering constraint verbatim:
   > "**All DRC calculations are relative to and based on the indicated loudness of content as
   > represented by the dialnorm metadata parameter.** … The dialnorm parameter determines the position
   > of this null band, so again, it is essential that the dialnorm parameter accurately indicate the
   > loudness of the content."
   And the third stage: A/85 describes *"a somewhat hidden and inescapable overload protection process
   designed to protect down-mixed audio from overloading consumer equipment."*

3. **ISO/IEC 23003-4 (MPEG-D DRC)** models exactly this three-part chain: a **metadata loudness value**
   (the slow/absolute term), **DRC gain sequences** (the fast within-program term), and an **integrated
   peak/clipping control** (the limiter). Its Introduction states *"Loudness normalization is fully
   integrated with DRC and peak control to avoid clipping."* Apple's HLS spec makes the metadata
   mandatory for xHE-AAC and requires `samplePeakLevel` or `truePeakLevel` to be present (see §1.4 source).

4. **AES's own description of active/real-time controllers** names the slow loop's integration time and
   the limiter: *"the integrated LUFS value is based on a user-defined rolling average … It is
   recommended that this period be between **30 seconds to two minutes**. … **Peak limiting is provided**
   since gain may be applied."* (<https://aes.org/resources/audio-topics/loudness-project/loudness-normalization/>)

5. **Reference implementation.** `ffmpeg loudnorm` documents both modes in one filter:
   > "EBU R128 loudness normalization. **Includes both dynamic and linear normalization modes.** Support
   > for both single pass (livestreams, files) and double pass (files) modes. This algorithm can target
   > **IL, LRA, and maximum true peak**."
   `linear` = static gain; `dynamic` = the within-program stage, and it reverts to dynamic when a pure
   linear pass cannot be achieved without exceeding the true-peak target (`RESEARCH_LOUDNESS.md` §6.1
   documents the JSON that carries `measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`).
   <https://ffmpeg.org/ffmpeg-filters.html#loudnorm>

**Summary of the received design:** *measure the gated integrated loudness of the unmodified signal (§1
of `RESEARCH_LOUDNESS.md`) → derive one slow absolute gain toward the target; separately run a bounded
within-program compressor/gain-rider that reduces the loud-then-quiet spread (the LDR / DRC / effect-type
stage); then a true-peak limiter at the ceiling.* The two stages are published as distinct, and the
levelling stage is published as *preliminary to* the absolute gain.

### 3.2 How the stages must interact so they do not fight

The sources give the anti-oscillation rules explicitly:

- **The equaliser must not drive the loudness measure.** EBU R 128 s4 names the adaptation a
  *"preliminary step"* that happens *before* normalisation, not as part of the measurement loop. MPEG-D
  DRC derives the *"loudness normalization"* gain from the **encoded content loudness** measured on the
  unmodified content — not from the DRC-modified output. Dolby: DRC is *"relative to and based on … the
  dialnorm metadata parameter"*, i.e. the slow level sets the null band's position *once*, and the fast
  stage references it.
  **Correct order in the standards' offline form:** measure integrated loudness of the
  **unmodified** input; the level-equaliser runs on the signal; the absolute gain and the
  equaliser are **not** in a feedback loop with each other.
- **This extension's live wiring (judgment, stated as such).** The slow absolute loop
  measures the **levelled** signal, not the unmodified input: the absolute gain must land the
  program the listener actually hears on the target, and the leveller's net lift would
  otherwise leave the output off-target. The anti-oscillation rule is kept by driving the
  leveller **feedforward from the RAW input only** — the levelling gain is a pure function
  of raw-input short-term vs raw-input integrated loudness, so the leveller never reads its
  own output (or the slow loop's) and the two loops cannot chase each other. The published
  citations above are the constraint; the levelled-signal measurement is the live
  implementation's answer to it, not a standard's sentence.
- **The slow loop's integration time must be long** (AES: 30 s–2 min; `RESEARCH_LOUDNESS.md` §4.3 already
  states the 400 ms-block structure means a *fast* gain "changes the very signal you are measuring").
- **The limiter is last, and the peak is a hard constraint on the slow loop's boost** — Spotify's
  published headroom rule (§1.4) and ReplayGain's combined scale factor (`RESEARCH_LOUDNESS.md` §3.3)
  are the same shape: `gain = min(target − measured, ceiling − peak)`.
- **Offline/iterative beats live for the levelling stage** (EBU Tech 3343 §9.4.2, quoted in §2.5), because
  a real-time leveller "react[s] without knowledge of the coming audio signal".

**The documentation does not state** a single canonical coefficient set or block size for the levelling
stage; the standards fix the *structure and bounds* (§2, §4), and leave the ratio/attack/release to the
encoder. The nearest published parameter sets remain Dolby's profiles (§2.1), Web Audio's compressor
defaults (`RESEARCH_LOUDNESS.md` §4.2), and EBU's LDR ≤ 5 LU bound.

---

## 4. The bounds that prevent "everything loud" (the anti-maximiser limits)

The owner's complaint that over-processing "made it worse" is answered by the published *limits* on the
levelling stage. All of these exist precisely to stop level equalisation becoming a loudness maximiser.

| Bound | Value | Source |
|---|---|---|
| **Maximum boost** | Film profiles **6 dB**; Music profiles **12 dB**; Speech **15 dB** | Dolby, §2.1 |
| **Boost ratio** | 2:1 (film/music), **5:1** (speech low level) | Dolby, §2.1 |
| **Null band** (no gain/attenuation) | **5 dB** (standard profiles), **20 dB** (light profiles) | Dolby, §2.1 |
| **Cut ratio** (near-limiting) | **20:1** in the cut range (standard profiles); 2:1 (light) | Dolby, §2.1 |
| **Loudness-to-Dialogue Ratio cap** | **≤ 5 LU**; "within 5 LU, no dynamic adaptation needs to be performed" | EBU R 128 s4 §2.5 |
| **Maximum Short-term Loudness** (short-form) | **−18.0 LUFS (+5.0 LU** relative to the −23 LUFS target) | EBU R 128 s1: <https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s1v3_0.pdf> |
| **Maximum loudness** (OTT/OVD) | short-form and long-form **−16 ±1 LKFS/LUFS** | AES TD1006 Table 3 |
| **Maximum true peak** | **−1 dBTP** (EBU R 128, AES TD1006/TD1008, Apple); **−2 dBTP** (ATSC A/85, Netflix) | §1.2, §1.4 |
| **Integrated-loudness floor** | keep content **above −20 LUFS** "to prevent vulnerable players from sounding too quiet even at maximum gain" | AES TD1008, §1.2 |
| **Limiter ballistics** | engage at **−1 dB (sample)**, **5 ms attack**, **100 ms decay** (Spotify Loud mode) | Spotify, §1.4 |
| **Headroom left for lossy encode** | **1 dB** below full scale | Spotify, §1.4 |

**The interaction with the limiter ceiling** is published as a hard constraint: AES TD1008 — *"When
upward normalization would cause clipping, peak limiting is required to protect the channel, but can
alter the sound of the content."* EBU R 128 s2 clause k — *"appropriate True-peak Limiting … should be
performed in the device, if a Target Level higher than −23.0 LUFS results in insufficient headroom to
faithfully reproduce the programme."* And EBU R 128 s4 case d — *"Headroom is slightly decreased, so
**True-peak limiting will typically be necessary** for most distribution paths."* The design rule the
sources imply: **choose the program target low enough that the levelling stage's boost still fits under
the ceiling** — which is §1.5's argument for a target below the platforms' ≈−14.

**These are the numbers that answer "everything loud is worse".** The Dolby maximum boosts (6/12/15 dB)
bound how far quiet is lifted; the 20:1 cut bounds how hard loud is pulled; the null band stops ordinary
program being touched at all; the LDR ≤ 5 LU bounds the total within-program change; the −1/−2 dBTP
ceiling bounds the sum; and the −20 LUFS floor stops the slow loop from silencing content.

---

## 5. Is frequency-domain equalisation part of any comfort profile?

**Verdict: yes — a distinct, named family exists, and it is *separate from* the level-equalisation
profiles.** It is called **"loudness compensation" / "loudness equalisation"**, it is grounded in the
ISO 226 equal-loudness contours, and it applies **frequency-dependent** gain as a function of playback
level. The *night/reduce-loud-sounds/level* profiles of §2 are **not** documented as frequency-dependent.

### 5.1 The profiles that DO apply frequency shaping, with what is published

- **ISO 226:2023** (the underlying standard): <https://www.iso.org/standard/83117.html>
  > "This document specifies combinations of sound pressure levels and frequencies of pure continuous
  > tones which are perceived as equally loud by human listeners. … The data are given in graphical form
  > in Annex A and in numerical form in Annex B for the preferred frequencies in the one-third-octave
  > series from 20 Hz to 12 500 Hz."
  The standard is paywalled; the formula and its parameters are public:
  `L_f = 10/α_f · lg[(4·10⁻¹⁰)^(0.3−α_f)·(10^(0.03 L_N) − 10^0.072) + 10^(α_f(T_f+L_U)/10)] − L_U`, with
  `α_f` the exponent for loudness perception, `L_U` the linear transfer function (0 dB at 1 kHz), and
  `T_f` the threshold of hearing, tabulated at the 29 preferred third-octave frequencies
  (<https://dael.euracoustics.org/confs/fa2023/data/articles/000585.pdf>; the phonometry reference quotes
  the same Formula (1)/(2) and the Annex B table). ISO 226:2023 differs from ISO 226:2003 by ≤0.6 dB.

- **Dolby Volume — "Volume Modeler" (Dolby's own product documentation).** This is a published
  frequency-domain comfort feature:
  > "Dolby Volume also addresses the ear's changing sensitivity to different frequencies at different
  > playback levels. At normal home listening levels … the listener does not hear the original tonal
  > balance … Dolby Volume monitors the difference between reference level and the listener's actual
  > listening level, and **dynamically fine-tunes the level in each channel** …"
  > "The Volume Modeler … analyzes the incoming audio, **groups similar frequencies into critical bands,
  > and applies appropriate amounts of gain to each.** You'll always hear the correct tonal balance,
  > whether at whisper level or dance-party loud."
  > (<https://professional.dolby.com/siteassets/pdfs/dolby-volume-tech-paper.pdf>;
  > <https://professional.dolby.com/siteassets/tv/home/dolby-atmos/dolby-atmos-for-sound-bar-applications.pdf>)

- **MPEG-D DRC — a normative loudness-equalisation tool.** This is the standardised form:
  > "The DRC tool provides support for **loudness equalization, sometimes called 'loudness
  > compensation'**, that can be applied to compensate for the effect of the playback level on the
  > spectral balance. For this purpose, time-varying loudness information can be recovered from DRC gain
  > sequences to dynamically control the compensation module. While the compensation module is out of
  > scope, the interface describes in which frequency ranges the loudness information should be applied.
  > A flexible tool for **generic metadata-controlled equalization** is provided. …"
  (ISO/IEC 23003-4:2025 Introduction; the standard has an informative **Annex H (Equalization)** — see its
  published table of contents at <https://cdn.standards.iteh.ai/samples/89036/…>.)

- **Audyssey Dynamic EQ (vendor documentation).** The Denon/Audyssey docs state it is an equal-loudness
  loudness-compensation feature with an explicit reference-level offset:
  > "Dynamic EQ – As the volume is turned up or down, Audyssey Dynamic EQ maintains consistent bass
  > response, tonal balance, and surround impression."
  > "Audyssey Dynamic EQ uses the **standard film mixing level** as its reference. … Dynamic EQ supports a
  > **Reference Level Offset of 5 dB, 10 dB and 15 dB**."
  (<https://audyssey.com/Audyssey%20MultEQ-X%20User%20Guide%20v1.6.pdf>;
  <https://manuals.denon.com/avrx2300w/na/en/GFNFSYphwaueoj.php>)

### 5.2 The profiles that do NOT document frequency shaping

- **Dolby AC-3 DRC profiles (§2.1):** the documented operation is *"gain or attenuation"* / *"gain
  words"* applied to the signal; the guide **does not state** frequency-dependent shaping for them.
- **Windows "Loudness Equalization" (§2.3):** *"simulates human hearing to accurately measure the
  loudness"* — the hearing model is the **detector**; the output is *"dynamic gain adjustment"*
  (wideband). It **does not state** frequency-dependent output shaping.
- **Apple "Reduce Loud Sounds" (§2.4):** **publishes no algorithm**; "does not state" whether it shapes
  frequency.

### 5.3 What this decides

**"Equalisation" in the owner's sentence is ambiguous, and the sources split it into two different
things:**

1. **Level equalisation** — quiet up, loud down, wideband. That is the §2 profiles (Dolby / Windows /
   Apple / EBU LDR) and the "levelling" stage of §3.
2. **Tonal / loudness-compensation equalisation** — frequency-dependent gain as a function of playback
   level, per ISO 226. That is Dolby Volume Modeler / MPEG-D loudness equalisation / Audyssey Dynamic EQ
   (§5.1), and it is a **separate feature with its own parameters, not part of any night/reduce-loud
   profile.**

So "does equalisation add a filter stage?" — **only if "equalisation" means the second thing.** A comfort
*level* normalizer (the §2 profiles) is wideband; a *loudness-compensation* feature (the §5.1 profiles) is
frequency-dependent. They are distinct published features and the documentation treats them as such.

---

## 6. The instant slider — a user trim is not a target change

**The distinction the sources support:** a **user gain applied to the output is instantaneous by
construction**; **retargeting the normalizer is inherently slow** because the normalizer's gain is a
function of a long-window measurement (§3.2). They are different quantities and must not be wired
together.

- **The user-gain quantity exists as a separate published control in every reference implementation.**
  - ReplayGain 2.0: the stored track/album gain is applied with a *separate* user **pre-amp**; the
    combined scale factor is `min(10^((RG + G_pre-amp)/20), 1/peak_amplitude)`
    (`RESEARCH_LOUDNESS.md` §3.3).
  - `ffmpeg loudnorm` exposes **`offset`** as its own option: *"Set offset gain. **Gain is applied before
    the true-peak limiter.** Range is −99.0 – +99.0. Default is +0.0."*
    (<https://ffmpeg.org/ffmpeg-filters.html#loudnorm>)
  - Spotify publishes a user-level control that is *not* the normalisation target: "user levels **Loud
    −11 / Normal −14 / Quiet −19**" (`RESEARCH_LOUDNESS.md` §3.2).
- **A gain change made audible-free is published Web Audio behaviour, not a normalizer property.** The a-rate
  `GainNode.gain` is what prevents **zipper noise**, and the smoothing primitives are documented:
  *"an `AudioParam` … a-rate parameter which means that its values MUST be taken into account on a
  per-audio-sample basis"*; the render quantum is **128 frames** by default, so a stepped per-block gain
  change produces a **375 Hz buzz at 48 kHz** — audible (`RESEARCH_LOUDNESS.md` §5.1, §5.2 quote the spec at
  <https://webaudio.github.io/web-audio-api/>). The fix the spec supports: **`setTargetAtTime` /
  `linearRampToValueAtTime`**, or a per-sample geometric/linear ramp inside a worklet
  (`RESEARCH_LOUDNESS.md` §5.2).
- **What makes the change instantly audible without artefacts:** the trim is applied at the **output**
  (the user's own scalar, e.g. ffmpeg's `offset`, ReplayGain's pre-amp), and its slew is a **short ramp**
  (milliseconds), not the normalizer's multi-second integration. The slow loop's slew is the *opposite*
  of instant — `RESEARCH_LOUDNESS.md` §5.2 and the worklet use multi-second time constants; AES's active
  controller uses **30 s–2 min**. **A slider wired to the target therefore necessarily "gradually goes
  up"; a slider wired to the output trim acts at once.** That is the mechanism behind the owner's
  complaint, and the documentation of *both* paths exists (§6 here; `RESEARCH_LOUDNESS.md` §5.2).

**The documentation does not state** a single canonical slew rate constant for a user trim; only that a
per-block (128-frame) step is audible and that per-sample smoothing is the spec-provided remedy.

---

## 7. Everything marked `UNVERIFIED` or "does not state"

`UNVERIFIED` (claim is not in a primary source; scope given):

- **YouTube's numeric target (≈−14 LUFS) and its attenuate-only behaviour** — not published by YouTube;
  community measurement. Scope: the *number and the down-only rule*. The *existence* of Stable
  Volume/Voice boost and that music is excluded **is** documented (§1.4).
- **TikTok's target and normalisation behaviour** — no specification exists; all numbers are third-party.
- **Facebook/Instagram's numeric target and whether it boosts or only attenuates** — Meta documents the
  mechanism (target + DRC by metadata) but publishes no number and does not state direction.
- **X and Reddit loudness behaviour** — nothing located.
- **Apple Music's −16 LUFS "Sound Check" figure** — the figure appears in third-party tables; I could not
  verify it in an Apple document. Apple's verified numbers are the Asset Guide's −18 LKFS (immersive/5.1)
  and Apple Podcasts' −16 LKFS ±1.
- **Netflix −27 LKFS ±2 dialog-gated and 79/82 dB SPL** — quoted from third-party summaries of Netflix's
  Partner Help Center page, which did not render to a plain client. Scope: the numbers only; the *policy*
  (dialogue-anchored loudness spec) is corroborated across sources.

"The documentation does not state":

- A distinct **Dolby "Night"** profile with its own numbers — "Night/Late Night" is a consumer label for
  RF/Line-mode DRC (§2.2).
- Numeric thresholds/ratios/null-band/max-boost for **Windows Loudness Equalization** (§2.3) and any
  algorithm at all for **Apple Reduce Loud Sounds** (§2.4).
- A **DRC profile or target in ITU-R BS.1770** — it is measurement-only (§2.6).
- A single canonical **coefficient set / block size for the levelling stage** in the standards (§3.2).
- Frequency-dependent shaping for the **Dolby AC-3 DRC profiles**, **Windows Loudness Equalization**, or
  **Apple Reduce Loud Sounds** (§5.2).
- A canonical **slew constant for a user trim** (§6).

Also recorded: a **discrepancy across Dolby's own documents** — *A Guide to Dolby Metadata* gives the
Speech null band as 5 dB and the film null bands as 5/20 dB, while the *Dolby Digital Professional
Encoding Guidelines* prose says Speech uses "10 dB" and the film bands are "10 and 20 dB wide" (§2.1).

---

## Sources

Standards and specifications (primary):

- ITU-R BS.1770-4 / -5 — cited via `RESEARCH_LOUDNESS.md` §1–2.
- ITU-T H.870 (03/2022), *Guidelines for safe listening devices/systems*: <https://www.itu.int/rec/T-REC-H.870-202203-I/en>
- EBU R 128 (2023): <https://tech.ebu.ch/docs/r/r128.pdf>
- EBU R 128 s1 (short-form): <https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s1v3_0.pdf>
- EBU R 128 s2 (streaming): <https://tech.ebu.ch/docs/r/r128s2.pdf> / <https://tech.ebu.ch/publications/r128s2>
- EBU R 128 s4 (cinematic content): <https://tech.ebu.ch/docs/r/r128s4.pdf>
- EBU Tech 3343 (production guidelines): <https://tech.ebu.ch/docs/tech/tech3343.pdf>
- EBU Tech 3344 (distribution & reproduction) — cited by R 128 s2 clause k (access: tech.ebu.ch/docs/tech/tech3344.pdf)
- ATSC A/85: <https://www.atsc.org/wp-content/uploads/2026/07/A85-2026-07.pdf>
- AES TD1008 v3.13: <https://aes.org/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf>
- AES TD1006: <https://aes.org/wp-content/uploads/2024/01/AESTD1006_1_17_10.pdf>
- ANSI/CTA-2075 / -2075.1 (device loudness management incl. DRC): <https://www.cta.tech/standards/ansicta-2075/>
- ISO/IEC 23003-4 (MPEG-D DRC): <https://www.iso.org/standard/89036.html> / <https://www.mpeg.org/standards/MPEG-D/4/>
- ISO 226:2023: <https://www.iso.org/standard/83117.html>
- W3C Web Audio API: <https://webaudio.github.io/web-audio-api/>

Vendor / platform documentation:

- Dolby, *A Guide to Dolby Metadata* (Appendix D, DP570 manual) — mirrored: <http://www.aesnashville.org/PDFs/Technical/Dolby/Dolby%20Metadata.pdf>; Dolby Hybrik *Dolby Audio Overview*: <https://docs.hybrik.com/tutorials/dolby_audio>
- Dolby, *Dolby Digital Professional Encoding Guidelines* (prose descriptions of the DRC profiles) — mirror: <https://www.yumpu.com/en/document/view/18800037/dolby-digital-professional-encoding-guidelines-educypedia-the->
- Dolby Professional Support, *A Guide to Dolby Metadata*: <https://professionalsupport.dolby.com/s/article/A-Guide-to-Dolby-Metadata>
- Dolby, *Dolby Volume* tech paper: <https://professional.dolby.com/siteassets/pdfs/dolby-volume-tech-paper.pdf>
- Dolby, *Dolby Volume* datasheet: <https://professional.dolby.com/siteassets/pdfs/dolby-volume-datasheet.pdf>
- Dolby, *Dolby Atmos for sound bar applications* (Volume Leveler/Modeler/Intelligent Equalizer): <https://professional.dolby.com/siteassets/tv/home/dolby-atmos/dolby-atmos-for-sound-bar-applications.pdf>
- Microsoft Learn, *Loudness Equalization DSP*: <https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/loudness-equalization-dsp>
- Apple Support, *Change audio settings on Apple TV 4K* (Reduce Loud Sounds): <https://support.apple.com/guide/tv/change-audio-settings-atvba773c3c9/tvos>
- Apple, *HLS authoring specification*: <https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html>
- Apple, *Video and Audio Asset Guide*: <https://help.apple.com/itc/videoaudioassetguide/en.lproj/static.html>
- Apple Podcasts, *Audio requirements*: <https://podcasters.apple.com/support/893-audio-requirements>
- Spotify for Artists, *Loudness normalization*: <https://support.spotify.com/us/artists/article/loudness-normalization/>
- YouTube Help, *Control video volume* (Stable volume / Voice boost): <https://support.google.com/youtube/answer/14106294>
- YouTube Help, *Video & audio quality enhancements*: <https://support.google.com/youtube/answer/16619284>
- Meta engineering, *Why xHE-AAC is being embraced at Meta*: <https://engineering.fb.com/2023/04/11/video-engineering/high-quality-audio-xhe-aac-codec-meta/>
- Fraunhofer IIS, *xHE-AAC white paper* (MPEG-D DRC effect types, target loudness): <https://www.digitalmedia.fraunhofer.de/content/dam/dcinema/en/documents/FraunhoferIIS_xHE-AAC_Whitepaper.pdf>
- Audyssey, *MultEQ-X User Guide* (Dynamic EQ, Reference Level Offset): <https://audyssey.com/Audyssey%20MultEQ-X%20User%20Guide%20v1.6.pdf>
- Denon, *AVR-X2300W — Audyssey*: <https://manuals.denon.com/avrx2300w/na/en/GFNFSYphwaueoj.php>

Reference implementations and tools:

- ffmpeg `loudnorm`: <https://ffmpeg.org/ffmpeg-filters.html#loudnorm>
- ReplayGain 2.0 spec — cited via `RESEARCH_LOUDNESS.md` §3.3.

Access-restricted / secondary (explicitly labelled in the text above):

- Netflix Partner Help Center, *Netflix Loudness and Dynamic Range*: <https://partnerhelp.netflixstudios.com/hc/en-us/articles/360001794307-Netflix-Loudness-and-Dynamic-Range> — did not render to a plain client; the −27 LKFS ±2 / 79–82 dB SPL figures are quoted from third-party summaries and labelled secondary.
- ITU-R BS.1864 — access-restricted; the "normal dialogue" definition is quoted via EBU Tech 3343 §9.4.
- Jason (Junghun) Lee et al., *Modelling the ISO 226:2023 equal-loudness-level contours* — used for the ISO 226 formula and parameters: <https://dael.euracoustics.org/confs/fa2023/data/articles/000585.pdf>
- phonometry reference, *ISO 226:2023 Formula (1)/(2)* — third-party implementation doc used only to point at the standard's own clauses: <https://docs.jmrp.io/phonometry/reference/theory/perception/>
