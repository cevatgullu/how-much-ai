export interface RulerMarkerInput {
  accountId: string;
  sourceIndex: number;
  usedPercent: number;
  labelWidth: number;
}

export interface RulerMarkerPlacement extends RulerMarkerInput {
  centerX: number;
  left: number;
  lane: 0 | 1 | 2;
}

export interface RulerCluster {
  id: string;
  centerX: number;
  members: readonly RulerMarkerInput[];
}

interface PreparedMarker {
  marker: RulerMarkerInput;
  centerX: number;
  left: number;
  right: number;
  labelWidth: number;
}

const LANES = [0, 1, 2] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function markerOrder(a: RulerMarkerInput, b: RulerMarkerInput): number {
  return clamp(a.usedPercent, 0, 100) - clamp(b.usedPercent, 0, 100)
    || a.sourceIndex - b.sourceIndex
    || a.accountId.localeCompare(b.accountId);
}

function prepareMarker(marker: RulerMarkerInput, rulerWidth: number): PreparedMarker {
  const labelWidth = clamp(marker.labelWidth, 0, rulerWidth);
  const centerX = rulerWidth * clamp(marker.usedPercent, 0, 100) / 100;
  const left = clamp(centerX - labelWidth / 2, 0, rulerWidth - labelWidth);
  return { marker, centerX, left, right: left + labelWidth, labelWidth };
}

function canUseLane(
  candidate: PreparedMarker,
  placements: readonly RulerMarkerPlacement[],
  minimumGap: number,
): boolean {
  return placements.every((placement) => {
    const right = placement.left + placement.labelWidth;
    return candidate.left >= right + minimumGap || candidate.right + minimumGap <= placement.left;
  });
}

export function stableRulerClusterId(members: readonly RulerMarkerInput[]): string {
  const canonical = [...members]
    .sort((a, b) => a.sourceIndex - b.sourceIndex || a.accountId.localeCompare(b.accountId))
    .map((member) => `${member.sourceIndex}:${member.accountId.length}:${member.accountId}`)
    .join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ruler-cluster-${(hash >>> 0).toString(36)}`;
}

export function placeQuotaRulerMarkers(
  markers: readonly RulerMarkerInput[],
  rulerWidth: number,
  minimumGap = 8,
): { placements: RulerMarkerPlacement[]; clusters: RulerCluster[] } {
  const width = Math.max(0, rulerWidth);
  const gap = Math.max(0, minimumGap);
  const prepared = [...markers].sort(markerOrder).map((marker) => prepareMarker(marker, width));
  const placements: RulerMarkerPlacement[] = [];
  const lanePlacements: [RulerMarkerPlacement[], RulerMarkerPlacement[], RulerMarkerPlacement[]] = [[], [], []];
  const overflow: PreparedMarker[] = [];

  for (const candidate of prepared) {
    const lane = LANES.find((laneIndex) => canUseLane(candidate, lanePlacements[laneIndex], gap));
    if (lane === undefined) {
      overflow.push(candidate);
      continue;
    }
    const placement: RulerMarkerPlacement = {
      ...candidate.marker,
      labelWidth: candidate.labelWidth,
      centerX: candidate.centerX,
      left: candidate.left,
      lane,
    };
    placements.push(placement);
    lanePlacements[lane].push(placement);
  }

  const clusterGroups: PreparedMarker[][] = [];
  let clusterRight = Number.NEGATIVE_INFINITY;
  for (const candidate of overflow) {
    if (clusterGroups.length === 0 || candidate.left > clusterRight + gap) {
      clusterGroups.push([candidate]);
      clusterRight = candidate.right;
      continue;
    }
    clusterGroups[clusterGroups.length - 1]?.push(candidate);
    clusterRight = Math.max(clusterRight, candidate.right);
  }

  const clusters = clusterGroups.map((group) => {
    const members = group.map(({ marker, labelWidth }) => ({ ...marker, labelWidth }));
    return {
      id: stableRulerClusterId(members),
      centerX: group.reduce((sum, candidate) => sum + candidate.centerX, 0) / group.length,
      members,
    };
  });

  return { placements, clusters };
}
