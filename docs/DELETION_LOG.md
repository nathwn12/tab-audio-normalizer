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
