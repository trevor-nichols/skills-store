#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNELS = new Set(["stable", "beta"]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultManifestPath = resolve(repoRoot, "catalog/skills.manifest.json");
const defaultOutputPath = resolve(repoRoot, "dist");
const trackedCatalogDir = resolve(repoRoot, "catalog");

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    manifest: defaultManifestPath,
    output: defaultOutputPath,
    repo: "",
    tag: "",
    manifestCheck: false,
    manifestAdd: "",
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--validate-only") {
      args.validateOnly = true;
      continue;
    }
    if (token === "--manifest-check") {
      args.manifestCheck = true;
      continue;
    }
    if (!token.startsWith("--")) {
      fail(`Unknown argument "${token}"`);
    }

    const [key, valueFromEquals] = token.split("=", 2);
    const value =
      valueFromEquals !== undefined ? valueFromEquals : index + 1 < argv.length ? argv[++index] : "";
    if (!value) {
      fail(`Missing value for ${key}`);
    }

    if (key === "--manifest") {
      args.manifest = resolve(repoRoot, value);
      continue;
    }
    if (key === "--output") {
      args.output = resolve(repoRoot, value);
      continue;
    }
    if (key === "--repo") {
      args.repo = value.trim();
      continue;
    }
    if (key === "--tag") {
      args.tag = value.trim();
      continue;
    }
    if (key === "--manifest-add") {
      args.manifestAdd = value.trim();
      continue;
    }
    fail(`Unknown argument "${key}"`);
  }

  return args;
}

function printHelp() {
  const text = `
Usage
  node scripts/build-catalog.mjs [options]

Options
  --validate-only        Validate manifest and skill folders without packaging.
  --manifest <path>      Path to skills manifest (default: catalog/skills.manifest.json).
  --output <path>        Output directory for packages/catalog artifacts (default: dist).
  --repo <owner/name>    GitHub repository slug for package URLs (required unless --validate-only).
  --tag <tag>            Release tag used in package URLs (required unless --validate-only).
  --manifest-check       Fail if any skills/<channel>/<slug>/SKILL.md is missing from manifest.
  --manifest-add <path>  Add a manifest entry scaffold for a skill directory.
  --help                 Show this help.
`;
  console.log(text.trim());
}

function parseJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`Unable to read manifest at ${path}: ${String(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Manifest is not valid JSON (${path}): ${String(error)}`);
  }
}

function readManifestDocument(manifestPath) {
  const manifest = parseJsonFile(manifestPath);
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported schemaVersion "${manifest.schemaVersion}". Expected 1.`);
  }
  if (!Array.isArray(manifest.skills)) {
    fail(`Manifest must contain a "skills" array.`);
  }
  return manifest;
}

function normalizeRelativePath(pathValue) {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function assertInsideRepo(path) {
  const rel = relative(repoRoot, path);
  const relParts = rel.split(/[\\/]/g);
  if (rel.startsWith("..") || relParts.includes("..") || isAbsolute(rel)) {
    fail(`Path "${path}" must stay within repository root.`);
  }
}

function parseFrontmatter(skillMdPath) {
  const body = readFileSync(skillMdPath, "utf8");
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {};
  }

  const result = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const parsed = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!parsed) {
      continue;
    }
    const key = parsed[1];
    const value = parsed[2].trim().replace(/^['"]|['"]$/g, "");
    result[key] = value;
  }
  return result;
}

function toTitle(slug) {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((value) => value.charAt(0).toUpperCase() + value.slice(1))
    .join(" ");
}

function normalizeRepo(repo) {
  if (!repo || !repo.includes("/")) {
    fail(`Invalid --repo value "${repo}". Expected "owner/name".`);
  }
  const [owner, name, ...rest] = repo.split("/");
  if (!owner || !name || rest.length > 0) {
    fail(`Invalid --repo value "${repo}". Expected "owner/name".`);
  }
  return `${owner}/${name}`;
}

function normalizeVersion(version, entryLabel) {
  const normalized = String(version ?? "").trim();
  if (!normalized) {
    fail(`${entryLabel}: version is required.`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    fail(
      `${entryLabel}: version "${normalized}" must follow semver like 1.2.3 or 1.2.3-beta.1.`,
    );
  }
  return normalized;
}

function validateSlug(value, entryLabel) {
  const slug = String(value ?? "").trim();
  if (!slug) {
    fail(`${entryLabel}: slug is required.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    fail(`${entryLabel}: slug "${slug}" must match /^[a-z0-9][a-z0-9-]*$/`);
  }
  return slug;
}

function normalizeChannel(value) {
  const channel = String(value ?? "stable").trim().toLowerCase();
  if (!CHANNELS.has(channel)) {
    fail(`Invalid channel "${channel}". Allowed channels: stable, beta.`);
  }
  return channel;
}

function buildManifestEntries(manifestPath) {
  const manifest = readManifestDocument(manifestPath);

  const seenIds = new Set();
  const seenSlugs = new Set();

  const entries = manifest.skills.map((entry, index) => {
    const entryLabel = `skills[${index}]`;
    const pathValue = String(entry.path ?? "").trim();
    if (!pathValue) {
      fail(`${entryLabel}: path is required.`);
    }

    const absoluteSkillPath = resolve(repoRoot, pathValue);
    assertInsideRepo(absoluteSkillPath);

    if (!existsSync(absoluteSkillPath)) {
      fail(`${entryLabel}: path does not exist (${pathValue}).`);
    }

    const skillMdPath = resolve(absoluteSkillPath, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      fail(`${entryLabel}: missing SKILL.md in ${pathValue}.`);
    }

    const frontmatter = parseFrontmatter(skillMdPath);
    const slug = validateSlug(entry.slug ?? basename(absoluteSkillPath), entryLabel);
    const id = String(entry.id ?? slug).trim();
    if (!id) {
      fail(`${entryLabel}: id is required.`);
    }

    if (seenIds.has(id.toLowerCase())) {
      fail(`${entryLabel}: duplicate id "${id}".`);
    }
    seenIds.add(id.toLowerCase());

    if (seenSlugs.has(slug.toLowerCase())) {
      fail(`${entryLabel}: duplicate slug "${slug}".`);
    }
    seenSlugs.add(slug.toLowerCase());

    const version = normalizeVersion(entry.version, entryLabel);
    const title = String(entry.title ?? toTitle(slug)).trim();
    const skillName = String(entry.skillName ?? frontmatter.name ?? slug).trim();
    const description = String(entry.description ?? frontmatter.description ?? title).trim();
    const summary = String(entry.summary ?? description).trim();
    const icon = String(entry.icon ?? "🧠").trim();
    const channel = normalizeChannel(entry.channel);
    const assetName = String(entry.assetName ?? `${slug}-${version}.zip`).trim();

    if (!title) {
      fail(`${entryLabel}: title cannot be empty.`);
    }
    if (!skillName) {
      fail(`${entryLabel}: skillName cannot be empty.`);
    }
    if (!summary) {
      fail(`${entryLabel}: summary cannot be empty.`);
    }
    if (!description) {
      fail(`${entryLabel}: description cannot be empty.`);
    }
    if (!assetName.endsWith(".zip")) {
      fail(`${entryLabel}: assetName must end with .zip.`);
    }
    if (assetName.includes("/") || assetName.includes("\\")) {
      fail(`${entryLabel}: assetName cannot contain path separators.`);
    }

    return {
      id,
      slug,
      skillName,
      title,
      summary,
      description,
      icon,
      version,
      channel,
      assetName,
      absoluteSkillPath,
      relativeSkillPath: relative(repoRoot, absoluteSkillPath),
    };
  });

  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function discoverSkillDirectories() {
  const skillsRoot = resolve(repoRoot, "skills");
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const channels = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(skillsRoot, entry.name));

  const discovered = [];
  for (const channelPath of channels) {
    const entries = readdirSync(channelPath, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    );
    for (const entry of entries) {
      const skillDir = resolve(channelPath, entry.name);
      const skillMdPath = resolve(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        continue;
      }
      discovered.push({
        absoluteSkillPath: skillDir,
        relativeSkillPath: normalizeRelativePath(relative(repoRoot, skillDir)),
      });
    }
  }

  return discovered.sort((left, right) => left.relativeSkillPath.localeCompare(right.relativeSkillPath));
}

function inferChannelFromSkillPath(relativeSkillPath) {
  if (relativeSkillPath.startsWith("skills/.experimental/")) {
    return "beta";
  }
  return "stable";
}

function resolveSkillDirectory(inputPath) {
  const normalized = String(inputPath ?? "").trim();
  if (!normalized) {
    fail(`--manifest-add requires a non-empty path.`);
  }
  const absoluteSkillPath = resolve(repoRoot, normalized);
  assertInsideRepo(absoluteSkillPath);
  if (!existsSync(absoluteSkillPath)) {
    fail(`Skill directory does not exist: ${normalized}`);
  }
  let stat;
  try {
    stat = statSync(absoluteSkillPath);
  } catch (error) {
    fail(`Unable to inspect skill path ${normalized}: ${String(error)}`);
  }
  if (!stat.isDirectory()) {
    fail(`Skill path must be a directory: ${normalized}`);
  }
  const skillMdPath = resolve(absoluteSkillPath, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    fail(`Missing SKILL.md in ${normalized}`);
  }
  return absoluteSkillPath;
}

function makeManifestEntryFromSkillPath(skillDirPath) {
  const relativeSkillPath = normalizeRelativePath(relative(repoRoot, skillDirPath));
  const frontmatter = parseFrontmatter(resolve(skillDirPath, "SKILL.md"));
  const slug = validateSlug(basename(skillDirPath), "--manifest-add");
  const title = toTitle(slug);
  const skillName = String(frontmatter.name ?? slug).trim();
  const description = String(frontmatter.description ?? title).trim();
  const summary = description;
  const channel = inferChannelFromSkillPath(relativeSkillPath);

  return {
    id: slug,
    slug,
    path: relativeSkillPath,
    version: "1.0.0",
    channel,
    title,
    summary,
    description,
    icon: "🧠",
    skillName,
  };
}

function addManifestEntry(manifestPath, skillInputPath) {
  const existing = buildManifestEntries(manifestPath);
  const manifest = readManifestDocument(manifestPath);
  const skillDirPath = resolveSkillDirectory(skillInputPath);
  const nextEntry = makeManifestEntryFromSkillPath(skillDirPath);

  const normalizedPath = normalizeRelativePath(nextEntry.path).toLowerCase();
  if (existing.some((entry) => normalizeRelativePath(entry.relativeSkillPath).toLowerCase() === normalizedPath)) {
    fail(`Manifest already contains path ${nextEntry.path}`);
  }
  if (existing.some((entry) => entry.id.toLowerCase() === nextEntry.id.toLowerCase())) {
    fail(`Manifest already contains id ${nextEntry.id}`);
  }
  if (existing.some((entry) => entry.slug.toLowerCase() === nextEntry.slug.toLowerCase())) {
    fail(`Manifest already contains slug ${nextEntry.slug}`);
  }

  const nextSkills = [...manifest.skills, nextEntry].sort((left, right) =>
    String(left.id ?? "").localeCompare(String(right.id ?? "")),
  );
  writeJson(manifestPath, {
    ...manifest,
    skills: nextSkills,
  });
  buildManifestEntries(manifestPath);
  console.log(`Added manifest entry for ${nextEntry.path} (${nextEntry.id}).`);
}

function runManifestCoverageCheck(manifestPath) {
  const entries = buildManifestEntries(manifestPath);
  const manifestPaths = new Set(
    entries.map((entry) => normalizeRelativePath(entry.relativeSkillPath).toLowerCase()),
  );
  const discovered = discoverSkillDirectories();
  const missing = discovered.filter(
    (entry) => !manifestPaths.has(normalizeRelativePath(entry.relativeSkillPath).toLowerCase()),
  );

  if (missing.length > 0) {
    const lines = missing
      .map(
        (entry) =>
          `  - ${entry.relativeSkillPath} (add via: node scripts/build-catalog.mjs --manifest-add ${entry.relativeSkillPath})`,
      )
      .join("\n");
    fail(
      `Manifest coverage check failed.\nMissing ${missing.length} skill(s) from catalog/skills.manifest.json:\n${lines}`,
    );
  }

  console.log(`Manifest coverage check passed: ${discovered.length} discovered, ${entries.length} manifest entries.`);
}

function ensureZipAvailable() {
  const check = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (check.status !== 0) {
    fail(`zip command is required but was not found in PATH.`);
  }
}

function packageSkill(skillPath, outputZipPath) {
  mkdirSync(dirname(outputZipPath), { recursive: true });
  rmSync(outputZipPath, { force: true });
  const result = spawnSync("zip", ["-qr", outputZipPath, "."], {
    cwd: skillPath,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`zip failed for ${skillPath}`);
  }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildCatalogEntry(entry, repo, tag, sha256) {
  return {
    id: entry.id,
    slug: entry.slug,
    skillName: entry.skillName,
    title: entry.title,
    summary: entry.summary,
    description: entry.description,
    icon: entry.icon,
    version: entry.version,
    packageUrl: `https://github.com/${repo}/releases/download/${tag}/${entry.assetName}`,
    sha256,
  };
}

function buildCatalogFiles(entries, outputPath, repo, tag) {
  const packagesDir = resolve(outputPath, "packages");
  const catalogDir = resolve(outputPath, "catalog");
  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(catalogDir, { recursive: true });

  const checksums = [];
  const byChannel = {
    stable: [],
    beta: [],
  };

  for (const entry of entries) {
    const packagePath = resolve(packagesDir, entry.assetName);
    packageSkill(entry.absoluteSkillPath, packagePath);
    const sha256 = sha256File(packagePath);
    const catalogEntry = buildCatalogEntry(entry, repo, tag, sha256);
    byChannel[entry.channel].push(catalogEntry);
    checksums.push(`${sha256}  packages/${entry.assetName}`);
  }

  for (const channel of Object.keys(byChannel)) {
    byChannel[channel].sort((left, right) => left.id.localeCompare(right.id));
    const fileBody = { skills: byChannel[channel] };
    writeJson(resolve(catalogDir, `${channel}.json`), fileBody);
    writeJson(resolve(trackedCatalogDir, `${channel}.json`), fileBody);
  }

  writeFileSync(resolve(catalogDir, "checksums.txt"), `${checksums.join("\n")}\n`, "utf8");

  return {
    packaged: entries.length,
    stable: byChannel.stable.length,
    beta: byChannel.beta.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const manifestPath = resolve(repoRoot, args.manifest);
  assertInsideRepo(manifestPath);

  if (args.manifestAdd) {
    addManifestEntry(manifestPath, args.manifestAdd);
  }
  if (args.manifestCheck) {
    runManifestCoverageCheck(manifestPath);
  }

  const entries = buildManifestEntries(manifestPath);

  if (args.validateOnly) {
    console.log(`Manifest valid: ${entries.length} skill(s) ready.`);
    return;
  }

  if (!args.repo && !args.tag && (args.manifestAdd || args.manifestCheck)) {
    return;
  }

  const repo = normalizeRepo(args.repo);
  const tag = String(args.tag ?? "").trim();
  if (!tag) {
    fail(`--tag is required unless --validate-only.`);
  }

  assertInsideRepo(args.output);
  ensureZipAvailable();

  const result = buildCatalogFiles(entries, args.output, repo, tag);
  console.log(
    `Built ${result.packaged} package(s). Catalog counts -> stable: ${result.stable}, beta: ${result.beta}.`,
  );
  console.log(`Artifacts: ${relative(repoRoot, args.output)}`);
}

main();
