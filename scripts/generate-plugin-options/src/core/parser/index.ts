import { Project, ts, type CallExpression } from 'ts-morph';
import pLimit from 'p-limit';
import { basename, dirname, normalize, join } from 'pathe';
import fse from 'fs-extra';
import fg from 'fast-glob';
import { Maybe } from 'true-myth';
import { asyncMap, asyncToArray, asyncFind } from 'iter-tools';
import {
  pipe,
  map,
  filter,
  pickBy,
  unique,
  fromEntries,
  isNonNull,
  entries,
  partition,
  reduce,
} from 'remeda';
import { match, P } from 'ts-pattern';
import { z } from 'zod';
import type { ReadonlyDeep, SetOptional } from 'type-fest';
import type { PluginConfig, ParsedPluginsResult } from '../../shared/types.js';
import { extractPluginInfo } from '../ast/extractor/plugin.js';
import { findDefinePluginSettings } from '../ast/navigator/plugin-navigator.js';
import { extractSettingsFromCall } from '../ast/extractor/settings-extractor.js';
import { CLI_CONFIG } from '../../shared/config.js';

const PLUGIN_SOURCE_FILE_PATTERNS = ['index.tsx', 'index.ts', 'settings.ts'] as const;
const TYPES_FILE_PATH = 'src/utils/types.ts';
const DISCORD_ENUMS_DIR = 'packages/discord-types/enums';
const TSCONFIG_FILE_NAME = 'tsconfig.json';
const PARALLEL_PROCESSING_LIMIT = 5;
const PROGRESS_REPORT_INTERVAL = 10;

const PLUGIN_DIR_SEPARATOR_PATTERN = /[-_]/;
const PLUGIN_FILE_GLOB_PATTERN = '*/index.{ts,tsx}';
const CURRENT_DIRECTORY = '.';

const ParsePluginsOptionsSchema = z.object({
  vencordPluginsDir: z.string().min(1).optional(),
  equicordPluginsDir: z.string().min(1).optional(),
});

/**
 * Build a ts-morph project that matches how Vencord and Equicord structure their sources.
 * We skip tsconfig crawling for speed, then cherry-pick the handful of files we rely on
 * (global types, Discord enums, shiki theme blobs). If either upstream repo shifts paths,
 * fix them here first or the extractor starts hallucinating defaults.
 */
/**
 * Creates a ts-morph Project configured for parsing Vencord/Equicord plugins.
 *
 * Configuration:
 * - Sets `tsConfigFilePath` to use compiler options (including baseUrl and paths) from tsconfig
 * - Sets `skipAddingFilesFromTsConfig: true` to avoid auto-adding all files (performance)
 * - Sets `skipFileDependencyResolution: true` to avoid auto-resolving imports (performance)
 * - Manually adds only the files we need (types, enums, plugins)
 *
 * Path mappings from tsconfig ARE used by the TypeChecker for symbol resolution,
 * even though we manually add files. This allows the TypeChecker to resolve imports
 * like `@api/Settings` and `@utils/types` using the path mappings.
 */
async function createProject(sourcePath: string): Promise<Project> {
  const tsConfigPath = normalize(join(sourcePath, TSCONFIG_FILE_NAME));
  const projectOptions: {
    skipAddingFilesFromTsConfig: boolean;
    skipFileDependencyResolution: boolean;
    skipLoadingLibFiles: boolean;
    compilerOptions: {
      target: number;
      module: number;
      jsx: number;
      allowJs: boolean;
      skipLibCheck: boolean;
    };
    tsConfigFilePath?: string;
  } = {
    // Equicord and Vencord repositories ship ten thousand+ files. Adding only the files we care
    // about keeps ts-morph from choking while still letting us hand-pick plugin sources later
    skipAddingFilesFromTsConfig: true,
    // Dependency resolution would drag in Discord's entire bundler output. We skip it and rely on
    // manual `project.addSourceFileAtPath` plus path mappings for anything we truly need
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    // Baseline compiler options; each repo's tsconfig still wins once we wire it in below
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.React,
      allowJs: true,
      skipLibCheck: true,
    },
  };

  // Point ts-morph at the repo's tsconfig so `baseUrl`, `paths`, and friends match the real build
  // Even with dependency resolution disabled, the checker respects those mappings
  if (await fse.pathExists(tsConfigPath)) {
    projectOptions.tsConfigFilePath = tsConfigPath;
  }

  const project = new Project(projectOptions);

  const typesPath = normalize(join(sourcePath, TYPES_FILE_PATH));
  if (await fse.pathExists(typesPath)) {
    project.addSourceFileAtPath(typesPath);
  }

  // Plugins love to reference `ActivityType.PLAYING` or `ChannelType.GUILD_TEXT` inside defaults
  // Rather than hardcoding numbers, pull in every file under packages/discord-types/enums so the
  // checker can resolve the actual enum values while we still keep dependency resolution disabled
  const discordEnumsDir = normalize(join(sourcePath, DISCORD_ENUMS_DIR));
  if (await fse.pathExists(discordEnumsDir)) {
    const enumFiles = await fg('**/*.ts', {
      cwd: discordEnumsDir,
      absolute: false,
      onlyFiles: true,
    });

    for (const file of enumFiles) {
      project.addSourceFileAtPath(normalize(join(discordEnumsDir, file)));
    }
  }

  // Equicord’s `shikiCodeblocks.desktop` plugin constructs theme URLs at runtime; add its helper
  // file so enum extraction can see the literal values instead of emitting “<computed>”
  const shikiThemesPath = normalize(
    join(sourcePath, 'src/plugins/shikiCodeblocks.desktop/api/themes.ts')
  );
  if (await fse.pathExists(shikiThemesPath)) {
    project.addSourceFileAtPath(shikiThemesPath);
  }

  return project;
}

async function findPluginSourceFile(pluginPath: string): Promise<Maybe<string>> {
  const found = await asyncFind(async (pattern: string) => {
    const filePath = normalize(join(pluginPath, pattern));
    return await fse.pathExists(filePath);
  }, PLUGIN_SOURCE_FILE_PATTERNS);

  return match(found)
    .with(P.string, (path) => Maybe.just(normalize(join(pluginPath, path))))
    .otherwise(() => Maybe.nothing<string>());
}

async function parseSinglePlugin(
  pluginDir: string,
  pluginPath: string,
  project: Project,
  typeChecker: ReturnType<Project['getTypeChecker']>
): Promise<Maybe<[string, PluginConfig]>> {
  const filePath = await findPluginSourceFile(pluginPath);
  const path = filePath.unwrapOr(null);

  if (!path) {
    return Maybe.nothing();
  }
  const sourceFile = project.addSourceFileAtPath(path);
  const pluginInfo = extractPluginInfo(sourceFile, typeChecker);
  const pluginName =
    pluginInfo.name ??
    pipe(
      pluginDir.split(PLUGIN_DIR_SEPARATOR_PATTERN),
      map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
    ).join('');

  if (!pluginName) {
    return Maybe.nothing();
  }

  let settingsCall = findDefinePluginSettings(sourceFile);

  if (settingsCall.isNothing) {
    const settingsPath = normalize(join(pluginPath, 'settings.ts'));
    const pathExists = await fse.pathExists(settingsPath);
    settingsCall = match(pathExists)
      .with(true, () => {
        const settingsFile = project.addSourceFileAtPath(settingsPath);
        return findDefinePluginSettings(settingsFile);
      })
      .with(false, () => Maybe.nothing<CallExpression>())
      .exhaustive();
  }

  const settings = settingsCall
    .map((call) => extractSettingsFromCall(call, typeChecker, project.getProgram(), pluginName))
    .unwrapOr({});

  const pluginConfig: PluginConfig = {
    name: pluginName,
    settings,
    directoryName: pluginDir,
    ...match(pluginInfo.description)
      .with(P.string, (desc) => ({ description: desc }))
      .otherwise(() => ({})),
  };

  return Maybe.just<[string, PluginConfig]>([pluginName, pluginConfig]);
}

/**
 * Parse every plugin found under a given directory (Vencord or Equicord).
 *
 * Uses `fast-glob` to find every plugin folder that exposes an `index.tsx` (or .ts),
 * kicks `parseSinglePlugin` in a bounded parallel pool (p-limit) to avoid melting the CPU,
 * and returns a
 * record keyed by plugin name. Non-TTY runs print progress every ten plugins so CI
 * logs show whether we stalled on a specific repository.
 */
async function parsePluginsFromDirectory(
  pluginsPath: string,
  project: Project,
  typeChecker: ReturnType<Project['getTypeChecker']>,
  isTTY: boolean
): Promise<ReadonlyDeep<Record<string, PluginConfig>>> {
  const files = await fg(PLUGIN_FILE_GLOB_PATTERN, {
    cwd: pluginsPath,
    absolute: false,
    onlyFiles: true,
  });

  const pluginDirsArray = pipe(
    files,
    map((file: string) => dirname(file)),
    unique(),
    filter((dir: string) => dir !== CURRENT_DIRECTORY)
  );

  if (!isTTY) {
    const dirName = basename(pluginsPath);
    console.log(`Found ${pluginDirsArray.length} plugin directories in ${dirName}`);
  }

  const limit = pLimit(PARALLEL_PROCESSING_LIMIT);
  let processed = 0;

  const results = await asyncToArray(
    asyncMap(async (pluginDir: string) => {
      const pluginPath = normalize(join(pluginsPath, pluginDir));
      const result = await limit(() =>
        parseSinglePlugin(pluginDir, pluginPath, project, typeChecker)
      );
      processed++;
      if (!isTTY && processed % PROGRESS_REPORT_INTERVAL === 0) {
        console.log(`Processed ${processed}/${pluginDirsArray.length} plugins...`);
      }
      return result;
    }, pluginDirsArray)
  );

  const validResults = pipe(
    results,
    filter((maybe) => maybe.isJust),
    map((maybe) => (maybe as Extract<typeof maybe, { isJust: true }>).value)
  );

  return pipe(validResults, fromEntries, pickBy(isNonNull)) as ReadonlyDeep<
    Record<string, PluginConfig>
  >;
}

export type ParsePluginsOptions = SetOptional<
  {
    vencordPluginsDir: string;
    equicordPluginsDir: string;
  },
  'vencordPluginsDir' | 'equicordPluginsDir'
>;

/**
 * Parse all plugin directories for a given repo root.
 *
 * Accepts optional overrides for the Vencord and Equicord plugin directories, but
 * defaults to whatever `CLI_CONFIG` says (usually `src/plugins` and `src/equicordplugins`).
 * The function builds one ts-morph project, then parses each directory that actually exists.
 * Missing directories just return `{}` so users can run against Vencord-only or Equicord-only
 * trees without touching flags.
 */
export async function parsePlugins(
  sourcePath: string,
  options: ParsePluginsOptions = {}
): Promise<ParsedPluginsResult> {
  const validatedOptions = ParsePluginsOptionsSchema.parse(options);
  const vencordPluginsDir =
    validatedOptions.vencordPluginsDir ?? CLI_CONFIG.directories.vencordPlugins;
  const equicordPluginsDir =
    validatedOptions.equicordPluginsDir ?? CLI_CONFIG.directories.equicordPlugins;

  const pluginsPath = normalize(join(sourcePath, vencordPluginsDir));
  const equicordPluginsPath = normalize(join(sourcePath, equicordPluginsDir));

  const [hasVencordPlugins, hasEquicordPlugins] = await Promise.all([
    fse.pathExists(pluginsPath),
    fse.pathExists(equicordPluginsPath),
  ]);

  const project = await createProject(sourcePath);
  const typeChecker = project.getTypeChecker();
  const isTTY = process.stdout.isTTY;

  const parseVencordPlugins = () =>
    parsePluginsFromDirectory(pluginsPath, project, typeChecker, isTTY);
  const parseEquicordPlugins = () =>
    parsePluginsFromDirectory(equicordPluginsPath, project, typeChecker, isTTY);

  const [vencordPlugins, equicordPlugins] = await match<
    [boolean, boolean],
    Promise<
      [ReadonlyDeep<Record<string, PluginConfig>>, ReadonlyDeep<Record<string, PluginConfig>>]
    >
  >([hasVencordPlugins, hasEquicordPlugins])
    .with([false, false], () => {
      throw new Error(
        `No plugins directories found. Expected one of:\n` +
          `  - ${pluginsPath}\n` +
          `  - ${equicordPluginsPath}`
      );
    })
    .with([true, true], async () => [await parseVencordPlugins(), await parseEquicordPlugins()])
    .with([true, false], async () => [
      await parseVencordPlugins(),
      {} as ReadonlyDeep<Record<string, PluginConfig>>,
    ])
    .with([false, true], async () => [
      {} as ReadonlyDeep<Record<string, PluginConfig>>,
      await parseEquicordPlugins(),
    ])
    .exhaustive();

  return {
    vencordPlugins,
    equicordPlugins,
  };
}

/**
 * Plugin rename mappings between Vencord and Equicord.
 * Key: Vencord plugin name, Value: Equicord plugin name
 */
const PLUGIN_RENAME_MAP: Record<string, string> = {
  oneko: 'CursorBuddy',
};

/**
 * Extract migration information from migratePluginToSettings calls
 */
export async function extractMigrations(
  sourcePath: string
): Promise<Record<string, string | null>> {
  try {
    // Check if the source path exists and has TypeScript files
    const tsconfigPath = join(sourcePath, 'tsconfig.json');
    if (!(await fse.pathExists(tsconfigPath))) {
      // If no tsconfig.json, fall back to hardcoded known migrations
      // This handles cases where TypeScript parsing fails in build environments
      return getKnownMigrations();
    }

    const project = await createProject(sourcePath);

    // Find all TypeScript files
    const tsFiles = await fg('**/*.{ts,tsx}', {
      cwd: sourcePath,
      absolute: false,
    });

    if (tsFiles.length === 0) {
      return getKnownMigrations(); // No TypeScript files found, use known migrations
    }

    const migrations: Record<string, string | null> = {};

    for (const file of tsFiles) {
      try {
        const sourceFile = project.addSourceFileAtPath(normalize(join(sourcePath, file)));
        const calls = sourceFile.getDescendantsOfKind(ts.SyntaxKind.CallExpression);

        for (const call of calls) {
          const expression = call.getExpression();
          if (expression.getText() === 'migratePluginToSettings') {
            const args = call.getArguments();
            if (args.length >= 3 && args[1] && args[2]) {
              // migratePluginToSettings(deleteOldSettings, newPluginName, oldPluginName, ...settings)
              const newPluginName = args[1].getText().replace(/['"]/g, '');
              const oldPluginName = args[2].getText().replace(/['"]/g, '');

              // For now, map to the new plugin name (even though it's now a setting)
              // In the future, we could be smarter about this
              migrations[oldPluginName] = newPluginName;
            }
          }
        }
      } catch (fileError) {
        // Skip files that can't be parsed
        continue;
      }
    }

    // If we found migrations via TypeScript parsing, return them
    // Otherwise, fall back to known migrations
    return Object.keys(migrations).length > 0 ? migrations : getKnownMigrations();
  } catch (error) {
    // If migration extraction fails entirely, fall back to known migrations
    // This ensures the build doesn't fail due to migration extraction issues
    return getKnownMigrations();
  }
}

/**
 * Fallback function that returns known migrations when TypeScript parsing fails
 */
function getKnownMigrations(): Record<string, string | null> {
  return {
    AmITyping: 'TypingTweaks',
    AllCallTimers: 'CallTimer',
    QuestCompleter: 'Questify',
  };
}

/**
 * Update the deprecated.nix file with migration information
 */
export async function updateDeprecatedPlugins(
  migrations: Record<string, string | null>,
  pluginsDir: string,
  verbose: boolean,
  logger: any
): Promise<void> {
  try {
    const deprecatedPath = join(pluginsDir, 'deprecated.nix');

    // Read existing deprecated file or create empty one
    let existingDeprecated: Record<string, string | null> = {};
    if (await fse.pathExists(deprecatedPath)) {
      try {
        const content = await fse.readFile(deprecatedPath, 'utf-8');
        // Parse Nix attrset - this is a simple parser for { key = value; ... }
        const attrsetMatch = content.match(/\{\s*([^}]*)\s*\}/);
        if (attrsetMatch && attrsetMatch[1]) {
          const entries = attrsetMatch[1].split(';').filter((line) => line.trim());
          for (const entry of entries) {
            const match = entry.trim().match(/(\w+)\s*=\s*(null|"[^"]*");?/);
            if (match && match[1] && match[2]) {
              const [, key, value] = match;
              existingDeprecated[key] = value === 'null' ? null : value.replace(/"/g, '');
            }
          }
        }
      } catch (e) {
        if (verbose) {
          logger.warn(`Failed to parse existing deprecated.nix: ${e}`);
        }
      }
    }

    // If no new migrations and no existing file, skip
    if (Object.keys(migrations).length === 0 && Object.keys(existingDeprecated).length === 0) {
      return;
    }

    // Merge existing deprecations with new migrations
    const updatedDeprecated = { ...existingDeprecated, ...migrations };

    // Generate Nix code
    const entries = Object.entries(updatedDeprecated)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([oldName, newName]) => `  ${oldName} = ${newName === null ? 'null' : `"${newName}"`};`)
      .join('\n');

    const nixCode = `# This file is auto-generated by scripts/generate-plugin-options\n# DO NOT EDIT this file directly; instead update the generator\n\n{\n${entries}\n}\n`;

    await fse.writeFile(deprecatedPath, nixCode);

    if (verbose && Object.keys(migrations).length > 0) {
      logger.info(`Updated deprecated.nix with ${Object.keys(migrations).length} migrations`);
    }
  } catch (error) {
    // If updating deprecated plugins fails, don't fail the entire build
    if (verbose) {
      logger.warn(`Failed to update deprecated.nix: ${error}`);
    }
  }
}

/**
 * Figure out which plugins are shared, Vencord-only, or Equicord-only. Matching happens
 * by plugin name first, then by directory slug because Equicord occasionally renames
 * things while keeping the same folder. That mirrors how humans think about the repos.
 */
export function categorizePlugins(
  vencordResult: Readonly<ParsedPluginsResult>,
  equicordResult?: Readonly<ParsedPluginsResult>
): {
  readonly generic: ReadonlyDeep<Record<string, PluginConfig>>;
  readonly vencordOnly: ReadonlyDeep<Record<string, PluginConfig>>;
  readonly equicordOnly: ReadonlyDeep<Record<string, PluginConfig>>;
} {
  const vencordPlugins = vencordResult.vencordPlugins;
  const equicordSharedPlugins = equicordResult?.vencordPlugins ?? {};
  const equicordOnlyPlugins = equicordResult?.equicordPlugins ?? {};

  // Equicord occasionally renames plugins without touching the folder (e.g., `statusEverywhere` vs
  // `StatusEverywhere`). Build a directory-name map so we can still line shared plugins up.
  const equicordDirectoryMap = pipe(
    entries(equicordSharedPlugins),
    filter(([, config]) => config.directoryName !== undefined),
    reduce((acc, [name, config]) => {
      acc.set(config.directoryName!.toLowerCase(), name);
      return acc;
    }, new Map<string, string>())
  );

  const pluginMatches = pipe(
    entries(vencordPlugins),
    map(([name, config]) => {
      const equicordConfig = match(equicordSharedPlugins[name])
        .with(undefined, () => {
          // Check for plugin rename mapping
          const renamedPlugin = PLUGIN_RENAME_MAP[name];
          if (renamedPlugin) {
            return equicordOnlyPlugins[renamedPlugin] || equicordSharedPlugins[renamedPlugin];
          }

          return match(config?.directoryName)
            .with(P.string, (dirName) => {
              const equicordName = equicordDirectoryMap.get(dirName.toLowerCase());
              return match(equicordName)
                .with(undefined, () => undefined)
                .otherwise((equicordName) => equicordSharedPlugins[equicordName]);
            })
            .otherwise(() => undefined);
        })
        .otherwise((cfg) => cfg);

      return { name, config, equicordConfig };
    })
  );

  const [genericMatches, vencordMatches] = pipe(
    pluginMatches,
    partition(({ equicordConfig }) => equicordConfig !== undefined)
  );

  const genericTuples = pipe(
    genericMatches,
    map(({ name, equicordConfig }) => [name, equicordConfig!] as [string, PluginConfig])
  );

  const vencordTuples = pipe(
    vencordMatches,
    map(({ name, config }) => [name, config] as [string, PluginConfig])
  );

  // Collect names of Equicord plugins that were matched to Vencord plugins
  const matchedEquicordPluginNames = new Set(
    pipe(
      genericMatches,
      map(({ equicordConfig }) => equicordConfig!.name),
      filter((name) => name !== undefined)
    )
  );

  // Remove matched Equicord plugins from equicordOnly
  const filteredEquicordOnly = pipe(
    entries(equicordOnlyPlugins),
    filter(([name]) => !matchedEquicordPluginNames.has(name)),
    fromEntries
  );

  return {
    generic: pipe(genericTuples, fromEntries, pickBy(isNonNull)) as ReadonlyDeep<
      Record<string, PluginConfig>
    >,
    vencordOnly: pipe(vencordTuples, fromEntries, pickBy(isNonNull)) as ReadonlyDeep<
      Record<string, PluginConfig>
    >,
    equicordOnly: pickBy(filteredEquicordOnly, isNonNull) as ReadonlyDeep<
      Record<string, PluginConfig>
    >,
  };
}
