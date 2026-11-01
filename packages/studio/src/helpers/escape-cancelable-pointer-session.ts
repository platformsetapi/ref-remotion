import {
	startCapturedPointerSession,
	startDeferredCapturedPointerSession,
} from './pointer-session';

const withEscapeCancellation = <
	Options extends {
		onEnd: Parameters<typeof startCapturedPointerSession>[0]['onEnd'];
	},
>(
	startSession: (options: Options) => () => void,
) => {
	return (options: Options): (() => void) => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') {
				return;
			}

			// Cancel before Escape reaches selection or menu shortcuts.
			event.preventDefault();
			event.stopImmediatePropagation();
			stopSession();
		};

		const stopSession = startSession({
			...options,
			onEnd: (reason, event) => {
				window.removeEventListener('keydown', onKeyDown, true);
				options.onEnd(reason, event);
			},
		});
		window.addEventListener('keydown', onKeyDown, true);
		return stopSession;
	};
};

export const startEscapeCancelableCapturedPointerSession =
	withEscapeCancellation(startCapturedPointerSession);

export const startEscapeCancelableDeferredPointerSession =
	withEscapeCancellation(startDeferredCapturedPointerSession);
