export interface PmdAnchors { center: [number, number]; head: [number, number]; feet: [number, number]; leftHand?: [number, number]; rightHand?: [number, number]; bounds?: [number, number, number, number] | null }
export interface PmdAnimation { name: string; sourceName: string; copyOf?: string; sheet: string; offsets: string; shadow: string; frameWidth: number; frameHeight: number; durations: number[]; directionCount: number; rushFrame: number; hitFrame: number; returnFrame: number; anchors: PmdAnchors[][] }
export interface PmdSpecies { id: number; name: string; animations: Record<string, PmdAnimation>; fallback: Record<string, string | null>; displayHeight: number; shadowSize: number; [key: string]: unknown }
export const PMD_DIRECTIONS: readonly string[];
export const PMD_ACTIONS: readonly string[];
export const PMD_FALLBACKS: Readonly<Record<string, readonly string[]>>;
export function pmdDirectionIndex(u: number, v: number, previous?: number): number;
export function samplePmdDirection(samples: {tick: number;u: number;v: number}[], tick: number, holdTicks?: number): number;
export function pmdActionFor(f: {fainted?: number;hp?: number;hurt?: number;status?: string;cast?: {shape?: string} | null;phase?: string;speed?: number}): string;
export function resolvePmdAnimation(metadata: PmdSpecies | null | undefined, requested: string): PmdAnimation | null;
export function samplePmdFrame(animation: PmdAnimation, elapsedSeconds: number, direction: number, options?: {loop?: boolean}): {frame: number;row: number;sx: number;sy: number;sw: number;sh: number;anchors: PmdAnchors} | null;
