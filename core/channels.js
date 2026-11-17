/**
 * Channel definitions.
 *
 * A *channel* is any numeric property that can be keyframed or driven by audio.
 * Each channel has a stable dot-path id (`transform.position.x`,
 * `masks.<id>.feather`, `effects.<id>.amount`) plus a base value read from the
 * clip, and optional metadata the UI uses to build a sensible slider.
 *
 * Keeping every animatable value behind one flat namespace is what lets
 * keyframes, the graph editor and the audio mapping panel stay generic -- they
 * never need to know whether they are animating a transform, an effect or a
 * mask.
 */

/** @typedef {'position'|'scale'|'rotation'|'opacity'|'crop'|'mask'|'effect'|'source'|'audio'} ChannelGroup */

/**
 * @typedef {object} ChannelSpec
 * @property {string} id
 * @property {string} label
 * @property {ChannelGroup} group
 * @property {number} base
 * @property {number} min
 * @property {number} max
 * @property {number} [step]
 * @property {string} [unit]
 * @property {number} [decimals]
 * @property {boolean} [isBoolean]
 * @property {string} [effectId]
 * @property {string} [effectType]
 * @property {string} [maskId]
 */

export const CHANNEL_PREFIX = 'transform.';

/**
 * Transform channel ids, in the order the inspector shows them.
 * @type {readonly string[]}
 */
export const TRANSFORM_CHANNELS = Object.freeze([
  'transform.position.x',
  'transform.position.y',
  'transform.scale.x',
  'transform.scale.y',
  'transform.rotation',
  'transform.opacity',
  'transform.anchor.x',
  'transform.anchor.y',
  'transform.crop.top',
  'transform.crop.right',
  'transform.crop.bottom',
  'transform.crop.left',
]);

/**
 * Read a base transform value by channel id.
 * @param {import('./schema.js').Transform} transform
 * @param {string} channel
 * @returns {number}
 */
export function transformBase(transform, channel) {
  switch (channel) {
    case 'transform.position.x': return transform.x;
    case 'transform.position.y': return transform.y;
    case 'transform.scale.x': return transform.scaleX;
    case 'transform.scale.y': return transform.scaleY;
    case 'transform.rotation': return transform.rotation;
    case 'transform.opacity': return transform.opacity;
    case 'transform.anchor.x': return transform.anchorX;
    case 'transform.anchor.y': return transform.anchorY;
    case 'transform.crop.top': return transform.cropTop;
    case 'transform.crop.right': return transform.cropRight;
    case 'transform.crop.bottom': return transform.cropBottom;
    case 'transform.crop.left': return transform.cropLeft;
    default: return 0;
  }
}

/**
 * Write a base transform value by channel id.
 * @param {import('./schema.js').Transform} transform
 * @param {string} channel
 * @param {number} value
 * @returns {void}
 */
export function setTransformBase(transform, channel, value) {
  switch (channel) {
    case 'transform.position.x': transform.x = value; break;
    case 'transform.position.y': transform.y = value; break;
    case 'transform.scale.x': transform.scaleX = value; break;
    case 'transform.scale.y': transform.scaleY = value; break;
    case 'transform.rotation': transform.rotation = value; break;
    case 'transform.opacity': transform.opacity = value; break;
    case 'transform.anchor.x': transform.anchorX = value; break;
    case 'transform.anchor.y': transform.anchorY = value; break;
    case 'transform.crop.top': transform.cropTop = value; break;
    case 'transform.crop.right': transform.cropRight = value; break;
    case 'transform.crop.bottom': transform.cropBottom = value; break;
    case 'transform.crop.left': transform.cropLeft = value; break;
    default: break;
  }
}

/**
 * Display metadata for the transform channels, expressed relative to the
 * composition so the labels make sense at any output size.
 * @param {import('./schema.js').Composition} composition
 * @returns {ChannelSpec[]}
 */
export function transformChannelSpecs(composition) {
  const half = composition.width / 2;
  const halfY = composition.height / 2;
  /** @type {ChannelSpec[]} */
  const specs = [
    { id: 'transform.position.x', label: 'Position X', group: 'position', base: 0, min: -half, max: half, unit: 'px', decimals: 1 },
    { id: 'transform.position.y', label: 'Position Y', group: 'position', base: 0, min: -halfY, max: halfY, unit: 'px', decimals: 1 },
    { id: 'transform.scale.x', label: 'Scale X', group: 'scale', base: 1, min: 0, max: 6, step: 0.01, unit: '×', decimals: 3 },
    { id: 'transform.scale.y', label: 'Scale Y', group: 'scale', base: 1, min: 0, max: 6, step: 0.01, unit: '×', decimals: 3 },
    { id: 'transform.rotation', label: 'Rotation', group: 'rotation', base: 0, min: -1080, max: 1080, unit: '°', decimals: 1 },
    { id: 'transform.opacity', label: 'Opacity', group: 'opacity', base: 1, min: 0, max: 1, step: 0.01, decimals: 3 },
    { id: 'transform.anchor.x', label: 'Anchor X', group: 'position', base: 0.5, min: -1, max: 2, step: 0.01, decimals: 3 },
    { id: 'transform.anchor.y', label: 'Anchor Y', group: 'position', base: 0.5, min: -1, max: 2, step: 0.01, decimals: 3 },
    { id: 'transform.crop.top', label: 'Crop top', group: 'crop', base: 0, min: 0, max: 0.95, step: 0.005, decimals: 3 },
    { id: 'transform.crop.right', label: 'Crop right', group: 'crop', base: 0, min: 0, max: 0.95, step: 0.005, decimals: 3 },
    { id: 'transform.crop.bottom', label: 'Crop bottom', group: 'crop', base: 0, min: 0, max: 0.95, step: 0.005, decimals: 3 },
    { id: 'transform.crop.left', label: 'Crop left', group: 'crop', base: 0, min: 0, max: 0.95, step: 0.005, decimals: 3 },
  ];
  return specs.map((spec) => ({ ...spec, unit: spec.unit ?? '' }));
}

/**
 * Mask channel ids for one mask.
 * @param {import('./schema.js').Mask} mask
 * @returns {ChannelSpec[]}
 */
export function maskChannelSpecs(mask) {
  const prefix = `masks.${mask.id}`;
  /** @type {ChannelSpec[]} */
  const specs = [
    { id: `${prefix}.position.x`, label: 'Mask X', group: 'mask', base: mask.position.x, min: -2, max: 3, step: 0.005, decimals: 3, maskId: mask.id },
    { id: `${prefix}.position.y`, label: 'Mask Y', group: 'mask', base: mask.position.y, min: -2, max: 3, step: 0.005, decimals: 3, maskId: mask.id },
    { id: `${prefix}.size.x`, label: 'Mask width', group: 'mask', base: mask.size.x, min: 0, max: 4, step: 0.005, decimals: 3, maskId: mask.id },
    { id: `${prefix}.size.y`, label: 'Mask height', group: 'mask', base: mask.size.y, min: 0, max: 4, step: 0.005, decimals: 3, maskId: mask.id },
    { id: `${prefix}.rotation`, label: 'Mask rotation', group: 'mask', base: mask.rotation, min: -360, max: 360, step: 0.5, unit: '°', decimals: 1, maskId: mask.id },
    { id: `${prefix}.feather`, label: 'Feather', group: 'mask', base: mask.feather, min: 0, max: 1, step: 0.005, decimals: 3, maskId: mask.id },
    { id: `${prefix}.opacity`, label: 'Mask opacity', group: 'mask', base: mask.opacity, min: 0, max: 1, step: 0.01, decimals: 3, maskId: mask.id },
  ];
  return specs;
}

/**
 * Every channel a clip exposes, in inspector order. Effect specs are supplied
 * by the caller (the effect registry lives in `core/effects.js`) so this module
 * stays free of effect knowledge.
 *
 * @param {import('./schema.js').Clip} clip
 * @param {import('./schema.js').Composition} composition
 * @param {import('./effectRegistry.js').EffectRegistry} registry
 * @returns {ChannelSpec[]}
 */
export function clipChannelSpecs(clip, composition, registry) {
  /** @type {ChannelSpec[]} */
  const specs = transformChannelSpecs(composition).map((spec) => ({
    ...spec,
    base: transformBase(clip.transform, spec.id),
  }));

  for (const mask of clip.masks) specs.push(...maskChannelSpecs(mask));

  for (const instance of clip.effects.stack) {
    const definition = registry[instance.type];
    if (!definition) continue;
    for (const param of definition.params) {
      if (param.kind !== 'number') continue;
      const id = `effects.${instance.id}.${param.key}`;
      specs.push({
        id,
        label: `${definition.label} · ${param.label}`,
        group: 'effect',
        base: /** @type {number} */ (param.default),
        min: param.min ?? 0,
        max: param.max ?? 1,
        step: param.step ?? 0.01,
        unit: param.unit ?? '',
        decimals: param.decimals ?? 3,
        effectId: instance.id,
        effectType: instance.type,
      });
    }
  }
  return specs;
}

/**
 * @param {ChannelSpec[]} specs
 * @param {string} id
 * @returns {ChannelSpec|undefined}
 */
export function findChannelSpec(specs, id) {
  return specs.find((spec) => spec.id === id);
}

/**
 * Channels that make sense as audio-mapping targets: everything numeric that a
 * user can reasonably drive from a signal. Position/scale/rotation/opacity,
 * mask geometry, plus numeric effect parameters.
 * @param {ChannelSpec[]} specs
 * @returns {ChannelSpec[]}
 */
export function audioTargetableChannels(specs) {
  return specs.filter((spec) => !spec.isBoolean && spec.group !== 'source');
}

/**
 * Group label used by the inspector.
 * @param {ChannelGroup} group
 * @returns {string}
 */
export function groupLabel(group) {
  switch (group) {
    case 'position': return 'Position';
    case 'scale': return 'Scale';
    case 'rotation': return 'Rotation';
    case 'opacity': return 'Opacity';
    case 'crop': return 'Crop';
    case 'mask': return 'Masks';
    case 'effect': return 'Effects';
    case 'source': return 'Source';
    case 'audio': return 'Audio';
    default: return 'Other';
  }
}
