import type {ContextType} from 'react';
import type {
	CanUpdateSequencePropsResponse,
	OverrideIdToNodePaths,
	PropStatuses,
	SequenceNodePath,
	SequencePropsSubscriptionKey,
	TSequence,
} from 'remotion';
import {Internals} from 'remotion';
import {getBrowserStudioOperations} from '../../helpers/browser-studio-operations';
import {getTimelineNaturalMediaDuration} from '../../helpers/get-timeline-natural-media-duration';
import type {TimelineTrackData} from '../../helpers/get-timeline-sequence-sort-key';
import {isStudioSelectionEnabled} from '../../helpers/interactivity-enabled';
import {isVideoWithLastFrameHold} from '../../helpers/is-video-with-last-frame-hold';
import {getPreviewServerConnectionState} from '../../helpers/preview-server-events';
import {getCachedMediaMetadata} from '../../helpers/use-media-metadata';
import {createCanvasDragPreview} from '../canvas-drag-preview';
import {commitTimelineTimingEdit} from './commit-timeline-timing-edit';
import type {SaveSequencePropChange} from './save-sequence-prop';
import {
	getTimelineSequenceDurationDragChanges,
	getTimelineSequenceDurationDragTargets,
	getTimelineSequenceDurationDragValue,
	getTimelineSequenceEndFieldValue,
	getTimelineSequenceFromDragChanges,
	getTimelineSequenceFromDragDelta,
	getTimelineSequenceFromDragKeyframeMoves,
	getTimelineSequenceFromDragOverrides,
	getTimelineSequenceFromDragTargets,
	getTimelineSequenceLeftEdgeDragChanges,
	getTimelineSequenceLeftEdgeDragTargets,
	getTimelineSequenceLeftEdgeDragValuesForTarget,
	getTimelineSequenceMediaDurationDragLimits,
} from './TimelineSequenceRightEdgeDragHandle';

export type TimelineTimingActionContext = {
	tracks: readonly TimelineTrackData[];
	sequences: readonly TSequence[];
	propStatuses: PropStatuses;
	overrideIdsToNodePaths: OverrideIdToNodePaths;
	timelineDurationInFrames: number;
	visualModeSetters: ContextType<typeof Internals.VisualModeSettersContext>;
	getPropStatuses: (
		nodePath: SequencePropsSubscriptionKey,
	) => CanUpdateSequencePropsResponse | undefined;
};
export type TimelineTimingEditResult = {
	status: 'success' | 'no-op' | 'ineligible' | 'error';
	reason: string | null;
	changes: {
		absolutePath: string;
		nodePath: SequenceNodePath;
		fieldKey: string;
		value: unknown;
	}[];
	clamped: boolean;
	appliedDeltaFrames: number | null;
	appliedFrame: number | null;
};

export const canEditTimelineTiming = () =>
	isStudioSelectionEnabled() &&
	(getBrowserStudioOperations() !== null ||
		(!window.remotion_isReadOnlyStudio &&
			getPreviewServerConnectionState().type === 'connected'));

const editTimelineTiming = async ({
	sequenceIds,
	request,
	context,
}: {
	sequenceIds: readonly string[];
	request:
		| {operation: 'move'; deltaFrames: number}
		| {operation: 'trim-start' | 'trim-end'; frame: number};
	context: TimelineTimingActionContext;
}): Promise<TimelineTimingEditResult> => {
	const reject = (reason: string): TimelineTimingEditResult => ({
		status: 'ineligible',
		reason,
		changes: [],
		clamped: false,
		appliedDeltaFrames: null,
		appliedFrame: null,
	});
	const connection = getPreviewServerConnectionState();
	if (!canEditTimelineTiming() || connection.type !== 'connected')
		return reject('Connect to an editable Studio to edit clip timing.');
	if (
		sequenceIds.length === 0 ||
		new Set(sequenceIds).size !== sequenceIds.length
	)
		return reject('Choose distinct clips to edit.');
	const input =
		request.operation === 'move' ? request.deltaFrames : request.frame;
	if (!Number.isFinite(input) || !Number.isInteger(input))
		return reject('Use an integer composition frame.');
	if (
		request.operation !== 'move' &&
		(input < 0 || input > context.timelineDurationInFrames)
	)
		return reject('Choose a boundary within the composition.');
	const tracksById = new Map(
		context.tracks.map((track) => [track.sequence.id, track]),
	);
	const selectedTracks = sequenceIds.map((id) => tracksById.get(id));
	if (selectedTracks.some((track) => !track?.nodePathInfo))
		return reject(
			'The clip source is not ready. Wait for the preview to update, then try again.',
		);
	const tracks = selectedTracks.filter(
		(track): track is TimelineTrackData => track !== undefined,
	);
	if (
		tracks.some(
			(track) => track.nodePathInfo!.numberOfSequencesWithThisNodePath > 1,
		)
	)
		return reject(
			'This source creates multiple clips. Edit its code to change their timing together.',
		);
	if (
		tracks.some(
			(track) =>
				Internals.getPropStatusesCtx(
					context.propStatuses,
					track.nodePathInfo!.sequenceSubscriptionKey,
				) === undefined,
		)
	)
		return reject(
			'Waiting for clip source controls. Try again when they have loaded.',
		);
	const sequences = [...context.sequences];
	const selections = tracks.map((track) => ({
		type: 'sequence' as const,
		nodePathInfo: track.nodePathInfo!,
	}));
	const firstTrack = tracks[0];
	const visibleEnd = Math.min(
		context.timelineDurationInFrames,
		firstTrack.parentVisibleEnd ?? Infinity,
		firstTrack.sequence.from + firstTrack.sequence.duration,
	);
	const common = {
		draggedNodePathInfo: firstTrack.nodePathInfo!,
		selectedItems: selections,
		sequences,
		tracks: context.tracks,
		propStatuses: context.propStatuses,
	};
	let changes: SaveSequencePropChange[];
	let appliedDeltaFrames: number;
	let appliedFrame: number | null = null;
	let movedKeyframes: Parameters<
		typeof commitTimelineTimingEdit
	>[0]['movedKeyframes'] = null;
	let moveOverrides: ReturnType<
		typeof getTimelineSequenceFromDragOverrides
	> | null = null;
	let durationOverride: {
		nodePath: SequencePropsSubscriptionKey;
		key: string;
		value: number;
	} | null = null;
	const requestedDelta =
		request.operation === 'move'
			? request.deltaFrames
			: request.frame -
				(request.operation === 'trim-end'
					? visibleEnd
					: firstTrack.sequence.from);
	if (request.operation === 'move') {
		const selectedIds = new Set(sequenceIds);
		const sequencesById = new Map(
			sequences.map((sequence) => [sequence.id, sequence]),
		);
		for (const sequence of sequences) {
			let ancestor: TSequence | undefined = sequence;
			while (ancestor && !selectedIds.has(ancestor.id))
				ancestor =
					ancestor.parent === null
						? undefined
						: sequencesById.get(ancestor.parent);
			if (!ancestor || !sequence.controls) continue;
			const path = context.overrideIdsToNodePaths[sequence.controls.overrideId];
			if (!path || !context.getPropStatuses(path)?.canUpdate)
				return reject(
					'Waiting for the clip and its child source controls. Try again when they have loaded.',
				);
		}

		const targets = getTimelineSequenceFromDragTargets({
			...common,
			overrideIdsToNodePaths: context.overrideIdsToNodePaths,
		});
		if (!targets || targets.length === 0)
			return reject(
				'These clips cannot be moved with their current source timing.',
			);
		appliedDeltaFrames = getTimelineSequenceFromDragDelta({
			targets,
			deltaFrames: request.deltaFrames,
			timelineDurationInFrames: context.timelineDurationInFrames,
			pxPerFrame: 1,
			snappingEnabled: false,
		});
		changes = getTimelineSequenceFromDragChanges({
			targets,
			deltaFrames: appliedDeltaFrames,
		});
		movedKeyframes = getTimelineSequenceFromDragKeyframeMoves({
			targets,
			deltaFrames: appliedDeltaFrames,
		});
		moveOverrides = getTimelineSequenceFromDragOverrides({
			targets,
			deltaFrames: appliedDeltaFrames,
		});
	} else if (request.operation === 'trim-start') {
		const targets = getTimelineSequenceLeftEdgeDragTargets({
			...common,
			timelineDurationInFrames: context.timelineDurationInFrames,
			trimBeforeOnly: false,
			rippleEdit: false,
		});
		if (!targets || targets.length !== 1 || targets[0].positionField === null)
			return reject(
				'This clip needs a rolling or ripple edit in the timeline to change its start.',
			);
		const values = getTimelineSequenceLeftEdgeDragValuesForTarget({
			target: targets[0],
			deltaFrames: requestedDelta,
			trimBeforeOnly: false,
		});
		appliedDeltaFrames =
			(values.from - targets[0].initialFrom) / targets[0].parentPlaybackRate;
		appliedFrame = firstTrack.sequence.from + appliedDeltaFrames;
		changes = getTimelineSequenceLeftEdgeDragChanges({
			targets,
			deltaFrames: requestedDelta,
			trimBeforeOnly: false,
		});
	} else {
		const {sequence} = firstTrack;
		let mediaLimits: ReturnType<
			typeof getTimelineSequenceMediaDurationDragLimits
		> = null;
		if (
			(sequence.type === 'audio' || sequence.type === 'video') &&
			!sequence.loopDisplay
		) {
			const metadata = getCachedMediaMetadata(sequence.src);
			const fps = sequence.controls?.videoConfigValues?.fps;
			if (!metadata || !fps)
				return reject(
					'Wait for the media duration to load before trimming this clip.',
				);
			const naturalMediaDuration = getTimelineNaturalMediaDuration({
				sequence,
				sequenceFrameOffset: firstTrack.sequenceFrameOffset,
				mediaMetadata: metadata,
				fps,
			});
			const status = Internals.getPropStatusesCtx(
				context.propStatuses,
				firstTrack.nodePathInfo!.sequenceSubscriptionKey,
			)?.durationInFrames;
			const explicitDuration =
				status?.status === 'static' &&
				typeof status.codeValue === 'number' &&
				Number.isFinite(status.codeValue)
					? status.codeValue
					: null;
			mediaLimits = getTimelineSequenceMediaDurationDragLimits({
				cascadedStart: firstTrack.cascadedStart,
				displayDurationInFrames: sequence.duration,
				displayStart: sequence.from,
				effectiveMaxMediaDuration: isVideoWithLastFrameHold(sequence)
					? Infinity
					: naturalMediaDuration,
				explicitDurationInFrames:
					explicitDuration === null
						? null
						: explicitDuration / sequence.playbackRate,
				naturalMediaDuration,
				timelineDurationInFrames: context.timelineDurationInFrames,
			});
		}

		const targets = getTimelineSequenceDurationDragTargets({
			...common,
			timelineDurationInFrames: context.timelineDurationInFrames,
			draggedSequenceMediaDurationDragLimits: mediaLimits,
			selectedSequenceMediaDurationDragLimits: null,
		});
		if (!targets || targets.length !== 1)
			return reject(
				'This clip cannot be resized with its current source timing.',
			);
		if (requestedDelta === 0)
			return {
				status: 'no-op',
				reason: null,
				changes: [],
				clamped: false,
				appliedDeltaFrames: 0,
				appliedFrame: visibleEnd,
			};
		const originalTarget = targets[0];
		// Absolute boundaries are measured from the source's start, including
		// authored frames hidden by an ancestor. An unbounded duration needs a
		// finite baseline for the existing delta-based trim calculation.
		const target = Number.isFinite(originalTarget.initialDuration)
			? originalTarget
			: {
					...originalTarget,
					initialDuration:
						(visibleEnd - firstTrack.cascadedStart) *
						originalTarget.parentPlaybackRate,
				};
		const sourceDelta =
			request.frame -
			firstTrack.cascadedStart -
			target.initialDuration / target.parentPlaybackRate;
		const duration = getTimelineSequenceDurationDragValue({
			initialDuration: target.initialDuration,
			deltaFrames: sourceDelta * target.parentPlaybackRate,
			minimumDuration: target.minimumDuration,
			maximumDuration: target.maximumDuration,
		});
		appliedFrame = Math.min(
			context.timelineDurationInFrames,
			firstTrack.parentVisibleEnd ?? Infinity,
			firstTrack.cascadedStart + duration / target.parentPlaybackRate,
		);
		appliedDeltaFrames = appliedFrame - visibleEnd;
		changes = getTimelineSequenceDurationDragChanges({
			targets: [target],
			deltaFrames: sourceDelta,
		});
		durationOverride = {
			nodePath: target.nodePath,
			key: target.endField.fieldKey,
			value: getTimelineSequenceEndFieldValue({
				endField: target.endField,
				durationInFrames: duration,
			}),
		};
	}

	if (
		!Number.isFinite(appliedDeltaFrames) ||
		(appliedFrame !== null && !Number.isFinite(appliedFrame))
	)
		return reject(
			'The clip timing is not ready to be edited. Wait for the preview to update, then try again.',
		);
	const clamped = Math.abs(appliedDeltaFrames - requestedDelta) > 1e-9;
	if (
		changes.length === 0 &&
		(!movedKeyframes ||
			(movedKeyframes.sequenceKeyframes.length === 0 &&
				movedKeyframes.effectKeyframes.length === 0))
	)
		return {
			status: 'no-op',
			reason: null,
			changes: [],
			clamped,
			appliedDeltaFrames,
			appliedFrame,
		};
	const preview = createCanvasDragPreview({
		updateDragOverrides: context.visualModeSetters.updateDragOverrides,
		setPropStatuses: context.visualModeSetters.setPropStatuses,
		setPropStatusesBatch: context.visualModeSetters.setPropStatusesBatch,
		getPropStatuses: context.getPropStatuses,
	});
	preview.setDragOverridesBatch(
		moveOverrides?.updates ??
			(durationOverride
				? [
						{
							...durationOverride,
							value: Internals.makeStaticDragOverride(durationOverride.value),
						},
					]
				: changes.map((change) => ({
						nodePath: change.nodePath,
						key: change.fieldKey,
						value: Internals.makeStaticDragOverride(change.value),
					}))),
		context.visualModeSetters.updateDragOverridesBatch,
	);
	if (moveOverrides)
		preview.setEffectDragOverridesBatch(
			moveOverrides.effectUpdates,
			context.visualModeSetters.updateEffectDragOverridesBatch,
		);
	const result = await commitTimelineTimingEdit({
		preview,
		changes,
		movedKeyframes,
		clientId: connection.clientId,
		operation: request.operation,
		undoLabel:
			request.operation === 'move'
				? 'Move selected sequences'
				: 'Resize sequence',
		redoLabel:
			request.operation === 'move'
				? 'Move selected sequences back'
				: 'Resize sequence back',
	});
	return {
		status: result.success ? 'success' : 'error',
		reason: result.success ? null : result.reason,
		changes: result.success
			? changes.map((change) => ({
					absolutePath: change.nodePath.absolutePath,
					nodePath: change.nodePath.nodePath,
					fieldKey: change.fieldKey,
					value: change.value,
				}))
			: [],
		clamped,
		appliedDeltaFrames: result.success ? appliedDeltaFrames : null,
		appliedFrame: result.success ? appliedFrame : null,
	};
};

export const moveTimelineSequences = ({
	sequenceIds,
	deltaFrames,
	context,
}: {
	sequenceIds: string[];
	deltaFrames: number;
	context: TimelineTimingActionContext;
}) =>
	editTimelineTiming({
		sequenceIds,
		request: {operation: 'move', deltaFrames},
		context,
	});
export const trimTimelineSequence = ({
	sequenceId,
	edge,
	frame,
	context,
}: {
	sequenceId: string;
	edge: 'start' | 'end';
	frame: number;
	context: TimelineTimingActionContext;
}) =>
	editTimelineTiming({
		sequenceIds: [sequenceId],
		request: {operation: edge === 'start' ? 'trim-start' : 'trim-end', frame},
		context,
	});
