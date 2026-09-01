/* global process, console */
/**
 * Guards the local agent package's isolation. Same shape as agent-core's gate:
 *
 * 1. The tsconfig `files` list matches the real import closure of the entry
 *    points, in both directions: a file reachable from an entry but missing
 *    from the list fails, and a listed file no longer reachable fails.
 *    `files` alone cannot enforce either — it seeds the program without
 *    bounding it, and every listed file is in the program by construction.
 * 2. No file in the closure lives outside the package, other than a
 *    node_modules dependency declaration or the one path-mapped sibling,
 *    @beaver/agent-core (bounded by its own gate, `npm run typecheck:core`).
 * 3. Every import specifier a package file writes is either relative and
 *    resolves inside the package, or the one licensed external prefix,
 *    `@beaver/agent-core/`. Specifiers are collected from the TypeScript AST
 *    (imports, re-exports, `import type`, `import x =`, dynamic `import()`,
 *    and inline `import('...')` type references) rather than matched with a
 *    regex, so a dynamic import with no `from` clause and an inline type-only
 *    reference are both seen.
 * 4. The compiler options that make the isolation meaningful hold their exact
 *    allowed values — `types` empty, `lib` exactly ES2020, `paths` mapping
 *    nothing but the sibling package. Without this, widening any of them
 *    hands the package a whole host surface with every other check still
 *    green.
 * 5. No package file reaches a host surface by a route the checks above can't
 *    see: a `/// <reference .../>` directive, a `declare global` block, or a
 *    bare `globalThis` reference. Any of the three would silently undo the
 *    `types: []` / `lib: ["ES2020"]` isolation this gate otherwise proves —
 *    `declare global { const fetch: ... }` puts a global in the program while
 *    every other check stays green, and `globalThis` is rejected outright
 *    (not just where it names a known host global) because the useful evasive
 *    form is a cast — `(globalThis as unknown as { X }).X` — that a
 *    property-name check cannot tell apart from a legitimate access.
 * 6. Every file physically on disk under src/ is part of the closure, so an
 *    orphan module cannot sit in the package outside this gate's typecheck.
 *
 * Unlike agent-core and agent-ui, this package declares no npm dependencies
 * or peer dependencies, and its `package.json` `exports`/`typesVersions`
 * shape is the same fixed single-wildcard pattern as agent-core's with
 * nothing client-specific to drift — so this gate does not duplicate the
 * siblings' manifest-pinning validation (root-range matching, node_modules
 * presence, exports/typesVersions shape). That machinery exists there to keep
 * a growing dependency list and a two-extension export map honest; neither
 * exists here yet, and adding the checks now would guard nothing.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(pkgDir, 'src');
const repoRoot = path.resolve(pkgDir, '..', '..');
// The one in-repo package agent-local may consume. It is licensed via the
// tsconfig `paths` mapping rather than an install, so for this gate's
// purposes its files are treated like a dependency declaration.
const siblingCoreSrc = path.join(repoRoot, 'packages', 'agent-core', 'src');

const configPath = path.join(pkgDir, 'tsconfig.json');
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
}
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgDir);
if (parsed.errors.length > 0) {
    throw new Error(
        parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n')
    );
}

const errors = [];

// The tsconfig may not quietly grant itself a host surface. Pinned to their
// exact allowed values rather than screened for known-bad entries: `types`
// and `lib` each mean "everything available" when omitted, and each has more
// ways to name a host surface (WebWorker, DOM.Iterable, ScriptHost, …) than a
// denylist can keep up with.
if (JSON.stringify(parsed.options.lib) !== JSON.stringify(['lib.es2020.d.ts'])) {
    errors.push(`lib must be exactly ["ES2020"], found ${JSON.stringify(parsed.options.lib)}`);
}
if (JSON.stringify(parsed.options.types) !== JSON.stringify([])) {
    errors.push(`types must be exactly [], found ${JSON.stringify(parsed.options.types)}`);
}
const pathKeys = Object.keys(parsed.options.paths ?? {});
const corePathValue = parsed.options.paths?.['@beaver/agent-core/*'];
if (
    pathKeys.length !== 1 ||
    pathKeys[0] !== '@beaver/agent-core/*' ||
    JSON.stringify(corePathValue) !== JSON.stringify(['../agent-core/src/*'])
) {
    errors.push(
        `paths must license only "@beaver/agent-core/*": ["../agent-core/src/*"], found ${JSON.stringify(parsed.options.paths)}`
    );
}

// The roots the closure is computed from. globals.d.ts is ambient — nothing
// imports it — so, like agent-core's globals.d.ts, it has to be a root
// alongside index.ts for the program to see it at all; without this it would
// silently drop out of both the closure and the orphan scan below.
const entryPaths = ['src/globals.d.ts', 'src/index.ts'].map((p) => path.join(pkgDir, p));

const listed = parsed.fileNames.map((f) => path.resolve(f));
const listedSet = new Set(listed);
const missingEntries = entryPaths.filter((f) => !listedSet.has(f));
if (missingEntries.length > 0) {
    throw new Error(
        `tsconfig \`files\` must list the entry points; missing: ${missingEntries
            .map((f) => path.relative(pkgDir, f))
            .join(', ')}`
    );
}

const program = ts.createProgram({ rootNames: entryPaths, options: parsed.options });
const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !program.isSourceFileDefaultLibrary(sf));
const closure = sourceFiles.map((sf) => path.resolve(sf.fileName));
const closureSet = new Set(closure);

const isInPackage = (f) => f.startsWith(pkgDir + path.sep);
// Relative to the repo root, so a checkout that itself sits under a directory
// named node_modules does not turn the escapee check into a silent no-op.
const isDependency = (f) => path.relative(repoRoot, f).split(path.sep).includes('node_modules');
const isSiblingCore = (f) => f.startsWith(siblingCoreSrc + path.sep);

// `files` describes the package's own surface, so the two-way match is scoped
// to in-package files; a dependency's (or the sibling's) .d.ts graph is never
// listed.
const unlisted = closure.filter((f) => isInPackage(f) && !listedSet.has(f));
const stale = listed.filter((f) => !closureSet.has(f));
// Even a listed-and-reachable file must live inside the package. Dependency
// declarations and the sibling agent-core are the only legitimate ways to be
// outside it.
const escapees = closure.filter((f) => !isInPackage(f) && !isDependency(f) && !isSiblingCore(f));

// Collects the module specifiers a file writes, across static imports,
// re-exports, `import type`, `import x =`, dynamic `import()`, and inline
// `import('...')` type references — the same collector agent-core and
// agent-ui use. A regex over `from '...'` cannot see the last two forms.
function collectSpecifiers(sourceFile) {
    const specifiers = new Set();
    const visit = (node) => {
        let specifier;
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            specifier = node.moduleSpecifier.text;
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression)
        ) {
            specifier = node.moduleReference.expression.text;
        } else if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            specifier = node.argument.literal.text;
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            specifier = node.arguments[0].text;
        }
        if (specifier !== undefined) {
            specifiers.add(specifier);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return specifiers;
}

// The two routes to a host surface that neither the specifier rule nor
// `types`/`lib` can see: a `declare global` block, and a bare `globalThis`
// reference. See point 5 in the file header for why `globalThis` is rejected
// outright rather than only where it names a known host global.
function collectGlobalEscapes(sourceFile) {
    const found = [];
    const lineOf = (node) =>
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const visit = (node) => {
        if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation) {
            found.push({ kind: 'declare global', line: lineOf(node) });
        }
        if (ts.isIdentifier(node) && node.text === 'globalThis') {
            found.push({ kind: 'globalThis', line: lineOf(node) });
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    return found;
}

const disallowedSpecifiers = [];
const ambientReferences = [];
const globalEscapes = [];

// Every file the package owns, not just those under src/: a helper at the
// package root would otherwise be an unguarded region.
for (const sourceFile of sourceFiles) {
    const filePath = path.resolve(sourceFile.fileName);
    if (!isInPackage(filePath)) continue;
    const file = path.relative(pkgDir, filePath);

    for (const { fileName } of sourceFile.typeReferenceDirectives) {
        ambientReferences.push({ file, kind: 'types', name: fileName });
    }
    for (const { fileName } of sourceFile.libReferenceDirectives) {
        ambientReferences.push({ file, kind: 'lib', name: fileName });
    }
    for (const { fileName } of sourceFile.referencedFiles) {
        ambientReferences.push({ file, kind: 'path', name: fileName });
    }
    for (const escape of collectGlobalEscapes(sourceFile)) {
        globalEscapes.push({ file, ...escape });
    }
    for (const specifier of collectSpecifiers(sourceFile)) {
        if (specifier.startsWith('@beaver/agent-core/')) continue;
        // No legitimate specifier names node_modules. Spelling it out is the
        // one way to reach a dependency's files without naming the
        // dependency, and it works from a relative specifier too.
        if (specifier.split('/').includes('node_modules')) {
            disallowedSpecifiers.push({
                file,
                specifier,
                reason: 'names node_modules directly',
            });
            continue;
        }
        if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
            const resolved = path.resolve(path.dirname(filePath), specifier);
            if (!isInPackage(resolved)) {
                disallowedSpecifiers.push({ file, specifier, reason: 'escapes the package' });
            }
            continue;
        }
        disallowedSpecifiers.push({
            file,
            specifier,
            reason: 'imports outside the package',
        });
    }
}

// And every file physically on disk under src/ must be in the closure — an
// orphan would sit in the package outside this gate's typecheck, and outside
// the eslint block scoped to packages/agent-local/src/**, which only matters
// for a file actually part of a checked program.
const onDisk = readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(d.name))
    .map((d) => path.resolve(d.parentPath ?? d.path, d.name));
const orphans = onDisk.filter((f) => !closureSet.has(f));

if (
    errors.length > 0 ||
    unlisted.length > 0 ||
    stale.length > 0 ||
    escapees.length > 0 ||
    disallowedSpecifiers.length > 0 ||
    ambientReferences.length > 0 ||
    globalEscapes.length > 0 ||
    orphans.length > 0
) {
    console.error('agent-local program verification failed:');
    for (const message of errors) {
        console.error(`  - ${message}`);
    }
    for (const f of unlisted) {
        console.error(
            `  - reachable from the entry but not in tsconfig files: ${path.relative(pkgDir, f)}`
        );
    }
    for (const f of stale) {
        console.error(
            `  - listed in tsconfig files but not reachable from the entry: ${path.relative(pkgDir, f)}`
        );
    }
    for (const f of escapees) {
        console.error(`  - in the closure but outside the package: ${f}`);
    }
    for (const { file, specifier, reason } of disallowedSpecifiers) {
        console.error(
            `  - ${file} imports '${specifier}' (${reason}) — only relative imports that resolve inside the package and '@beaver/agent-core/...' are allowed.`
        );
    }
    for (const { file, kind, name } of ambientReferences) {
        console.error(
            `  - ${file} has a /// <reference ${kind}="${name}" /> directive — declare the host global in globals.d.ts instead of pulling in ambient types.`
        );
    }
    for (const { file, kind, line } of globalEscapes) {
        console.error(
            kind === 'declare global'
                ? `  - ${file}:${line} has a \`declare global\` block — that would silently undo this package's types: [] isolation. Declare the global in globals.d.ts instead.`
                : `  - ${file}:${line} names \`globalThis\` — declare the narrow surface it needs in globals.d.ts and use that instead.`
        );
    }
    for (const f of orphans) {
        console.error(`  - on disk under src/ but not in the closure: ${path.relative(pkgDir, f)}`);
    }
    process.exit(1);
}
console.log(`agent-local program verified: ${listedSet.size} files.`);
