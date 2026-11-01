import type {
	SequenceNodePathMutation,
	SaveSequencePropsResponse,
} from '@remotion/studio-shared';
import type {ContextType} from 'react';
import type {
	CanUpdateSequencePropSource,
	CanUpdateSequencePropsResponse,
	DragOverrideValue,
	SequencePropsSubscriptionKey,
} from 'remotion';
import {Internals} from 'remotion';
import {deepEqual} from './RenderModal/SchemaEditor/deep-equal';
import type {SetPropStatuses} from './Timeline/save-sequence-prop';

type Setters = ContextType<typeof Internals.VisualModeSettersContext>;
type Layer = {
	value: DragOverrideValue;
	optimisticStatus: CanUpdateSequencePropSource | null;
	savedStatus: CanUpdateSequencePropSource | null;
	acknowledged: boolean;
};
type Field = {
	nodePath: SequencePropsSubscriptionKey;
	key: string;
	layers: Layer[];
	visible: DragOverrideValue | null;
	sourceStatus: CanUpdateSequencePropSource | null;
	ownedStatuses: Set<CanUpdateSequencePropSource>;
};
type Store = {
	fields: Map<string, Field>;
};
const stores = new WeakMap<Setters['updateDragOverrides'], Store>();
const fieldKey = (nodePath: SequencePropsSubscriptionKey, key: string) =>
	`${Internals.makeSequencePropsSubscriptionKey(nodePath)}\0${key}`;

const publishField = (
	update: Setters['updateDragOverrides'],
	field: Field,
	force: boolean,
) => {
	const previous = field.visible;
	const next = field.layers.at(-1)?.value ?? null;
	field.visible = next;
	if (previous === next) return;
	update(field.nodePath, (current) => {
		if (!force && current[field.key] !== previous) return current;
		const values = {...current};
		if (next === null) delete values[field.key];
		else values[field.key] = next;
		return values;
	});
};

const reconcileField = (
	store: Store,
	update: Setters['updateDragOverrides'],
	field: Field,
) => {
	const confirmed = field.layers.findLastIndex(
		(layer) =>
			layer.acknowledged && deepEqual(layer.savedStatus, field.sourceStatus),
	);
	if (confirmed !== -1) field.layers = field.layers.slice(confirmed + 1);
	publishField(update, field, false);
	if (
		field.layers.length === 0 &&
		store.fields.get(fieldKey(field.nodePath, field.key)) === field
	)
		store.fields.delete(fieldKey(field.nodePath, field.key));
};

// Source notifications may acknowledge an older queued edit. Preserve the latest
// pending field while remembering the actual source as cancellation's fallback.
export const reconcileCanvasDragPreviewStatuses = (
	update: Setters['updateDragOverrides'],
	nodePath: SequencePropsSubscriptionKey,
	response: CanUpdateSequencePropsResponse,
): CanUpdateSequencePropsResponse => {
	const store = stores.get(update);
	if (!store || !response.canUpdate) return response;
	let {props} = response;
	for (const [key, status] of Object.entries(response.props)) {
		const field = store.fields.get(fieldKey(nodePath, key));
		if (!field) continue;
		field.sourceStatus = status;
		reconcileField(store, update, field);
		const pending = field.layers.findLast(
			(layer) => layer.optimisticStatus !== null,
		)?.optimisticStatus;
		if (pending) {
			if (props === response.props) props = {...props};
			props[key] = pending;
		}
	}

	return props === response.props ? response : {...response, props};
};

export const createCanvasDragPreview = ({
	updateDragOverrides,
	setPropStatuses,
	getPropStatuses,
}: {
	updateDragOverrides: Setters['updateDragOverrides'];
	setPropStatuses: SetPropStatuses;
	getPropStatuses: (
		nodePath: SequencePropsSubscriptionKey,
	) => CanUpdateSequencePropsResponse | undefined;
}) => {
	let store = stores.get(updateDragOverrides);
	if (!store) {
		store = {fields: new Map()};
		stores.set(updateDragOverrides, store);
	}

	const owned = new Map<Field, Layer>();
	const originalNodes = new Map<string, {field: Field; layer: Layer}>();
	let ended = false;
	const getNodePath = (nodePath: SequencePropsSubscriptionKey) => {
		const original = originalNodes.get(
			Internals.makeSequencePropsSubscriptionKey(nodePath),
		);
		if (!original) return nodePath;
		return original.field.layers.includes(original.layer)
			? original.field.nodePath
			: null;
	};

	const remove = () => {
		if (ended) return;
		ended = true;
		for (const [field, layer] of owned) {
			if (!field.layers.includes(layer)) continue;
			field.layers = field.layers.filter((candidate) => candidate !== layer);
			const fallback =
				field.layers.findLast(
					(candidate) => candidate.optimisticStatus !== null,
				)?.optimisticStatus ?? field.sourceStatus;
			const ownedStatuses = new Set(field.ownedStatuses);
			setPropStatuses(field.nodePath, (previous) => {
				if (
					!previous?.canUpdate ||
					!ownedStatuses.has(previous.props[field.key])
				)
					return previous;
				const props = {...previous.props};
				if (fallback) props[field.key] = fallback;
				else delete props[field.key];
				return {...previous, props};
			});
			publishField(updateDragOverrides, field, false);
			if (
				field.layers.length === 0 &&
				store.fields.get(fieldKey(field.nodePath, field.key)) === field
			)
				store.fields.delete(fieldKey(field.nodePath, field.key));
		}
	};

	return {
		getNodePath,
		setDragOverrides: (
			nodePath: SequencePropsSubscriptionKey,
			key: string,
			value: DragOverrideValue,
		) => {
			if (ended) return;
			const originalNodeKey =
				Internals.makeSequencePropsSubscriptionKey(nodePath);
			const currentNodePath = getNodePath(nodePath);
			if (currentNodePath === null) return;
			nodePath = currentNodePath;
			const mapKey = fieldKey(nodePath, key);
			let field = store.fields.get(mapKey);
			if (!field) {
				const status = getPropStatuses(nodePath);
				field = {
					nodePath,
					key,
					layers: [],
					visible: null,
					sourceStatus: status?.canUpdate ? (status.props[key] ?? null) : null,
					ownedStatuses: new Set(),
				};
				store.fields.set(mapKey, field);
			}

			let layer = owned.get(field);
			if (!layer) {
				layer = {
					value,
					optimisticStatus: null,
					savedStatus: null,
					acknowledged: false,
				};
				owned.set(field, layer);
				if (!originalNodes.has(originalNodeKey))
					originalNodes.set(originalNodeKey, {field, layer});
				field.layers.push(layer);
			} else {
				if (
					layer.value.type === 'static' &&
					value.type === 'static' &&
					Object.is(layer.value.value, value.value)
				)
					return;
				layer.value = value;
			}

			publishField(updateDragOverrides, field, true);
		},
		setPropStatuses: ((nodePath, apply) => {
			if (ended) return;
			const key = Internals.makeSequencePropsSubscriptionKey(nodePath);
			const matching = [...owned].filter(
				([field, layer]) =>
					field.layers.includes(layer) &&
					Internals.makeSequencePropsSubscriptionKey(field.nodePath) === key,
			);
			if (matching.length === 0) return;
			setPropStatuses(nodePath, (previous) => {
				if (!matching.some(([field, layer]) => field.layers.includes(layer)))
					return previous;
				const next = apply(previous);
				if (next.canUpdate) {
					for (const [field, layer] of matching) {
						if (
							!field.layers.includes(layer) ||
							Internals.makeSequencePropsSubscriptionKey(field.nodePath) !==
								Internals.makeSequencePropsSubscriptionKey(nodePath)
						)
							continue;
						layer.optimisticStatus = next.props[field.key] ?? null;
						if (layer.optimisticStatus)
							field.ownedStatuses.add(layer.optimisticStatus);
					}
				}

				return next;
			});
		}) satisfies SetPropStatuses,
		cancel: remove,
		fail: remove,
		acknowledge: (response: SaveSequencePropsResponse | null) => {
			if (ended) return;
			if (!response?.canUpdate) {
				remove();
				return;
			}

			for (const [field, layer] of owned) {
				if (!field.layers.includes(layer)) continue;
				const result = response.results.find(
					(item) =>
						Internals.makeSequencePropsSubscriptionKey(item.nodePath) ===
						Internals.makeSequencePropsSubscriptionKey(field.nodePath),
				);
				layer.acknowledged = true;
				layer.savedStatus = result?.props[field.key] ?? layer.optimisticStatus;
				reconcileField(store, updateDragOverrides, field);
			}
		},
	};
};

export const remapCanvasDragPreviews = (
	setters: Pick<Setters, 'updateDragOverrides' | 'remapDragOverrideFields'>,
	mutations: readonly SequenceNodePathMutation[],
) => {
	const store = stores.get(setters.updateDragOverrides);
	if (!store || store.fields.size === 0) return;
	for (const mutation of mutations) {
		const byFile = new Map(
			mutation.files.map((file) => [
				file.absolutePath,
				new Map(
					file.remappings
						.filter((item) => item.oldNodePath !== null)
						.map((item) => [
							JSON.stringify(item.oldNodePath),
							item.newNodePath,
						]),
				),
			]),
		);
		const moves = [...store.fields.values()].flatMap((field) => {
			const nextPath = byFile
				.get(field.nodePath.absolutePath)
				?.get(JSON.stringify(field.nodePath.nodePath));
			if (nextPath === undefined) return [];
			return [
				{
					field,
					previousNodePath: field.nodePath,
					nodePath:
						nextPath === null ? null : {...field.nodePath, nodePath: nextPath},
				},
			];
		});
		setters.remapDragOverrideFields(
			moves.map((move) => ({
				previousNodePath: move.previousNodePath,
				nodePath: move.nodePath,
				fields: move.field.visible
					? {[move.field.key]: move.field.visible}
					: {},
			})),
		);
		for (const move of moves)
			store.fields.delete(fieldKey(move.previousNodePath, move.field.key));
		for (const move of moves) {
			if (move.nodePath === null) {
				move.field.layers = [];
				move.field.visible = null;
			} else {
				move.field.nodePath = move.nodePath;
				store.fields.set(fieldKey(move.nodePath, move.field.key), move.field);
			}
		}
	}
};
