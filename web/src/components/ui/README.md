# UI primitives

The shadcn CLI generates every component in this directory from the shadcn/ui
registry (the `base-nova` style declared in `web/components.json`) and copies it
here. Re-running `npx shadcn@latest add <name>` from `web/` offers to overwrite the
file, so keep hand edits out of it.

shadcn/ui is MIT licensed. [`THIRD_PARTY_NOTICES`](../../../../THIRD_PARTY_NOTICES)
records the license and the copyright holder, and covers
`web/src/hooks/use-mobile.ts` and `web/src/lib/utils.ts` under the same entry.
