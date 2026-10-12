# Local context for `apps/ui/src/components/settings`

Keep settings changes modular. The settings surfaces rely on hook-driven state and small presentational pieces, so avoid collapsing logic into large monolithic components.

## SettingsWorkerPresets

`SettingsWorkerPresets.tsx` is the whole "Worker presets" tab (id `presets`, help context `settings.presets`). It edits one flat global list of `WorkerPreset` rows.

- `GET /api/settings/worker-presets` loads the list; one Save `PUT`s the whole list back as `{ version: 2, presets }`. There are no per-row requests.
- Names must pass `isWorkerPresetName` from `@forge/protocol` and be unique; errors are shown inline on the row.
- The model column reuses `specialists/ModelIdSelect.tsx` (its helpers live in `specialists/utils.ts`). Reasoning choices come from the manager-selection catalog's `reasoningOptions` for the chosen model.
- The layout follows the `@container/settings` width: one grid row per preset when wide, stacked labelled fields when narrow. Do not add a fixed max-width.

There are no work modes, rosters, tiers or per-project delegation settings. Do not reintroduce them here or in the composer.

State is local to the component. Do not introduce external state libraries for this area.

## General

Prefer small presentational components and focused hooks over widening shared state across the settings pages.
