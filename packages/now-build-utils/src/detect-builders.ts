import minimatch from 'minimatch';
import { valid as validSemver } from 'semver';
import { parse as parsePath, extname } from 'path';
import { Route, Source } from '@now/routing-utils';
import { PackageJson, Builder, Config, BuilderFunctions } from './types';

interface ErrorResponse {
  code: string;
  message: string;
}

interface Options {
  tag?: 'canary' | 'latest' | string;
  functions?: BuilderFunctions;
  ignoreBuildScript?: boolean;
  projectSettings?: {
    framework?: string | null;
    devCommand?: string | null;
    buildCommand?: string | null;
    outputDirectory?: string | null;
  };
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  featHandleMiss?: boolean;
}

// We need to sort the file paths by alphabet to make
// sure the routes stay in the same order e.g. for deduping
export function sortFiles(fileA: string, fileB: string) {
  return fileA.localeCompare(fileB);
}

export function detectApiExtensions(builders: Builder[]): Set<string> {
  return new Set<string>(
    builders
      .filter(
        b =>
          b.config && b.config.zeroConfig && b.src && b.src.startsWith('api/')
      )
      .map(b => extname(b.src))
      .filter(Boolean)
  );
}

export function detectApiDirectory(builders: Builder[]): string | null {
  // TODO: We eventually want to save the api directory to
  // builder.config.apiDirectory so it is only detected once
  const found = builders.some(
    b => b.config && b.config.zeroConfig && b.src.startsWith('api/')
  );
  return found ? 'api' : null;
}

// TODO: Replace this function with `config.outputDirectory`
function getPublicBuilder(builders: Builder[]): Builder | null {
  const builder = builders.find(
    builder =>
      builder.use === '@now/static' &&
      /^.*\/\*\*\/\*$/.test(builder.src) &&
      builder.config &&
      builder.config.zeroConfig === true
  );

  return builder || null;
}
export function detectOutputDirectory(builders: Builder[]): string | null {
  // TODO: We eventually want to save the output directory to
  // builder.config.outputDirectory so it is only detected once
  const publicBuilder = getPublicBuilder(builders);
  return publicBuilder ? publicBuilder.src.replace('/**/*', '') : null;
}

export async function detectBuilders(
  files: string[],
  pkg?: PackageJson | undefined | null,
  options: Options = {}
): Promise<{
  builders: Builder[] | null;
  errors: ErrorResponse[] | null;
  warnings: ErrorResponse[];
  defaultRoutes: Route[] | null;
  redirectRoutes: Route[] | null;
  rewriteRoutes: Route[] | null;
}> {
  const errors: ErrorResponse[] = [];
  const warnings: ErrorResponse[] = [];

  const apiBuilders: Builder[] = [];
  let frontendBuilder: Builder | null = null;

  const functionError = validateFunctions(options);

  if (functionError) {
    return {
      builders: null,
      errors: [functionError],
      warnings,
      defaultRoutes: null,
      redirectRoutes: null,
      rewriteRoutes: null,
    };
  }

  const apiMatches = getApiMatches(options);
  const sortedFiles = files.sort(sortFiles);
  const apiSortedFiles = files.sort(sortFilesBySegmentCount);

  // Keep track of functions that are used
  const usedFunctions = new Set<string>();

  const addToUsedFunctions = (builder: Builder) => {
    const key = Object.keys(builder.config!.functions || {})[0];
    if (key) usedFunctions.add(key);
  };

  const absolutePathCache = new Map<string, string>();

  const { projectSettings = {} } = options;
  const { buildCommand, outputDirectory, framework } = projectSettings;

  // If either is missing we'll make the frontend static
  const makeFrontendStatic = buildCommand === '' || outputDirectory === '';

  // Only used when there is no frontend builder,
  // but prevents looping over the files again.
  const usedOutputDirectory = outputDirectory || 'public';
  let hasUsedOutputDirectory = false;
  let hasNoneApiFiles = false;
  let hasNextApiFiles = false;

  let fallbackEntrypoint: string | null = null;

  const apiRoutes: Source[] = [];
  const dynamicRoutes: Source[] = [];

  // API
  for (const fileName of sortedFiles) {
    const apiBuilder = maybeGetApiBuilder(fileName, apiMatches, options);

    if (apiBuilder) {
      const { routeError, apiRoute, isDynamic } = getApiRoute(
        fileName,
        apiSortedFiles,
        options,
        absolutePathCache
      );

      if (routeError) {
        return {
          builders: null,
          errors: [routeError],
          warnings,
          defaultRoutes: null,
          redirectRoutes: null,
          rewriteRoutes: null,
        };
      }

      if (apiRoute) {
        apiRoutes.push(apiRoute);
        if (isDynamic) {
          dynamicRoutes.push(apiRoute);
        }
      }

      addToUsedFunctions(apiBuilder);
      apiBuilders.push(apiBuilder);
      continue;
    }

    if (
      !hasUsedOutputDirectory &&
      fileName.startsWith(`${usedOutputDirectory}/`)
    ) {
      hasUsedOutputDirectory = true;
    }

    if (
      !hasNoneApiFiles &&
      !fileName.startsWith('api/') &&
      fileName !== 'package.json'
    ) {
      hasNoneApiFiles = true;
    }

    if (
      !hasNextApiFiles &&
      (fileName.startsWith('pages/api') || fileName.startsWith('src/pages/api'))
    ) {
      hasNextApiFiles = true;
    }

    if (
      !fallbackEntrypoint &&
      buildCommand &&
      !fileName.includes('/') &&
      fileName !== 'now.json' &&
      fileName !== 'vercel.json'
    ) {
      fallbackEntrypoint = fileName;
    }
  }

  if (
    !makeFrontendStatic &&
    (hasBuildScript(pkg) || buildCommand || framework)
  ) {
    // Framework or Build
    frontendBuilder = detectFrontBuilder(
      pkg,
      files,
      usedFunctions,
      fallbackEntrypoint,
      options
    );
  } else {
    if (
      pkg &&
      !makeFrontendStatic &&
      !apiBuilders.length &&
      !options.ignoreBuildScript
    ) {
      // We only show this error when there are no api builders
      // since the dependencies of the pkg could be used for those
      errors.push(getMissingBuildScriptError());
      return {
        errors,
        warnings,
        builders: null,
        redirectRoutes: null,
        defaultRoutes: null,
        rewriteRoutes: null,
      };
    }

    // If `outputDirectory` is an empty string,
    // we'll default to the root directory.
    if (hasUsedOutputDirectory && outputDirectory !== '') {
      frontendBuilder = {
        use: '@now/static',
        src: `${usedOutputDirectory}/**/*`,
        config: {
          zeroConfig: true,
          outputDirectory: usedOutputDirectory,
        },
      };
    } else if (apiBuilders.length && hasNoneApiFiles) {
      // Everything besides the api directory
      // and package.json can be served as static files
      frontendBuilder = {
        use: '@now/static',
        src: '!{api/**,package.json}',
        config: {
          zeroConfig: true,
        },
      };
    }
  }

  const unusedFunctionError = checkUnusedFunctions(
    frontendBuilder,
    usedFunctions,
    options
  );

  if (unusedFunctionError) {
    return {
      builders: null,
      errors: [unusedFunctionError],
      warnings,
      redirectRoutes: null,
      defaultRoutes: null,
      rewriteRoutes: null,
    };
  }

  const builders: Builder[] = [];

  if (apiBuilders.length) {
    builders.push(...apiBuilders);
  }

  if (frontendBuilder) {
    builders.push(frontendBuilder);

    if (hasNextApiFiles && apiBuilders.length) {
      warnings.push({
        code: 'conflicting_files',
        message:
          'It is not possible to use `api` and `pages/api` at the same time, please only use one option',
      });
    }
  }

  const routesResult = getRouteResult(
    apiRoutes,
    dynamicRoutes,
    usedOutputDirectory,
    apiBuilders,
    frontendBuilder,
    options
  );

  return {
    warnings,
    builders: builders.length ? builders : null,
    errors: errors.length ? errors : null,
    redirectRoutes: routesResult.redirectRoutes,
    defaultRoutes: routesResult.defaultRoutes,
    rewriteRoutes: routesResult.rewriteRoutes,
  };
}

function maybeGetApiBuilder(
  fileName: string,
  apiMatches: Builder[],
  options: Options
) {
  if (!fileName.startsWith('api/')) {
    return null;
  }

  if (fileName.includes('/.')) {
    return null;
  }

  if (fileName.includes('/_')) {
    return null;
  }

  if (fileName.includes('/node_modules/')) {
    return null;
  }

  if (fileName.endsWith('.d.ts')) {
    return null;
  }

  const match = apiMatches.find(({ src }) => {
    return src === fileName || minimatch(fileName, src);
  });

  const { fnPattern, func } = getFunction(fileName, options);

  const use = (func && func.runtime) || (match && match.use);

  if (!use) {
    return null;
  }

  const config: Config = { zeroConfig: true };

  if (fnPattern && func) {
    config.functions = { [fnPattern]: func };

    if (func.includeFiles) {
      config.includeFiles = func.includeFiles;
    }

    if (func.excludeFiles) {
      config.excludeFiles = func.excludeFiles;
    }
  }

  const builder: Builder = {
    use,
    src: fileName,
    config,
  };

  return builder;
}

function getFunction(fileName: string, { functions = {} }: Options) {
  const keys = Object.keys(functions);

  if (!keys.length) {
    return { fnPattern: null, func: null };
  }

  const func = keys.find(key => key === fileName || minimatch(fileName, key));

  return func
    ? { fnPattern: func, func: functions[func] }
    : { fnPattern: null, func: null };
}

function getApiMatches({ tag }: Options = {}) {
  const withTag = tag ? `@${tag}` : '';
  const config = { zeroConfig: true };

  return [
    { src: 'api/**/*.js', use: `@now/node${withTag}`, config },
    { src: 'api/**/*.ts', use: `@now/node${withTag}`, config },
    { src: 'api/**/!(*_test).go', use: `@now/go${withTag}`, config },
    { src: 'api/**/*.py', use: `@now/python${withTag}`, config },
    { src: 'api/**/*.rb', use: `@now/ruby${withTag}`, config },
  ];
}

function hasBuildScript(pkg: PackageJson | undefined | null) {
  const { scripts = {} } = pkg || {};
  return Boolean(scripts && scripts['build']);
}

function detectFrontBuilder(
  pkg: PackageJson | null | undefined,
  files: string[],
  usedFunctions: Set<string>,
  fallbackEntrypoint: string | null,
  options: Options
): Builder {
  const { tag, projectSettings = {} } = options;
  const withTag = tag ? `@${tag}` : '';
  let { framework } = projectSettings;

  const config: Config = {
    zeroConfig: true,
  };

  if (framework) {
    config.framework = framework;
  }

  if (projectSettings.devCommand) {
    config.devCommand = projectSettings.devCommand;
  }

  if (projectSettings.buildCommand) {
    config.buildCommand = projectSettings.buildCommand;
  }

  if (projectSettings.outputDirectory) {
    config.outputDirectory = projectSettings.outputDirectory;
  }

  if (pkg) {
    const deps: PackageJson['dependencies'] = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    if (deps['next']) {
      framework = 'nextjs';
    }
  }

  if (options.functions) {
    // When the builder is not used yet we'll use it for the frontend
    Object.entries(options.functions).forEach(([key, func]) => {
      if (!usedFunctions.has(key)) {
        if (!config.functions) config.functions = {};
        config.functions[key] = { ...func };
      }
    });
  }

  if (framework === 'nextjs') {
    return { src: 'package.json', use: `@now/next${withTag}`, config };
  }

  // Entrypoints for other frameworks
  // TODO - What if just a build script is provided, but no entrypoint.
  const entrypoints = new Set([
    'package.json',
    'config.yaml',
    'config.toml',
    'config.json',
    '_config.yml',
    'config.yml',
    'config.rb',
  ]);

  const source = pkg
    ? 'package.json'
    : files.find(file => entrypoints.has(file)) ||
      fallbackEntrypoint ||
      'package.json';

  return {
    src: source || 'package.json',
    use: `@now/static-build${withTag}`,
    config,
  };
}

function getMissingBuildScriptError() {
  return {
    code: 'missing_build_script',
    message:
      'Your `package.json` file is missing a `build` property inside the `scripts` property.' +
      '\nMore details: https://vercel.com/docs/v2/platform/frequently-asked-questions#missing-build-script',
  };
}

function validateFunctions({ functions = {} }: Options) {
  for (const [path, func] of Object.entries(functions)) {
    if (path.length > 256) {
      return {
        code: 'invalid_function_glob',
        message: 'Function globs must be less than 256 characters long.',
      };
    }

    if (!func || typeof func !== 'object') {
      return {
        code: 'invalid_function',
        message: 'Function must be an object.',
      };
    }

    if (Object.keys(func).length === 0) {
      return {
        code: 'invalid_function',
        message: 'Function must contain at least one property.',
      };
    }

    if (
      func.maxDuration !== undefined &&
      (func.maxDuration < 1 ||
        func.maxDuration > 900 ||
        !Number.isInteger(func.maxDuration))
    ) {
      return {
        code: 'invalid_function_duration',
        message: 'Functions must have a duration between 1 and 900.',
      };
    }

    if (
      func.memory !== undefined &&
      (func.memory < 128 || func.memory > 3008 || func.memory % 64 !== 0)
    ) {
      return {
        code: 'invalid_function_memory',
        message:
          'Functions must have a memory value between 128 and 3008 in steps of 64.',
      };
    }

    if (path.startsWith('/')) {
      return {
        code: 'invalid_function_source',
        message: `The function path "${path}" is invalid. The path must be relative to your project root and therefore cannot start with a slash.`,
      };
    }

    if (func.runtime !== undefined) {
      const tag = `${func.runtime}`.split('@').pop();

      if (!tag || !validSemver(tag)) {
        return {
          code: 'invalid_function_runtime',
          message:
            'Function Runtimes must have a valid version, for example `now-php@1.0.0`.',
        };
      }
    }

    if (func.includeFiles !== undefined) {
      if (typeof func.includeFiles !== 'string') {
        return {
          code: 'invalid_function_property',
          message: `The property \`includeFiles\` must be a string.`,
        };
      }
    }

    if (func.excludeFiles !== undefined) {
      if (typeof func.excludeFiles !== 'string') {
        return {
          code: 'invalid_function_property',
          message: `The property \`excludeFiles\` must be a string.`,
        };
      }
    }
  }

  return null;
}

function checkUnusedFunctions(
  frontendBuilder: Builder | null,
  usedFunctions: Set<string>,
  options: Options
): ErrorResponse | null {
  const unusedFunctions = new Set(
    Object.keys(options.functions || {}).filter(key => !usedFunctions.has(key))
  );

  if (!unusedFunctions.size) {
    return null;
  }

  // Next.js can use functions only for `src/pages` or `pages`
  if (frontendBuilder && frontendBuilder.use.startsWith('@now/next')) {
    for (const fnKey of unusedFunctions.values()) {
      if (fnKey.startsWith('pages/') || fnKey.startsWith('src/pages')) {
        unusedFunctions.delete(fnKey);
      } else {
        return {
          code: 'unused_function',
          message: `The function for ${fnKey} can't be handled by any builder`,
        };
      }
    }
  }

  if (unusedFunctions.size) {
    const [unusedFunction] = Array.from(unusedFunctions);

    return {
      code: 'unused_function',
      message:
        `The function for ${unusedFunction} can't be handled by any builder. ` +
        `Make sure it is inside the api/ directory.`,
    };
  }

  return null;
}

function getApiRoute(
  fileName: string,
  sortedFiles: string[],
  options: Options,
  absolutePathCache: Map<string, string>
): {
  apiRoute: Source | null;
  isDynamic: boolean;
  routeError: ErrorResponse | null;
} {
  const conflictingSegment = getConflictingSegment(fileName);

  if (conflictingSegment) {
    return {
      apiRoute: null,
      isDynamic: false,
      routeError: {
        code: 'conflicting_path_segment',
        message:
          `The segment "${conflictingSegment}" occurs more than ` +
          `one time in your path "${fileName}". Please make sure that ` +
          `every segment in a path is unique.`,
      },
    };
  }

  const occurrences = pathOccurrences(fileName, sortedFiles, absolutePathCache);

  if (occurrences.length > 0) {
    const messagePaths = concatArrayOfText(
      occurrences.map(name => `"${name}"`)
    );

    return {
      apiRoute: null,
      isDynamic: false,
      routeError: {
        code: 'conflicting_file_path',
        message:
          `Two or more files have conflicting paths or names. ` +
          `Please make sure path segments and filenames, without their extension, are unique. ` +
          `The path "${fileName}" has conflicts with ${messagePaths}.`,
      },
    };
  }

  const out = createRouteFromPath(
    fileName,
    Boolean(options.featHandleMiss),
    Boolean(options.cleanUrls)
  );

  return {
    apiRoute: out.route,
    isDynamic: out.isDynamic,
    routeError: null,
  };
}

// Checks if a placeholder with the same name is used
// multiple times inside the same path
function getConflictingSegment(filePath: string): string | null {
  const segments = new Set<string>();

  for (const segment of filePath.split('/')) {
    const name = getSegmentName(segment);

    if (name !== null && segments.has(name)) {
      return name;
    }

    if (name) {
      segments.add(name);
    }
  }

  return null;
}

// Takes a filename or foldername, strips the extension
// gets the part between the "[]" brackets.
// It will return `null` if there are no brackets
// and therefore no segment.
function getSegmentName(segment: string): string | null {
  const { name } = parsePath(segment);

  if (name.startsWith('[') && name.endsWith(']')) {
    return name.slice(1, -1);
  }

  return null;
}

function getAbsolutePath(unresolvedPath: string) {
  const { dir, name } = parsePath(unresolvedPath);
  const parts = joinPath(dir, name).split('/');
  return parts.map(part => part.replace(/\[.*\]/, '1')).join('/');
}

// Counts how often a path occurs when all placeholders
// got resolved, so we can check if they have conflicts
function pathOccurrences(
  fileName: string,
  files: string[],
  absolutePathCache: Map<string, string>
): string[] {
  let currentAbsolutePath = absolutePathCache.get(fileName);

  if (!currentAbsolutePath) {
    currentAbsolutePath = getAbsolutePath(fileName);
    absolutePathCache.set(fileName, currentAbsolutePath);
  }

  const prev: string[] = [];

  // Do not call expensive functions like `minimatch` in here
  // because we iterate over every file.
  for (const file of files) {
    if (file === fileName) {
      continue;
    }

    let absolutePath = absolutePathCache.get(file);

    if (!absolutePath) {
      absolutePath = getAbsolutePath(file);
      absolutePathCache.set(file, absolutePath);
    }

    if (absolutePath === currentAbsolutePath) {
      prev.push(file);
    } else if (partiallyMatches(fileName, file)) {
      prev.push(file);
    }
  }

  return prev;
}

function joinPath(...segments: string[]) {
  const joinedPath = segments.join('/');
  return joinedPath.replace(/\/{2,}/g, '/');
}

function escapeName(name: string) {
  const special = '[]^$.|?*+()'.split('');

  for (const char of special) {
    name = name.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }

  return name;
}

function concatArrayOfText(texts: string[]): string {
  if (texts.length <= 2) {
    return texts.join(' and ');
  }

  const last = texts.pop();
  return `${texts.join(', ')}, and ${last}`;
}

// Check if the path partially matches and has the same
// name for the path segment at the same position
function partiallyMatches(pathA: string, pathB: string): boolean {
  const partsA = pathA.split('/');
  const partsB = pathB.split('/');

  const long = partsA.length > partsB.length ? partsA : partsB;
  const short = long === partsA ? partsB : partsA;

  let index = 0;

  for (const segmentShort of short) {
    const segmentLong = long[index];

    const nameLong = getSegmentName(segmentLong);
    const nameShort = getSegmentName(segmentShort);

    // If there are no segments or the paths differ we
    // return as they are not matching
    if (segmentShort !== segmentLong && (!nameLong || !nameShort)) {
      return false;
    }

    if (nameLong !== nameShort) {
      return true;
    }

    index += 1;
  }

  return false;
}

function createRouteFromPath(
  filePath: string,
  featHandleMiss: boolean,
  cleanUrls: boolean
): { route: Source; isDynamic: boolean } {
  const parts = filePath.split('/');

  let counter = 1;
  const query: string[] = [];
  let isDynamic = false;

  const srcParts = parts.map((segment, i): string => {
    const name = getSegmentName(segment);
    const isLast = i === parts.length - 1;

    if (name !== null) {
      // We can't use `URLSearchParams` because `$` would get escaped
      query.push(`${name}=$${counter++}`);
      isDynamic = true;
      return `([^/]+)`;
    } else if (isLast) {
      const { name: fileName, ext } = parsePath(segment);
      const isIndex = fileName === 'index';
      const prefix = isIndex ? '/' : '';

      const names = [
        isIndex ? prefix : `${fileName}/`,
        prefix + escapeName(fileName),
        featHandleMiss && cleanUrls
          ? ''
          : prefix + escapeName(fileName) + escapeName(ext),
      ].filter(Boolean);

      // Either filename with extension, filename without extension
      // or nothing when the filename is `index`.
      // When `cleanUrls: true` then do *not* add the filename with extension.
      return `(${names.join('|')})${isIndex ? '?' : ''}`;
    }

    return segment;
  });

  const { name: fileName, ext } = parsePath(filePath);
  const isIndex = fileName === 'index';
  const queryString = `${query.length ? '?' : ''}${query.join('&')}`;

  const src = isIndex
    ? `^/${srcParts.slice(0, -1).join('/')}${srcParts.slice(-1)[0]}$`
    : `^/${srcParts.join('/')}$`;

  let route: Source;

  if (featHandleMiss) {
    const extensionless = ext ? filePath.slice(0, -ext.length) : filePath;
    route = {
      src,
      dest: `/${extensionless}${queryString}`,
      check: true,
    };
  } else {
    route = {
      src,
      dest: `/${filePath}${queryString}`,
    };
  }

  return { route, isDynamic };
}

function getRouteResult(
  apiRoutes: Source[],
  dynamicRoutes: Source[],
  outputDirectory: string,
  apiBuilders: Builder[],
  frontendBuilder: Builder | null,
  options: Options
): {
  defaultRoutes: Route[];
  redirectRoutes: Route[];
  rewriteRoutes: Route[];
} {
  const defaultRoutes: Route[] = [];
  const redirectRoutes: Route[] = [];
  const rewriteRoutes: Route[] = [];

  if (apiRoutes && apiRoutes.length > 0) {
    if (options.featHandleMiss) {
      const extSet = detectApiExtensions(apiBuilders);

      if (extSet.size > 0) {
        const exts = Array.from(extSet)
          .map(ext => ext.slice(1))
          .join('|');

        const extGroup = `(?:\\.(?:${exts}))`;

        if (options.cleanUrls) {
          redirectRoutes.push({
            src: `^/(api(?:.+)?)/index${extGroup}?/?$`,
            headers: { Location: options.trailingSlash ? '/$1/' : '/$1' },
            status: 308,
          });

          redirectRoutes.push({
            src: `^/api/(.+)${extGroup}/?$`,
            headers: {
              Location: options.trailingSlash ? '/api/$1/' : '/api/$1',
            },
            status: 308,
          });
        } else {
          defaultRoutes.push({ handle: 'miss' });
          defaultRoutes.push({
            src: `^/api/(.+)${extGroup}$`,
            dest: '/api/$1',
            check: true,
          });
        }
      }

      rewriteRoutes.push(...dynamicRoutes);
      rewriteRoutes.push({
        src: '^/api(/.*)?$',
        status: 404,
        continue: true,
      });
    } else {
      defaultRoutes.push(...apiRoutes);

      if (apiRoutes.length) {
        defaultRoutes.push({
          status: 404,
          src: '^/api(/.*)?$',
        });
      }
    }
  }

  if (
    outputDirectory &&
    frontendBuilder &&
    !options.featHandleMiss &&
    frontendBuilder.use === '@now/static'
  ) {
    defaultRoutes.push({
      src: '/(.*)',
      dest: `/${outputDirectory}/$1`,
    });
  }

  return {
    defaultRoutes,
    redirectRoutes,
    rewriteRoutes,
  };
}

function sortFilesBySegmentCount(fileA: string, fileB: string): number {
  const lengthA = fileA.split('/').length;
  const lengthB = fileB.split('/').length;

  if (lengthA > lengthB) {
    return -1;
  }

  if (lengthA < lengthB) {
    return 1;
  }

  // Paths that have the same segment length but
  // less placeholders are preferred
  const countSegments = (prev: number, segment: string) =>
    getSegmentName(segment) ? prev + 1 : 0;
  const segmentLengthA = fileA.split('/').reduce(countSegments, 0);
  const segmentLengthB = fileB.split('/').reduce(countSegments, 0);

  if (segmentLengthA > segmentLengthB) {
    return 1;
  }

  if (segmentLengthA < segmentLengthB) {
    return -1;
  }

  return 0;
}
