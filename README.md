# Skills Store

Public distribution repo for AgentWorkplace skills.

This repo is designed for your current AgentWorkplace skills storefront flow:
- Frontend loads one or more remote `catalog.json` URLs.
- Backend fetches entries, validates package hashes, and installs skills into `CODEX_HOME/skills/<slug>/SKILL.md`.

## Repository layout

```text
skills-store/
  catalog/
    skills.manifest.json   # Source-of-truth metadata for packaging
    stable.json            # Generated remote catalog for stable channel
    beta.json              # Generated remote catalog for beta channel
  skills/
    .curated/              # Curated skills
    .system/               # System skills
    .experimental/         # Optional beta/experimental skills
  scripts/
    build-catalog.mjs      # Validate, package, hash, and generate catalogs
```

## Add a skill

1. Add your skill folder under one of:
   - `skills/.curated/<slug>/`
   - `skills/.system/<slug>/`
   - `skills/.experimental/<slug>/`
2. Ensure each skill directory contains `SKILL.md`.
3. Add a manifest scaffold entry:

```bash
npm run manifest:add -- skills/.curated/<slug>
```

4. Update manifest metadata as needed (`version`, `summary`, `description`, `icon`).
5. Run validation:

```bash
npm run manifest:check
```

## Manifest format

`catalog/skills.manifest.json` is the source of truth. Example:

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "id": "gh-fix-ci",
      "slug": "gh-fix-ci",
      "path": "skills/.curated/gh-fix-ci",
      "version": "1.0.0",
      "channel": "stable",
      "title": "GH Fix CI",
      "summary": "Fix failing GitHub CI actions.",
      "description": "Inspect failed checks, identify root cause, and ship a verified fix.",
      "icon": "🐙"
    }
  ]
}
```

Required:
- `id`
- `slug`
- `path`
- `version` (semver)

Optional (auto-filled if omitted):
- `skillName` (defaults to `name` from `SKILL.md` frontmatter, else `slug`)
- `title` (defaults from slug)
- `summary` (defaults to description)
- `description` (defaults to `description` frontmatter, else title)
- `icon` (defaults to `🧠`)
- `channel` (`stable` default, or `beta`)
- `assetName` (defaults to `<slug>-<version>.zip`)

Manifest tooling:
- `npm run manifest:add -- <skill-dir>`: append a scaffolded entry.
- `npm run manifest:check`: fail if any `skills/*/*/SKILL.md` is not in the manifest.

## Build and publish

Generate ZIP assets + channel catalogs:

```bash
node scripts/build-catalog.mjs --repo <owner/repo> --tag <tag>
```

Example:

```bash
node scripts/build-catalog.mjs --repo your-org/skills-store --tag v1.0.0
```

Outputs:
- `dist/packages/*.zip`
- `dist/catalog/stable.json`
- `dist/catalog/beta.json`
- `dist/catalog/checksums.txt`
- Also updates tracked `catalog/stable.json` and `catalog/beta.json`.

The release workflow (`.github/workflows/release.yml`) runs on tags (`v*`) and uploads those assets.

## AgentWorkplace configuration

Point AgentWorkplace at your hosted catalogs, for example:

```bash
VITE_SKILLS_CATALOG_URLS=https://raw.githubusercontent.com/<owner>/<repo>/main/catalog/stable.json,https://raw.githubusercontent.com/<owner>/<repo>/main/catalog/beta.json
```

Or use release assets if you prefer immutable catalog URLs per release.
