import {PlayerInternals} from '@remotion/player';
import type React from 'react';
import {useCallback, useContext, useEffect} from 'react';
import {Internals} from 'remotion';
import {useIsVideoComposition} from '../helpers/is-current-selected-still';
import {useKeybinding} from '../helpers/use-keybinding';
import {stepPlaybackRate} from '../state/playbackrate';
import {toggleLoop} from './LoopToggle';
import {toggleMute} from './MuteToggle';

export const PlaybackKeyboardShortcutsManager: React.FC<{
	readonly setPlaybackRate: React.Dispatch<React.SetStateAction<number>>;
	readonly setMuted: React.Dispatch<React.SetStateAction<boolean>>;
	readonly setLoop: React.Dispatch<React.SetStateAction<boolean>>;
}> = ({setPlaybackRate, setMuted, setLoop}) => {
	const keybindings = useKeybinding();
	const isVideoComposition = useIsVideoComposition();
	const {canvasContent} = useContext(Internals.CompositionManager);
	const isOutput =
		canvasContent?.type === 'output' || canvasContent?.type === 'output-blob';

	useEffect(() => {
		if (!isVideoComposition) {
			return;
		}

		const mute = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'toggleMute',
			callback: (event) => {
				if (!event.repeat) toggleMute(setMuted);
			},
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});
		const loop = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'toggleLoop',
			callback: (event) => {
				if (!event.repeat) toggleLoop(setLoop);
			},
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});
		return () => {
			mute.unregister();
			loop.unregister();
		};
	}, [isVideoComposition, keybindings, setLoop, setMuted]);

	const {play, pause, isPlaying} = PlayerInternals.usePlayerMethods();

	const onJKey = useCallback(() => {
		const wasPlaying = isPlaying();
		setPlaybackRate((prevPlaybackRate) => {
			if (!wasPlaying) {
				return -1;
			}

			if (prevPlaybackRate > -1) {
				return -1;
			}

			if (prevPlaybackRate > -2) {
				return -2;
			}

			return -4;
		});
		play();
	}, [isPlaying, play, setPlaybackRate]);

	const onKKey = useCallback(() => {
		setPlaybackRate(1);
		pause();
	}, [pause, setPlaybackRate]);

	const onLKey = useCallback(() => {
		const wasPlaying = isPlaying();
		setPlaybackRate((prevPlaybackRate) => {
			if (!wasPlaying) {
				return 1;
			}

			if (prevPlaybackRate < 1) {
				return 1;
			}

			if (prevPlaybackRate < 2) {
				return 2;
			}

			return 4;
		});
		play();
	}, [isPlaying, play, setPlaybackRate]);

	useEffect(() => {
		if (isOutput) return;
		const jKey = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'reversePlayback',
			callback: onJKey,
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});
		const kKey = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'pausePlayback',
			callback: onKKey,
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});
		const lKey = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'playForward',
			callback: onLKey,
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});

		const decrease = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'decreasePlaybackRate',
			callback: () => {
				setPlaybackRate((prevPlaybackRate) =>
					stepPlaybackRate(prevPlaybackRate, -1),
				);
			},
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});
		const increase = keybindings.registerKeybinding({
			event: 'keydown',
			action: 'increasePlaybackRate',
			callback: () => {
				setPlaybackRate((prevPlaybackRate) =>
					stepPlaybackRate(prevPlaybackRate, 1),
				);
			},
			preventDefault: true,
			triggerIfInputFieldFocused: false,
			keepRegisteredWhenNotHighestContext: false,
		});

		return () => {
			jKey.unregister();
			kKey.unregister();
			lKey.unregister();
			decrease.unregister();
			increase.unregister();
		};
	}, [isOutput, keybindings, onJKey, onKKey, onLKey, setPlaybackRate]);

	return null;
};
