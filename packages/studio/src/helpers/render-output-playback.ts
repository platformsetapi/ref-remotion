import type {CanvasContent} from 'remotion';

export type RenderOutputPlaybackContent = Extract<
	CanvasContent,
	{type: 'output' | 'output-blob'}
>;
export type RenderOutputPlaybackState = {
	frame: number;
	fps: number;
	durationInFrames: number;
	playing: boolean;
	playbackRate: number;
	muted: boolean;
	volume: number;
	loop: boolean;
};
export type RenderOutputPlaybackTarget = {
	id: string;
	getState: () => RenderOutputPlaybackState;
	play: () => Promise<void>;
	pause: () => void;
	seekToFrame: (frame: number) => void;
	setPlaybackRate: (rate: number) => void;
	setMuted: (muted: boolean) => void;
	setVolume: (volume: number) => void;
	setLoop: (loop: boolean) => void;
};
type Registration = {
	content: RenderOutputPlaybackContent;
	element: HTMLMediaElement;
	getFps: () => number | null;
	target: RenderOutputPlaybackTarget;
};
let current: Registration | null = null;

const isReady = (entry: Registration) => {
	const fps = entry.getFps();
	return (
		current === entry &&
		entry.element.isConnected &&
		entry.element.error === null &&
		entry.element.readyState >= 1 &&
		Number.isFinite(entry.element.duration) &&
		entry.element.duration > 0 &&
		fps !== null &&
		Number.isFinite(fps) &&
		fps > 0
	);
};

export const getRenderOutputPlaybackTarget = (
	content: CanvasContent | null,
): RenderOutputPlaybackTarget | null => {
	if (!current || !content || !isReady(current)) return null;
	if (
		content.type === 'output' &&
		current.content.type === 'output' &&
		content.path === current.content.path
	)
		return current.target;
	if (
		content.type === 'output-blob' &&
		current.content.type === 'output-blob' &&
		content.getBlob === current.content.getBlob &&
		content.displayName === current.content.displayName
	)
		return current.target;
	return null;
};

export const registerRenderOutputPlayback = ({
	content,
	element,
	getFps,
}: {
	content: RenderOutputPlaybackContent;
	element: HTMLMediaElement;
	getFps: () => number | null;
}) => {
	const requireCurrent = () => {
		if (!isReady(entry))
			throw new Error(
				'The rendered output preview changed or is not ready. Try again after it loads.',
			);
	};

	const target: RenderOutputPlaybackTarget = {
		id:
			content.type === 'output'
				? `output:${content.path}`
				: `output-blob:${content.displayName}`,
		getState: () => {
			requireCurrent();
			const fps = getFps()!;
			const durationInFrames = Math.max(1, Math.ceil(element.duration * fps));
			return {
				frame: Math.min(
					durationInFrames - 1,
					Math.max(0, Math.floor(element.currentTime * fps + 1e-7)),
				),
				fps,
				durationInFrames,
				playing: !element.paused && !element.ended,
				playbackRate: element.playbackRate,
				muted: element.muted,
				volume: element.volume,
				loop: element.loop,
			};
		},
		play: async () => {
			requireCurrent();
			await element.play();
			if (!isReady(entry)) {
				if (current?.element !== element) element.pause();
				throw new Error(
					'The rendered output preview changed while playback was starting.',
				);
			}
		},
		pause: () => {
			requireCurrent();
			element.pause();
		},
		seekToFrame: (frame) => {
			const state = target.getState();
			if (
				!Number.isInteger(frame) ||
				frame < 0 ||
				frame >= state.durationInFrames
			)
				throw new Error(
					`Frame must be between 0 and ${state.durationInFrames - 1}.`,
				);
			element.currentTime = frame / state.fps;
		},
		setPlaybackRate: (rate) => {
			requireCurrent();
			if (!Number.isFinite(rate) || rate <= 0)
				throw new Error(
					'Rendered output playback rate must be a positive number.',
				);
			element.playbackRate = rate;
		},
		setMuted: (muted) => {
			requireCurrent();
			element.muted = muted;
		},
		setVolume: (volume) => {
			requireCurrent();
			if (!Number.isFinite(volume) || volume < 0 || volume > 1)
				throw new Error('Volume must be between 0 and 1.');
			element.volume = volume;
		},
		setLoop: (loop) => {
			requireCurrent();
			element.loop = loop;
		},
	};
	const entry: Registration = {content, element, getFps, target};
	if (current && current.element !== element) current.element.pause();
	current = entry;
	return () => {
		if (current === entry) {
			current = null;
			element.pause();
		} else if (current?.element !== element) element.pause();
	};
};
