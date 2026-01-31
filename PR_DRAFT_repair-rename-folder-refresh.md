Title: hotfix: ensure folder contents visible after rename (shallow refresh + UX guard)

Summary
- Fixes a race where renaming a folder briefly shows an empty view even though files exist on disk.
- Keeps the targeted-refresh strategy (no full/root scans) and adds a user-visible `refreshing` state + limited retries to cover short FS visibility races.

Changes
- src/hooks/useFileOperations.ts — mark folder as `isRefreshing` during targeted refresh, add limited retry-with-backoff, preserve optimistic update behavior.
- src/App.tsx — ensure merged scan results clear transient `isRefreshing`; render a `EmptyFolderPlaceholder` when a folder is being refreshed.
- src/components/EmptyFolderPlaceholder.tsx — new small component for empty/refreshing UI (unit-tested).
- src/components/__tests__/EmptyFolderPlaceholder.spec.tsx — unit tests covering empty vs refreshing UI and refresh button.
- src/utils/translations.ts — add `refreshing` and helper copy.
- docs/RENAME_REFRESH_PERF_FIX.md — document UX fix and verification steps.
- vitest + test infra added (devDependency) and a smoke unit test included.

Why
- User-observed regression: folder appears empty after rename despite successful optimistic rename and backend scan attempts.
- Root cause: short-lived FS visibility / scheduling race between OS rename and directory listing; previously we retried but UI presented an empty state to users.

Behavioral notes (QA)
- Rename a folder that contains files: UI shows the new name immediately and displays a loading placeholder (`刷新中…`) for the folder instead of an empty state.
- The app retries shallow refresh up to 3 times with short backoff; if still empty it falls back to parent-level refresh (still avoids root scans).
- CPU/IO behaviour unchanged: still uses targeted scanFile first and avoids full rescans.

How to test (manual)
1. Start dev server with bench logs: $env:AURORA_BENCH='1'; npm run tauri:dev
2. In a large root, rename a folder that contains files.
3. Expected: folder shows files (or shows `刷新中…` then files). No manual refresh should be required in normal cases.

Rollback
- Revert the small UI changes in `useFileOperations.ts` and the `EmptyFolderPlaceholder` component.

Notes/TODO
- Consider adding telemetry to record how often retries are required in CI/dev to detect problematic FS drivers.
- Add an end-to-end test that exercises large-root rename scenarios (future work).
