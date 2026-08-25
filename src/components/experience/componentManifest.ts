export const WEB_EXPERIENCE_COMPONENT_MANIFEST = {
    canonicalPaths: [
        'src/components/experience/ExperienceAction.tsx',
        'src/components/experience/ExperienceAvatar.tsx',
        'src/components/experience/ExperienceChip.tsx',
        'src/components/experience/ExperienceMediaCard.tsx',
        'src/components/experience/ExperienceOverlay.tsx',
        'src/components/experience/ExperienceProgress.tsx',
        'src/components/experience/experiencePrimitives.scss'
    ],
    componentIds: [
        'atom.action',
        'atom.avatar',
        'atom.chip',
        'atom.focus-indicator',
        'atom.progress',
        'atom.protection-scrim',
        'molecule.media-card',
        'molecule.modal-layer'
    ],
    contractVersion: '2.0.0',
    evidenceRoot: 'specs/003-cross-platform-experience-hardening-and-tv-release/web-component-conformance-evidence.md',
    fixturePath: 'src/components/experience/ExperiencePrimitivesFixture.tsx',
    inputModes: [ 'assistive', 'keyboard', 'pointer', 'touch' ],
    motionModes: [ 'default', 'reduced' ],
    platform: 'web',
    requiredAvailabilityStates: [ 'ready', 'loading', 'disabled', 'restricted', 'locked', 'error', 'empty' ],
    requiredInteractionStates: [ 'rest', 'hovered', 'focused', 'pressed' ],
    theme: 'all-supported'
} as const;
