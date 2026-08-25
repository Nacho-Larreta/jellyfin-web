import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    cpSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve
} from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = fileURLToPath(import.meta.url);
const testPath = 'src/themes/semantic/semanticTokens.test.ts';
const vitestCli = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
const lockPath = resolve(repoRoot, '.semantic-token-mutation.lock');
const lockInitializerPrefix = '.semantic-token-mutation.lock-initializer-';
const recoveryMarker = resolve(repoRoot, '.semantic-token-mutation-recovery.json');
const recoveryMarkerTemp = `${recoveryMarker}.tmp`;
const isolatedWorkspacePrefix = 'jellyfin-semantic-token-mutations-';
const gateArguments = [
    vitestCli,
    '--watch=false',
    '--config',
    'vite.config.ts',
    '--run',
    testPath
];

let activeOwner;

const digest = source => createHash('sha256').update(source).digest('hex');

const resolveWorkspacePath = (workspaceRoot, path) => {
    const absolutePath = resolve(workspaceRoot, path);
    const relativePath = relative(workspaceRoot, absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Mutation path escapes isolated workspace: ${path}`);
    }
    return absolutePath;
};

const assertIsolatedWorkspace = workspaceRoot => {
    const relativePath = relative(tmpdir(), workspaceRoot);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || !basename(workspaceRoot).startsWith(isolatedWorkspacePrefix)) {
        throw new Error(`Refusing to manage non-isolated workspace: ${workspaceRoot}`);
    }
};

const allocateIsolatedWorkspace = () => mkdtempSync(join(tmpdir(), isolatedWorkspacePrefix));

const populateIsolatedWorkspace = workspaceRoot => {
    assertIsolatedWorkspace(workspaceRoot);
    mkdirSync(resolve(workspaceRoot, 'src'));
    cpSync(resolve(repoRoot, 'src/themes'), resolve(workspaceRoot, 'src/themes'), { recursive: true });
    for (const file of [ 'package.json', 'tsconfig.json', 'vite.config.ts' ]) {
        cpSync(resolve(repoRoot, file), resolve(workspaceRoot, file));
    }
    symlinkSync(
        resolve(repoRoot, 'node_modules'),
        resolve(workspaceRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
    );
};

const removeIsolatedWorkspace = workspaceRoot => {
    assertIsolatedWorkspace(workspaceRoot);
    rmSync(workspaceRoot, { force: true, recursive: true });
};

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

const readLockOwner = () => existsSync(lockPath) ? readJson(lockPath) : undefined;

const assertLockOwner = ownerId => {
    const lockOwner = readLockOwner();
    if (!lockOwner || lockOwner.ownerId !== ownerId) {
        throw new Error(`Mutation lock is not owned by ${ownerId}`);
    }
    return lockOwner;
};

const prepareLockOwner = workspaceRoot => {
    const ownerId = randomUUID();
    const initializerPath = resolve(repoRoot, `${lockInitializerPrefix}${ownerId}.tmp`);
    const owner = {
        initializerPath,
        ownerId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        workspaceRoot
    };
    writeFileSync(initializerPath, JSON.stringify(owner));
    return owner;
};

const publishPreparedLock = owner => {
    try {
        linkSync(owner.initializerPath, lockPath);
    } catch (error) {
        const existingOwner = readLockOwner();
        const ownerDescription = existingOwner ? JSON.stringify(existingOwner) : 'owner metadata unavailable';
        throw new Error(`Semantic token mutation lock is already owned: ${ownerDescription}`, { cause: error });
    } finally {
        if (existsSync(owner.initializerPath)) unlinkSync(owner.initializerPath);
    }
    return owner;
};

const acquireLock = workspaceRoot => publishPreparedLock(prepareLockOwner(workspaceRoot));

const releaseLock = ownerId => {
    const owner = assertLockOwner(ownerId);
    if (existsSync(recoveryMarker) || existsSync(recoveryMarkerTemp)) {
        throw new Error('Cannot release mutation lock while recovery state exists');
    }
    unlinkSync(lockPath);
    if (existsSync(owner.initializerPath)) unlinkSync(owner.initializerPath);
};

const promoteRecoveryMarkerTemp = ownerId => {
    if (existsSync(recoveryMarker) || !existsSync(recoveryMarkerTemp)) return;
    const recovery = readJson(recoveryMarkerTemp);
    if (recovery.ownerId !== ownerId) {
        throw new Error(`Temporary recovery marker belongs to ${recovery.ownerId}; current owner is ${ownerId}`);
    }
    renameSync(recoveryMarkerTemp, recoveryMarker);
};

const readOwnedRecovery = ownerId => {
    assertLockOwner(ownerId);
    promoteRecoveryMarkerTemp(ownerId);
    if (!existsSync(recoveryMarker)) return undefined;

    const recovery = readJson(recoveryMarker);
    if (recovery.ownerId !== ownerId) {
        throw new Error(`Recovery marker belongs to ${recovery.ownerId}; current owner is ${ownerId}`);
    }
    return recovery;
};

const persistRecoveryMarker = (ownerId, workspaceRoot, path, original, mutated) => {
    const owner = assertLockOwner(ownerId);
    if (owner.workspaceRoot !== workspaceRoot) throw new Error('Recovery workspace does not match lock owner');
    if (existsSync(recoveryMarker) || existsSync(recoveryMarkerTemp)) throw new Error('Recovery marker already exists');

    const recovery = {
        mutatedBase64: Buffer.from(mutated).toString('base64'),
        mutatedDigest: digest(mutated),
        originalBase64: Buffer.from(original).toString('base64'),
        originalDigest: digest(original),
        ownerId,
        path,
        workspaceRoot
    };
    writeFileSync(recoveryMarkerTemp, JSON.stringify(recovery));
    renameSync(recoveryMarkerTemp, recoveryMarker);
    return recovery;
};

const writeOwnedMutation = recovery => {
    assertLockOwner(recovery.ownerId);
    const absolutePath = resolveWorkspacePath(recovery.workspaceRoot, recovery.path);
    const currentDigest = digest(readFileSync(absolutePath, 'utf8'));
    if (currentDigest !== recovery.originalDigest) {
        throw new Error(
            `Pre-write mutation refused for ${recovery.path}: current digest ${currentDigest} changed from ${recovery.originalDigest}`
        );
    }

    const mutated = Buffer.from(recovery.mutatedBase64, 'base64').toString('utf8');
    writeFileSync(absolutePath, mutated);
    if (digest(readFileSync(absolutePath, 'utf8')) !== recovery.mutatedDigest) {
        throw new Error(`Owned mutation failed byte-exact verification for ${recovery.path}`);
    }
};

const reconcileOwnedMutation = ownerId => {
    const recovery = readOwnedRecovery(ownerId);
    if (!recovery) return undefined;

    const absolutePath = resolveWorkspacePath(recovery.workspaceRoot, recovery.path);
    const currentDigest = digest(readFileSync(absolutePath, 'utf8'));
    if (currentDigest !== recovery.mutatedDigest && currentDigest !== recovery.originalDigest) {
        throw new Error(
            `Manual recovery required for ${recovery.path}: current digest ${currentDigest} is neither owned mutation ${recovery.mutatedDigest} nor original ${recovery.originalDigest}`
        );
    }

    if (currentDigest === recovery.mutatedDigest) {
        const original = Buffer.from(recovery.originalBase64, 'base64').toString('utf8');
        writeFileSync(absolutePath, original);
    }
    if (digest(readFileSync(absolutePath, 'utf8')) !== recovery.originalDigest) {
        throw new Error(`Recovery failed byte-exact verification for ${recovery.path}`);
    }
    return recovery;
};

const finalizeOwnedRecovery = ownerId => {
    const recovery = readOwnedRecovery(ownerId);
    if (!recovery) return undefined;

    const absolutePath = resolveWorkspacePath(recovery.workspaceRoot, recovery.path);
    if (digest(readFileSync(absolutePath, 'utf8')) !== recovery.originalDigest) {
        throw new Error(`Cannot finalize recovery before original digest is restored for ${recovery.path}`);
    }
    unlinkSync(recoveryMarker);
    if (existsSync(recoveryMarkerTemp)) unlinkSync(recoveryMarkerTemp);
    return recovery;
};

const runGate = workspaceRoot => spawnSync(process.execPath, gateArguments, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: process.env
});

const assertGreen = (workspaceRoot, label, simulateFailure = false) => {
    const result = runGate(workspaceRoot);
    if (simulateFailure) throw new Error('Simulated forced-recovery gate failure');
    if (result.status !== 0) {
        throw new Error(`${label} did not produce a green gate:\n${result.stdout}\n${result.stderr}`);
    }
};

const assertIntendedRed = (workspaceRoot, expectedFailure, label) => {
    const result = runGate(workspaceRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(expectedFailure)) {
        throw new Error(`${label} did not make the intended gate red:\n${output}`);
    }
};

const cleanupActiveOwner = () => {
    if (!activeOwner) return true;

    try {
        const owner = assertLockOwner(activeOwner.ownerId);
        reconcileOwnedMutation(owner.ownerId);
        finalizeOwnedRecovery(owner.ownerId);
        if (!activeOwner.retainLock) {
            releaseLock(owner.ownerId);
            if (existsSync(owner.workspaceRoot)) removeIsolatedWorkspace(owner.workspaceRoot);
        }
        activeOwner = undefined;
        return true;
    } catch (error) {
        process.stderr.write(`${error.message}\nLock and recovery state were preserved for manual recovery.\n`);
        return false;
    }
};

const restoreAndExit = exitCode => {
    const cleaned = cleanupActiveOwner();
    process.exit(cleaned ? exitCode : 2);
};

process.on('SIGINT', () => restoreAndExit(130));
process.on('SIGTERM', () => restoreAndExit(143));
process.on('exit', () => cleanupActiveOwner());

const swapAliasTargets = source => {
    const primary = '--jf-palette-semantic-action-primary-container';
    const secondary = '--jf-palette-semantic-action-secondary-container';
    const placeholder = '--jf-palette-semantic-alias-swap-placeholder';
    return source
        .replace(primary, placeholder)
        .replace(secondary, primary)
        .replace(placeholder, secondary);
};

const appendSameLineAlias = source => source.replace(
    /}\s*$/,
    ' --jf-semantic-counterfeit: var(--jf-palette-semantic-action-primary-container); }'
);

const appendMultilineNonVarAlias = source => source.replace(
    /}\s*$/,
    '    --jf-semantic-counterfeit:\n        inherit;\n}'
);

const appendMissingColonAlias = source => source.replace(
    /}\s*$/,
    '    --jf-semantic-counterfeit var(--jf-palette-semantic-action-primary-container);\n}'
);

const appendMissingSemicolonAlias = source => source.replace(
    /}\s*$/,
    '    --jf-semantic-counterfeit: var(--jf-palette-semantic-action-primary-container)\n}'
);

const appendJunkBeforeColonAlias = source => source.replace(
    /}\s*$/,
    '    --jf-semantic-counterfeit garbage: var(--jf-palette-semantic-action-primary-container);\n}'
);

const mutationCases = [
    {
        expectedFailure: 'keeps raw values out of every guarded production mapping path',
        mutate: source => `${source}\nexport const RAW_TOKEN_MUTATION = { color: 'rebeccapurple', shape: '3px', space: '13rem', fontFamily: 'Papyrus', fontWeight: 500, type: 'clamp(1rem, 2vw, 3rem)', motion: '123ms', elevation: '0 2px 4px oklch(50% 0.2 20)' };\n`,
        name: 'raw-token-all-axis',
        path: 'src/themes/semantic/systemTokens.ts'
    },
    {
        expectedFailure: 'provides every required non-empty fill and ink pair',
        mutate: source => source.replace(
            "primary: pair(primaryActionContainer, 'onPrimary', primaryActionInk),",
            "primary: pair(primaryActionContainer, 'onPrimary', '   '),"
        ),
        name: 'empty-fill-ink-pair',
        path: 'src/themes/semantic/semanticTokens.ts'
    },
    {
        expectedFailure: 'records the complete allowed surface/role contrast matrix',
        mutate: source => source.replace(
            'foreground: resolveInformativeForeground(palette),',
            'foreground: palette.common.white,'
        ),
        name: 'contrast-surface-probe',
        path: 'src/themes/semantic/semanticTokens.ts'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: swapAliasTargets,
        name: 'semantic-alias-rhs-swap',
        path: 'src/themes/_base/_semantic.scss'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: appendSameLineAlias,
        name: 'semantic-alias-extra-same-line',
        path: 'src/themes/_base/_semantic.scss'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: appendMultilineNonVarAlias,
        name: 'semantic-alias-extra-multiline-non-var',
        path: 'src/themes/_base/_semantic.scss'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: appendMissingColonAlias,
        name: 'semantic-alias-malformed-missing-colon',
        path: 'src/themes/_base/_semantic.scss'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: appendMissingSemicolonAlias,
        name: 'semantic-alias-malformed-missing-semicolon',
        path: 'src/themes/_base/_semantic.scss'
    },
    {
        expectedFailure: 'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        mutate: appendJunkBeforeColonAlias,
        name: 'semantic-alias-malformed-junk-before-colon',
        path: 'src/themes/_base/_semantic.scss'
    }
];

const createRecovery = (owner, path, mutate) => {
    const absolutePath = resolveWorkspacePath(owner.workspaceRoot, path);
    const original = readFileSync(absolutePath, 'utf8');
    const mutated = mutate(original);
    if (mutated === original) throw new Error(`Mutation did not change ${path}`);
    return persistRecoveryMarker(owner.ownerId, owner.workspaceRoot, path, original, mutated);
};

const runForcedRecovery = (ownerId, options = []) => spawnSync(
    process.execPath,
    [ scriptPath, '--force-recovery', '--owner', ownerId, ...options ],
    {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env
    }
);

const readArgument = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};

const runForcedRecoveryMode = () => {
    const ownerId = readArgument('--owner');
    if (!ownerId) throw new Error('--force-recovery requires --owner <ownerId> from lock metadata');

    const owner = assertLockOwner(ownerId);
    const retainLock = process.argv.includes('--retain-lock');
    activeOwner = { ...owner, retainLock };
    const recovery = reconcileOwnedMutation(ownerId);

    assertGreen(
        owner.workspaceRoot,
        recovery ? 'forced recovery' : 'owner-only reconciliation',
        process.argv.includes('--probe-gate-failure')
    );
    finalizeOwnedRecovery(ownerId);

    if (process.argv.includes('--probe-signal-after-finalize')) {
        process.kill(process.pid, 'SIGTERM');
        setTimeout(() => {
            throw new Error('SIGTERM cleanup probe was not delivered');
        }, 1_000);
        return;
    }

    if (!retainLock) {
        releaseLock(ownerId);
        removeIsolatedWorkspace(owner.workspaceRoot);
    }
    activeOwner = undefined;
    process.stdout.write(`${JSON.stringify({ ownerId, recovered: Boolean(recovery), retained: retainLock })}\n`);
};

const assertOwnerStateAbsent = label => {
    if (existsSync(lockPath) || existsSync(recoveryMarker) || existsSync(recoveryMarkerTemp)) {
        throw new Error(`${label} left lock or recovery state behind`);
    }
};

const seedForcedRecoveryScenario = mutate => {
    const workspaceRoot = allocateIsolatedWorkspace();
    const owner = acquireLock(workspaceRoot);
    populateIsolatedWorkspace(workspaceRoot);
    const recovery = createRecovery(owner, 'src/themes/_base/_semantic.scss', mutate);
    writeOwnedMutation(recovery);
    return { owner, recovery };
};

const runForcedRecoveryLifecycleProbes = receipts => {
    const gateFailure = seedForcedRecoveryScenario(swapAliasTargets);
    const gateFailureResult = runForcedRecovery(gateFailure.owner.ownerId, [ '--probe-gate-failure' ]);
    if (gateFailureResult.status === 0 || !`${gateFailureResult.stdout}\n${gateFailureResult.stderr}`.includes('Simulated forced-recovery gate failure')) {
        throw new Error('Forced-recovery gate-failure probe did not fail as intended');
    }
    assertOwnerStateAbsent('forced-recovery gate-failure cleanup');
    receipts.push({ gateFailureCleanup: true, mutation: 'forced-recovery-gate-failure' });

    const signal = seedForcedRecoveryScenario(swapAliasTargets);
    const signalResult = runForcedRecovery(signal.owner.ownerId, [ '--probe-signal-after-finalize' ]);
    if (signalResult.status === 0) throw new Error('Forced-recovery signal probe did not terminate');
    assertOwnerStateAbsent('forced-recovery signal cleanup');
    receipts.push({ mutation: 'forced-recovery-post-finalize-signal', signalCleanup: true });

    const orphanedWorkspace = allocateIsolatedWorkspace();
    const orphanedOwner = acquireLock(orphanedWorkspace);
    populateIsolatedWorkspace(orphanedWorkspace);
    const orphanedResult = runForcedRecovery(orphanedOwner.ownerId);
    if (orphanedResult.status !== 0) {
        throw new Error(`Owner-only reconciliation failed:\n${orphanedResult.stdout}\n${orphanedResult.stderr}`);
    }
    assertOwnerStateAbsent('owner-only post-marker reconciliation');
    receipts.push({ mutation: 'post-marker-hard-crash-reconciliation', ownerOnlyRelease: true });
};

const runNormalMode = () => {
    if (existsSync(recoveryMarker) || existsSync(lockPath)) {
        const owner = readLockOwner();
        throw new Error(`Semantic token mutation state already exists; use explicit forced recovery with owner ${owner?.ownerId ?? 'unknown'}`);
    }

    const workspaceRoot = allocateIsolatedWorkspace();
    const abandonedInitializer = prepareLockOwner(workspaceRoot);
    if (existsSync(lockPath)) throw new Error('Prepared initializer unexpectedly published canonical lock');

    try {
        activeOwner = { ...acquireLock(workspaceRoot), retainLock: false };
    } catch (error) {
        removeIsolatedWorkspace(workspaceRoot);
        throw error;
    } finally {
        if (existsSync(abandonedInitializer.initializerPath)) unlinkSync(abandonedInitializer.initializerPath);
    }
    populateIsolatedWorkspace(workspaceRoot);

    const owner = activeOwner;
    const receipts = [{ atomicLockInitialization: true, ownerId: owner.ownerId }];
    const productionDigests = new Map(
        [ ...new Set(mutationCases.map(({ path }) => path)) ].map(path => [
            path,
            digest(readFileSync(resolve(repoRoot, path), 'utf8'))
        ])
    );

    const concurrentResult = spawnSync(process.execPath, [ scriptPath, '--concurrency-probe' ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: process.env
    });
    const concurrentOutput = `${concurrentResult.stdout}\n${concurrentResult.stderr}`;
    if (concurrentResult.status === 0 || !concurrentOutput.includes('state already exists')) {
        throw new Error(`Concurrent owner was not rejected:\n${concurrentOutput}`);
    }
    receipts.push({ concurrentOwnerRejected: true });

    assertGreen(workspaceRoot, 'isolated baseline');

    for (const mutation of mutationCases) {
        const recovery = createRecovery(owner, mutation.path, mutation.mutate);
        writeOwnedMutation(recovery);
        assertIntendedRed(workspaceRoot, mutation.expectedFailure, mutation.name);
        reconcileOwnedMutation(owner.ownerId);
        assertGreen(workspaceRoot, mutation.name);
        finalizeOwnedRecovery(owner.ownerId);
        receipts.push({
            isolated: true,
            mutation: mutation.name,
            path: mutation.path,
            red: true,
            restoredDigest: recovery.originalDigest,
            restoredGreen: true
        });
    }

    const prewriteRecovery = createRecovery(owner, 'src/themes/_base/_semantic.scss', swapAliasTargets);
    const prewritePath = resolveWorkspacePath(workspaceRoot, prewriteRecovery.path);
    const prewriteInterveningContent = appendSameLineAlias(readFileSync(prewritePath, 'utf8'));
    writeFileSync(prewritePath, prewriteInterveningContent);
    let prewriteRejected = false;
    try {
        writeOwnedMutation(prewriteRecovery);
    } catch (error) {
        prewriteRejected = error.message.includes('Pre-write mutation refused');
    }
    if (!prewriteRejected || readFileSync(prewritePath, 'utf8') !== prewriteInterveningContent) {
        throw new Error('Pre-write interleaving was overwritten or accepted');
    }
    writeFileSync(prewritePath, Buffer.from(prewriteRecovery.originalBase64, 'base64').toString('utf8'));
    reconcileOwnedMutation(owner.ownerId);
    assertGreen(workspaceRoot, 'pre-write interleaving controlled cleanup');
    finalizeOwnedRecovery(owner.ownerId);
    receipts.push({ contentPreserved: true, mutation: 'pre-write-interleaving-fail-closed' });

    const recoveryProbe = createRecovery(owner, 'src/themes/_base/_semantic.scss', swapAliasTargets);
    writeOwnedMutation(recoveryProbe);
    const recoveryResult = runForcedRecovery(owner.ownerId, [ '--retain-lock' ]);
    if (recoveryResult.status !== 0) {
        throw new Error(`Forced owner recovery failed:\n${recoveryResult.stdout}\n${recoveryResult.stderr}`);
    }
    receipts.push({ mutation: 'forced-owner-recovery', restoredDigest: recoveryProbe.originalDigest });

    const interveningRecovery = createRecovery(owner, 'src/themes/_base/_semantic.scss', swapAliasTargets);
    writeOwnedMutation(interveningRecovery);
    const interveningPath = resolveWorkspacePath(workspaceRoot, interveningRecovery.path);
    const interveningContent = appendSameLineAlias(readFileSync(interveningPath, 'utf8'));
    writeFileSync(interveningPath, interveningContent);
    let mismatchRejected = false;
    try {
        reconcileOwnedMutation(owner.ownerId);
    } catch (error) {
        mismatchRejected = error.message.includes('Manual recovery required');
    }
    if (!mismatchRejected || readFileSync(interveningPath, 'utf8') !== interveningContent) {
        throw new Error('Post-write intervening edit was overwritten or accepted');
    }
    assertIntendedRed(
        workspaceRoot,
        'maps every exact semantic alias LHS to its generated MUI RHS without extras',
        'post-write intervening edit no-false-green probe'
    );
    writeFileSync(interveningPath, Buffer.from(interveningRecovery.originalBase64, 'base64').toString('utf8'));
    reconcileOwnedMutation(owner.ownerId);
    assertGreen(workspaceRoot, 'post-write intervening edit controlled cleanup');
    finalizeOwnedRecovery(owner.ownerId);
    receipts.push({ contentPreserved: true, falseGreenRejected: true, mutation: 'post-write-intervening-edit-fail-closed' });

    for (const [ path, originalDigest ] of productionDigests) {
        if (digest(readFileSync(resolve(repoRoot, path), 'utf8')) !== originalDigest) {
            throw new Error(`Production source changed during isolated mutation verification: ${path}`);
        }
    }
    receipts.push({ mutation: 'production-source-isolation', productionSourcesUntouched: true });

    releaseLock(owner.ownerId);
    removeIsolatedWorkspace(workspaceRoot);
    activeOwner = undefined;
    runForcedRecoveryLifecycleProbes(receipts);
    process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
};

try {
    if (process.argv.includes('--force-recovery')) {
        runForcedRecoveryMode();
    } else {
        runNormalMode();
    }
} catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
}
