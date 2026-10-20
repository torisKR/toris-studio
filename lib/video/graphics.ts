import type { VideoProject, VideoScene } from "./types";
export type ElementKind = 'text' | 'rectangle' | 'circle' | 'line' | 'image' | 'bar' | 'chart-line' | 'donut';
export type Animation = 'none' | 'fade' | 'rise' | 'slide' | 'zoom' | 'draw' | 'fade-out';
export type GraphicElement = {
    id: string;
    kind: ElementKind;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    color: string;
    start: number;
    duration: number;
    animation: Animation;
    text?: string;
    fontSize?: number;
    assetId?: string;
    tableId?: string;
};
export type Graphics = {
    version: 1;
    background: string;
    elements: GraphicElement[];
};
export type TableRow = {
    label: string;
    value: number;
};
export type MotionTable = {
    id: string;
    name: string;
    rows: TableRow[];
};
export type MotionImage = {
    id: string;
    width: number;
    height: number;
    description: string;
};
export type MotionScene = VideoScene & {
    graphics: Graphics;
};
export type MotionSources = {
    version: 1;
    description: string;
    tables: MotionTable[];
    images: MotionImage[];
};
export type MotionProject = Omit<VideoProject, 'scenes' | 'motionGraphics'> & {
    motionGraphics: MotionSources;
    scenes: MotionScene[];
};
