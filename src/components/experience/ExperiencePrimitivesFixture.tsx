import Lock from '@mui/icons-material/Lock';
import PlayArrow from '@mui/icons-material/PlayArrow';
import React, { type FC, useCallback, useState } from 'react';

import { ExperienceAction } from './ExperienceAction';
import { ExperienceAvatar } from './ExperienceAvatar';
import { ExperienceChip } from './ExperienceChip';
import { ExperienceMediaCard } from './ExperienceMediaCard';
import { ExperienceOverlay } from './ExperienceOverlay';
import { ExperienceProgress } from './ExperienceProgress';
import './experiencePrimitives.scss';

const noOp = () => undefined;

export const ExperiencePrimitivesFixture: FC = () => {
    const [overlayOpen, setOverlayOpen] = useState(false);
    const openOverlay = useCallback(() => setOverlayOpen(true), []);
    const closeOverlay = useCallback(() => setOverlayOpen(false), []);

    return (
        <main className='experience-fixture' data-contract-version='2.0.0' data-testid='experience-primitives-fixture'>
            <h1>Experience primitives</h1>
            <section aria-labelledby='fixture-actions'>
                <h2 id='fixture-actions'>Actions and chips</h2>
                <div className='experience-fixture__row'>
                    <ExperienceAction icon={<PlayArrow />} label='Play' onActivate={noOp} variant='primary' />
                    <ExperienceAction label='Details' onActivate={noOp} variant='secondary' />
                    <ExperienceAction label='More' onActivate={noOp} variant='tertiary' />
                    <ExperienceAction label='Remove' onActivate={noOp} variant='destructive' />
                    <ExperienceAction availability='loading' label='Loading' onActivate={noOp} />
                    <ExperienceAction availability='disabled' label='Disabled' onActivate={noOp} />
                    <ExperienceAction icon={<Lock />} label='Locked action' onActivate={noOp} presentation='icon-only' />
                </div>
                <div className='experience-fixture__row'>
                    <ExperienceChip count={12} label='Movies' onActivate={noOp} selected />
                    <ExperienceChip availability='disabled' label='Unavailable' onActivate={noOp} />
                    <ExperienceChip availability='restricted' label='Restricted' onActivate={noOp} />
                </div>
            </section>
            <section aria-labelledby='fixture-avatars'>
                <h2 id='fixture-avatars'>Avatars and progress</h2>
                <div className='experience-fixture__row'>
                    <ExperienceAvatar name='Nacho Larreta' />
                    <ExperienceAvatar availability='locked' name='Kids' />
                    <ExperienceAvatar availability='restricted' name='Guest' />
                </div>
                <ExperienceProgress bufferedValue={72} label='Playback progress' value={46} />
                <ExperienceProgress label='Buffering playback' state='loading' />
                <ExperienceProgress label='Playback progress unavailable' state='error' />
            </section>
            <section aria-labelledby='fixture-media'>
                <h2 id='fixture-media'>Media cards</h2>
                <div className='experience-fixture__grid'>
                    <ExperienceMediaCard onActivate={noOp} progress={{ label: 'Episode progress', value: 34 }} subtitle='Episode 4' title='Continue watching' />
                    <ExperienceMediaCard active onActivate={noOp} selected subtitle='Now playing' title='Current movie' />
                    <ExperienceMediaCard availability='locked' onActivate={noOp} title='Locked movie' />
                    <ExperienceMediaCard availability='restricted' onActivate={noOp} title='Restricted movie' />
                    <ExperienceMediaCard availability='loading' onActivate={noOp} title='Loading' />
                    <ExperienceMediaCard availability='empty' onActivate={noOp} title='Empty' />
                    <ExperienceMediaCard availability='error' onActivate={noOp} title='Error' />
                </div>
            </section>
            <section aria-labelledby='fixture-overlay'>
                <h2 id='fixture-overlay'>Overlay</h2>
                <ExperienceAction id='fixture-overlay-trigger' label='Open settings' onActivate={openOverlay} />
                <ExperienceOverlay
                    actions={<ExperienceAction label='Close settings' onActivate={closeOverlay} variant='secondary' />}
                    description='Focus stays in this layer and returns to the trigger when the layer closes.'
                    initialFocusId='fixture-overlay-first-control'
                    label='Playback settings'
                    onClose={closeOverlay}
                    open={overlayOpen}
                    triggerId='fixture-overlay-trigger'
                >
                    <ExperienceChip id='fixture-overlay-first-control' label='English audio' onActivate={noOp} selected />
                    <ExperienceChip label='Spanish audio' onActivate={noOp} />
                </ExperienceOverlay>
            </section>
            <p className='experience-fixture__reflow-copy'>
                This deliberately long fixture copy verifies that controls and content reflow without horizontal clipping when Chrome page zoom is set to two hundred percent.
            </p>
        </main>
    );
};
