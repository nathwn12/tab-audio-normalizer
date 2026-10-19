# Code Deletion Log

## [2026-05-04] Refactor Session — Dead Code Cleanup

### Unused Exports Removed
- `shared.js`: `MIN_GAIN_DB`, `MAX_GAIN_DB`, `GAIN_STEP_DB` — exported but never imported by any runtime file (content-script, background, popup) or test. Values are still used internally by `clampGainDb()` — only the public export was removed.

### Impact
- Files modified: 1 (`shared.js`)
- Lines of code removed: 3 (export lines)
- Bundle size impact: negligible

### Testing
- All unit tests pass (`node tests/shared.test.js`)
- No runtime code references these exports

### Notes
- `migrateActiveSites` and `setSiteEnabled` remain exported — only used by gitignored tests but kept for test coverage.
- `normalizeGainDb` in `page-hook.js` is a semantic duplicate of `clampGainDb` in `shared.js`, but this duplication is unavoidable: `page-hook.js` runs in MAIN world and cannot import `shared.js` (ISOLATED world).
- `MIN_GAIN_DB` / `MAX_GAIN_DB` are independently defined in 3 files (`shared.js`, `page-hook.js`, `normalizer-worklet.js`) — necessary due to separate execution contexts.

## [2026-05-31] Refactor Session — Dead Code & Orphaned File Cleanup

### Orphaned File Deleted
- `nul` (root) — accidentally created file containing shell error output (`dir: cannot access 'package.json': No such file or directory`). Not git-tracked, removed from filesystem.

### Unused Exports Removed
- `shared.js`: `migrateLegacyState` — exported but never imported or called by any source file, test, or runtime consumer. Its function signature referenced from `global.d.ts` was also removed.
- `shared.js`: `onStorageChanged` — exported but never imported or called by any source file, test, or runtime consumer. Its function signature referenced from `global.d.ts` was also removed.

### Impact
- Files modified: 2 (`shared.js`, `global.d.ts`)
- File deleted: 1 (`nul` — untracked)
- Lines of code removed: 32 (28 in shared.js, 2 in global.d.ts)
- Bundle size impact: negligible (both functions are dead code never executed)

### Verification
- TypeScript typecheck (`tsc --noEmit`): passes (0 errors)
- Unit tests (`node tests/shared.test.js`): same results as baseline (4 pass / 7 fail — all failures pre-existing)
- No runtime behavior changed — removed exports were never referenced by any runtime consumer

## [2026-05-31] Refactor Session — Dead Variable & .gitignore Audit

### Dead Code Removed
- `background.js`: `PENDING_SESSION_KEY` constant (line 15) — declared as `const PENDING_SESSION_KEY = 'pendingSessionStates'` but never referenced anywhere. Only grep match is the declaration itself. The Map `pendingSessionStates` is used directly without the constant.

### Dead Code Investigated but Confirmed Alive
- `shared.js`: `migrateActiveSites`, `setSiteEnabled`, `getLegacySiteKey` — exported but not used by any runtime extension file. However, `tests/shared.test.js` imports and tests them. Per previous session's note (2026-05-04), kept for test coverage.
- `shared.js`: `storageGet`, `storageSet` — not imported by any external file but used internally by `loadSiteState`/`saveSiteState`, which are used by `popup.js`.
- No orphaned files found beyond what was already cleaned.
- No consolidation opportunities across ISOLATED/MAIN world boundary.

### Unchanged (Investigated but Left Intact)
- `export {}` module markers in `background.js` and `popup.js` — kept for TypeScript module scoping; removal would risk syntax errors in specific browser extension contexts
- `console.log`/`console.warn`/`console.error` statements across all files — consistent, prefixed logging pattern intentionally left for extension debugging in production
- Protocol constants (`CHANNEL`, `PENDING_ATTR`) duplicated between `content-script.js` and `page-hook.js` — must match across separate execution contexts; consolidation would require shared module not feasible across ISOLATED/MAIN world boundary
- JSDoc `@type` annotations — all serve legitimate type-checking purposes for `checkJs` with `strictNullChecks: true`
- No commented-out code blocks found anywhere in source files

## [2026-10-18] Refactor Session — Post-Fix Dead Code Cleanup

### Unused Exports Removed
- `background.js`: `MIRROR_RECONCILED_KEY` (line 64) — defined as `const MIRROR_RECONCILED_KEY = 'tnMirrorReconciled'` but never referenced anywhere; the only grep match is the declaration itself. The per-site `site:<key>` record replaced the mirror-reconciled marker.
- `shared.js`: `reconcileMirrorIntoSettings` — zero callers in product code, tests, or QA. Its toggle-wins-`enabled` rule now lives in `migrateLegacyToRecord` (the surviving read-only migration). Its `global.d.ts` signature removed too.
- `shared.js`: `loadSiteState` — zero product callers; read `siteToggles` through `storageGet` only. The required legacy READ paths (`migrateLegacyToRecord`, `migrateActiveSitesOnce`, the legacy key normalisation, and every `siteSettings` / `activeSites` / `siteToggles` read in `background.js` / `content-script.js`) are untouched.
- `shared.js`: `storageGet` / `storageSet` — generic passthroughs with zero product callers (`storageGet`'s only caller was the deleted `loadSiteState`; `storageSet`'s only product caller was the already-deleted `saveSiteState` writer). Product code uses `chrome.storage.local` directly. Signatures removed from `global.d.ts`.

### Impact
- Files modified: 4 (`background.js`, `shared.js`, `global.d.ts`, plus `tests/setting-loss.test.js` recurrence test updated to assert absence instead of preservation)
- Lines of code removed: ~57 (1 in background.js, 48 in shared.js, 8 in global.d.ts)
- Bundle size impact: negligible (all removed symbols were dead code never executed)

### Verification
- TypeScript typecheck (`npm run typecheck`): passes (0 errors)
- Unit tests (`node tests/shared.test.js`, `node tests/setting-loss.test.js`): all pass, including the legacy-only-store migration test
- Live loop (`node qa/proof-live-persistence.cjs`): GREEN
- No runtime behavior changed — removed symbols were never referenced by any runtime consumer

## [2026-10-11] Refactor Session — Dead Export Cleanup

### Unused Exports Removed
- `shared.js`: `getExactHostKey` — exported but never imported or called by any source file, test, or runtime consumer. Its function signature referenced from `global.d.ts` was also removed.

### Impact
- Files modified: 2 (`shared.js`, `global.d.ts`)
- Lines of code removed: 14 (13 in shared.js, 1 in global.d.ts)
- Bundle size impact: negligible (function was dead code never executed)

### Verification
- TypeScript typecheck (`tsc --noEmit`): passes (0 errors)
- Unit tests (`node tests/shared.test.js`): all pass
- No runtime behavior changed — removed export was never referenced by any runtime consumer

## [2026-10-18] Refactor Session — Finding 5 cleanup (current removals + backfill)

### Dead Code Removed (current)
- `audio/normalizer-worklet.js`: `loudStep` — calculated as `Math.exp(gainStep)` and discarded via `void loudStep`. The per-sample gain ramp is driven entirely by `loudLog += gainStep` / `loudLin = Math.exp(loudLog)`; `loudStep` had no reader. Removed with its `void` use. Decision: remove (dead).
- `popup.js`: `statusTimer` — assigned from `setInterval(..., 750)` but never read or cleared. The 750 ms document-status poll is fire-and-forget; the popup document dies on close so there is nothing to clear. Removed the handle, kept the bare `setInterval` call. Decision: remove the variable, keep the poll (no behaviour change).
- `popup.js`: `saveGain(gainDb)` — thin wrapper around `saveGainInner(gainDb)` with no product caller (slider input, preset and reset all call `saveGainInner` directly; only tests called `saveGain`). Removed the wrapper from the shipped popup; `tests/setting-loss.test.js` now calls the product path `saveGainInner` directly (4 call sites). Decision: remove (test-only surface deleted from product).

### Backfill: earlier removals the log did not inventory
- `popup.js`: `queueGainSave(gainDb)` + `saveGainTimer` — 120 ms debounce queue plus the `unload` flush that drained it. Removed when the popup moved to immediate dispatch (every `input` sends its own field-level intent at once; RESEARCH §6 documents no flush-on-teardown facility, so a queued-but-unwritten value would be lost on close). No `unload` handler remains by design; every change is already sent on its `change`/`input` event. The `window.addEventListener('unload', ...)` clear of both timers went with the queue.
- `audio/normalizer-worklet.js`: pre-rewrite exponential-window helpers deleted in the gated ITU-R BS.1770-4 rewrite — top-level `lufsToInternalDb`, `powerToDb`, `applySoftKnee`, `pushTruePeak`, `createBiquadState`, `createKWeightingChannel`, `processBiquad`, `designHighPass`, `designHighShelf`, and the old processor methods they served (`updateMeasurement`, `computeTargetGain`, `calcLimiterTarget`, `getCeilingLinear`, `ensureBuffers`/`ensureFilters`/`ensurePeaks`, `weight`, `nextPowerOfTwo`). Replaced by `initKCoeffs` (exact libebur128 prototype derivation) and `buildInterpPhases` (97-tap Kaiser 4x oversampler) plus the block/gate/limiter path documented in the worklet header.

### Impact
- Files modified: 3 (`audio/normalizer-worklet.js`, `popup.js`, `tests/setting-loss.test.js` test-only call-site rename)
- Lines of code removed: ~10 product lines (loudStep decl+use, statusTimer decl, saveGain wrapper) plus the earlier queue/debounce (~15 lines) and worklet helpers (~100 lines in the rewrite) now inventoried
- Bundle size impact: negligible; all removed symbols were dead or test-only in product

### Verification
- TypeScript typecheck (`npm run typecheck`): passes (0 errors)
- Unit tests (`node tests/shared.test.js`, `node tests/setting-loss.test.js`): all pass (38/38 setting-loss incl. the new sequence test)
- Loudness harness (`node qa/loudness-verify.cjs`): OVERALL ALL PASS (incl. new TRANSITION + TELEMETRY rows)
- No runtime behavior changed except the intended Finding 1/2 fixes (mode-switch reset, output-aligned telemetry) covered by their own regression rows — the three Finding 5 removals are behaviour-preserving

## [2026-10-19] Release 5.4.1 — Blast Guard removal (owner-directed)

### Deleted per file
- `popup.html`: the `#blast-guard` toggle markup and label; the "Blast Guard adds stricter peak protection." sentence in the mode note.
- `popup.js`: `blastGuardToggle`, its `change` listener, `saveBlastGuard` / `saveBlastGuardInner`, `syncBlastGuardControlState`, the `blastGuard` branches in `applyControlState` / `requireStoredTruth` / `disableAll` / `refreshDocumentStatus`, the reset intent's `blastGuard: false` (reset is now a single-field `gainDb: 0` intent), and the two "Could not save Blast Guard" error strings.
- `shared.js`: `DEFAULT_BLAST_GUARD`; `blastGuard` in `normalizeSiteRecord` and the `migrateLegacyToRecord` defaults. The record is now `{ enabled, gainDb, seq, mirror }`.
- `background.js`: the `blastGuard` record field (schema JSDoc, sanitize/persist paths), legacy-intent extraction of `message.blastGuard`, and the migration/reconcile comparisons that included it.
- `content-script.js`: `state.blastGuard`, the `SET_BLAST_GUARD` posts (START payload, sync, transient), and the `blastGuard` comparisons/fallbacks.
- `page-hook.js`: `state.blastGuard`, the `SET_BLAST_GUARD` route, `setBlastGuard`, `updateSessionBlastGuard(s)`, and the `set-blast-guard` post to the worklet.
- `audio/normalizer-worklet.js`: the `set-blast-guard` inbound; `BLAST_GUARD_MAX_BOOST_DB` / `BLAST_GUARD_MAX_CUT_DB` / `BLAST_GUARD_DOWN_TC_SECONDS` / `BLAST_GUARD_CEILING_DB` / `BLAST_GUARD_CEILING_LINEAR` / `BLAST_GUARD_LIMITER_RELEASE_SECONDS` / `BLAST_GUARD_LIMITER_HOLD_SECONDS`; `this.blastGuard`, `blastGuardReleaseCoeff`, `blastGuardHoldFrames`, `blastHoldRemaining`; and every blastGuard branch site (ceiling choice, AGC boost/cut clamp, release-constant choice, limiter hold). The −2 dBTP ceiling and its clamps/release/hold are gone; the single −1 dBTP ceiling remains.
- `global.d.ts`: `DEFAULT_BLAST_GUARD` and the `blastGuard` fields on the site-record JSDoc types.
- `qa/loudness-verify.cjs`: the Blast Guard scenario rows, render variants, `blastClampVerdict`, and the "BLAST GUARD" constants/table (the release gate now exercises the single ceiling only).

### Legacy-read behavior
- Legacy per-site records that still carry `blastGuard` read cleanly: `normalizeSiteRecord` builds `{ enabled, gainDb, seq, mirror }` from the raw value and ignores unknown fields, and the background's whole-record read-modify-write drops `blastGuard` on the next write. Legacy messages carrying `blastGuard` are ignored by `extractIntentSet` (it reads only `enabled` / `gainDb`).

### Impact
- Files modified: 10 tracked (`audio/normalizer-worklet.js`, `background.js`, `content-script.js`, `global.d.ts`, `manifest.json`, `page-hook.js`, `popup.html`, `popup.js`, `qa/loudness-verify.cjs`, `shared.js`); 8 carry Blast Guard deletions, the other 2 are `manifest.json` (version 5.4.1) and the tracked acceptance harness.
- Removed surface: one popup control, one record field, one hook message type, one worklet inbound, one ceiling — no replacement.

### Verification
- Silent harnesses (rerun by the release): `node qa/loudness-verify.cjs`, `node qa/hook-guard-silent.cjs`
- Unit tests (rerun by the release): `node tests/shared.test.js`, `node tests/setting-loss.test.js`
- Typecheck (rerun by the release): `npm run typecheck`
- Audio Safety: no browser launched, no audio playback — the banned browser harnesses (`qa/extension-qa.cjs`, `qa/responsive-normalizer-qa.cjs`, `qa/worklet-equivalence-qa.cjs`) were not run.

### Notes
- Untracked harnesses left as-is: `qa/responsive-normalizer-qa.cjs` and `qa/worklet-equivalence-qa.cjs` (both banned from execution, both untracked) still contain Blast Guard scenario code, and the untracked silent analysis scripts (`qa/worklet-silent-analysis.cjs`, `qa/proof-*.cjs`) still name Blast Guard. None is a release gate.
